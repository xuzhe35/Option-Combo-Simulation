"""Official Treasury feed helpers and legacy SQLite compatibility provider.

Current application discounting is owned by the standalone :mod:`yield_curve`
package and its JSON snapshots. That package reuses this module's official XML
fetch/parser and compounding helper. ``TreasuryYieldCurveProvider`` remains for
legacy ``rates.db`` backfill and historical migration only; neither websocket
backend imports or refreshes it.

Important pricing semantics
---------------------------
The published CMT observations are *par yields* quoted on a bond-equivalent,
semiannual basis.  Treasury explicitly does not publish a daily zero-coupon
curve.  ``get_discount_quote`` therefore exposes a deliberately labelled
``par_yield_as_zero_proxy`` approximation: quoted par yields are converted to
an equivalent continuously compounded annual rate and interpolated as proxy
zero rates.  This is suitable as a transparent fallback/baseline for the
short-dated option workspace; it must not be represented as an official
Treasury zero curve.

Only the Python standard library is used so both websocket backends and the
standalone refresh CLI can share the provider without another dependency.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import sqlite3
import ssl
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from contextlib import closing
from dataclasses import dataclass
from datetime import date, datetime, time as datetime_time, timedelta, timezone
from pathlib import Path
from typing import Callable, Dict, List, Mapping, Optional, Tuple, Union
try:
    from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
except ImportError:  # pragma: no cover - Python 3.8 compatibility fallback.
    ZoneInfo = None
    ZoneInfoNotFoundError = Exception


TREASURY_CURVE_SOURCE = "treasury:daily_treasury_yield_curve"
TREASURY_XML_URL_TEMPLATE = (
    "https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml"
    "?data=daily_treasury_yield_curve&field_tdr_date_value={year}"
)
TREASURY_METHODOLOGY_URL = (
    "https://home.treasury.gov/policy-issues/financing-the-government/"
    "interest-rate-statistics/treasury-yield-curve-methodology"
)
TREASURY_FAQ_URL = (
    "https://home.treasury.gov/policy-issues/financing-the-government/"
    "interest-rate-statistics/interest-rates-frequently-asked-questions"
)
DEFAULT_PROXY_TENOR = "3m"
DEFAULT_INCREMENTAL_OVERLAP_DAYS = 31
DEFAULT_PUBLICATION_HOUR_ET = 18
SCHEMA_VERSION = 1
try:
    _NEW_YORK = ZoneInfo("America/New_York") if ZoneInfo else None
except ZoneInfoNotFoundError:  # Windows may not have an IANA tzdata package.
    _NEW_YORK = None


@dataclass(frozen=True)
class TenorSpec:
    code: str
    xml_field: str
    days: int
    aliases: Tuple[str, ...] = ()


# Fixed day counts preserve the legacy rates.db contract.  They are maturity
# labels, not a day-count convention for pricing.  In particular, 1.5 months
# is represented by round(1.5 * 365 / 12) = 46 days.
TENOR_SPECS: Tuple[TenorSpec, ...] = (
    TenorSpec("1m", "BC_1MONTH", 30, ("1mo", "1month")),
    TenorSpec("1.5m", "BC_1_5MONTH", 46, ("1.5mo", "1.5month", "6w", "6wk", "6week")),
    TenorSpec("2m", "BC_2MONTH", 61, ("2mo", "2month")),
    TenorSpec("3m", "BC_3MONTH", 91, ("3mo", "3month")),
    TenorSpec("4m", "BC_4MONTH", 122, ("4mo", "4month")),
    TenorSpec("6m", "BC_6MONTH", 182, ("6mo", "6month")),
    TenorSpec("1y", "BC_1YEAR", 365, ("1yr", "1year")),
    TenorSpec("2y", "BC_2YEAR", 730, ("2yr", "2year")),
    TenorSpec("3y", "BC_3YEAR", 1095, ("3yr", "3year")),
    TenorSpec("5y", "BC_5YEAR", 1825, ("5yr", "5year")),
    TenorSpec("7y", "BC_7YEAR", 2555, ("7yr", "7year")),
    TenorSpec("10y", "BC_10YEAR", 3650, ("10yr", "10year")),
    TenorSpec("20y", "BC_20YEAR", 7300, ("20yr", "20year")),
    TenorSpec("30y", "BC_30YEAR", 10950, ("30yr", "30year")),
)

_TENOR_BY_CODE: Dict[str, TenorSpec] = {spec.code: spec for spec in TENOR_SPECS}
_TENOR_ALIASES: Dict[str, str] = {}
for _spec in TENOR_SPECS:
    for _alias in (_spec.code,) + _spec.aliases:
        _TENOR_ALIASES[_alias] = _spec.code


CURVE_SEMANTICS: Mapping[str, object] = {
    "curveType": "us_treasury_nominal_par_yield_curve",
    "officialCurve": True,
    "officialZeroCouponCurve": False,
    "inputQuoteConvention": "bond_equivalent_yield_semiannual",
    "inputRateUnit": "decimal_per_year",
    "discountingMethod": "par_yield_as_zero_proxy",
    "discountRateSemantics": "continuous_zero_proxy_from_cmt_par_yield",
    "discountingIsApproximate": True,
    "continuousConversion": "2*ln(1+par_yield/2)",
    "interpolation": "linear_continuous_rate_by_tenor_days",
    "extrapolation": "flat_nearest_continuous_rate",
    "defaultDayCount": "ACT/365F",
    "methodologyUrl": TREASURY_METHODOLOGY_URL,
    "faqUrl": TREASURY_FAQ_URL,
}


SCHEMA_STATEMENTS: Tuple[str, ...] = (
    """
    CREATE TABLE IF NOT EXISTS dates (
        date_id INTEGER PRIMARY KEY,
        date TEXT UNIQUE NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS risk_free_daily_rates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date_ref INTEGER NOT NULL,
        rate REAL NOT NULL,
        source TEXT NOT NULL,
        FOREIGN KEY (date_ref) REFERENCES dates(date_id)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS yield_curve_daily_rates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date_ref INTEGER NOT NULL,
        tenor_code TEXT NOT NULL,
        tenor_days INTEGER NOT NULL,
        rate REAL NOT NULL,
        source TEXT NOT NULL,
        FOREIGN KEY (date_ref) REFERENCES dates(date_id)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS treasury_curve_sync_metadata (
        source TEXT PRIMARY KEY,
        fetched_at_utc TEXT NOT NULL,
        requested_start_date TEXT NOT NULL,
        requested_end_date TEXT NOT NULL,
        latest_effective_date TEXT NOT NULL,
        proxy_tenor TEXT NOT NULL,
        feed_years_json TEXT NOT NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS treasury_curve_refresh_attempts (
        source TEXT PRIMARY KEY,
        eastern_date TEXT NOT NULL,
        attempted_at_utc TEXT NOT NULL,
        status TEXT NOT NULL,
        error TEXT NOT NULL DEFAULT ''
    )
    """,
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_risk_free_daily_date ON risk_free_daily_rates(date_ref)",
    """
    CREATE UNIQUE INDEX IF NOT EXISTS idx_yield_curve_daily_date_tenor_source
    ON yield_curve_daily_rates(date_ref, tenor_code, source)
    """,
    "CREATE INDEX IF NOT EXISTS idx_yield_curve_daily_date_ref ON yield_curve_daily_rates(date_ref)",
    "CREATE INDEX IF NOT EXISTS idx_yield_curve_daily_tenor_code ON yield_curve_daily_rates(tenor_code)",
)


class TreasuryYieldCurveError(RuntimeError):
    """The official feed, cache, or curve conversion could not be used."""


DateLike = Union[str, date, datetime]
FetchYear = Callable[[int], bytes]


def _local_name(tag: str) -> str:
    return str(tag or "").rsplit("}", 1)[-1]


def normalize_date(value: DateLike) -> date:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    text = str(value or "").strip().replace("/", "-")
    for fmt in ("%Y-%m-%d", "%Y%m%d"):
        try:
            return datetime.strptime(text, fmt).date()
        except ValueError:
            continue
    raise ValueError("date must be YYYY-MM-DD or YYYYMMDD")


def normalize_tenor(value: object) -> str:
    normalized = "".join(str(value or "").strip().lower().split())
    code = _TENOR_ALIASES.get(normalized)
    if not code:
        supported = ", ".join(spec.code for spec in TENOR_SPECS)
        raise ValueError("Unsupported Treasury tenor {!r}; supported: {}".format(value, supported))
    return code


def tenor_days(value: object) -> int:
    return _TENOR_BY_CODE[normalize_tenor(value)].days


def treasury_xml_url(year: int) -> str:
    normalized_year = int(year)
    if normalized_year < 1990 or normalized_year > 9999:
        raise ValueError("Treasury nominal par-yield history begins in 1990")
    return TREASURY_XML_URL_TEMPLATE.format(year=normalized_year)


def _verified_ssl_context() -> ssl.SSLContext:
    """Build a verified TLS context, including macOS Framework Python.

    python.org Framework builds can have an empty private CA bundle even when
    the operating system bundle is present.  Loading that system bundle is a
    secure fallback; certificate verification is never disabled.
    """
    context = ssl.create_default_context()
    if context.cert_store_stats().get("x509_ca", 0):
        return context
    candidates = []
    configured = os.environ.get("SSL_CERT_FILE", "").strip()
    if configured:
        candidates.append(configured)
    candidates.extend(("/etc/ssl/cert.pem", "/private/etc/ssl/cert.pem"))
    for candidate in candidates:
        if candidate and os.path.isfile(candidate):
            context.load_verify_locations(cafile=candidate)
            if context.cert_store_stats().get("x509_ca", 0):
                return context
    return context


def fetch_treasury_year(year: int, timeout: float = 60.0) -> bytes:
    """Fetch one calendar year from the official Treasury XML endpoint."""
    url = treasury_xml_url(year)
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": "OptionComboSimulation/2.0 (+https://home.treasury.gov/)",
            "Accept": "application/xml,text/xml;q=0.9,*/*;q=0.8",
        },
    )
    try:
        with urllib.request.urlopen(
            request,
            timeout=float(timeout),
            context=_verified_ssl_context(),
        ) as response:
            payload = response.read()
    except urllib.error.HTTPError as exc:
        raise TreasuryYieldCurveError(
            "Treasury feed request failed for {}: HTTP {}".format(year, exc.code)
        ) from exc
    except (urllib.error.URLError, OSError, TimeoutError) as exc:
        reason = getattr(exc, "reason", exc)
        raise TreasuryYieldCurveError(
            "Treasury feed request failed for {}: {}".format(year, reason)
        ) from exc
    if not payload:
        raise TreasuryYieldCurveError("Treasury feed returned an empty document for {}".format(year))
    return payload


def _coerce_rate_decimal(value: object) -> Optional[float]:
    text = str(value or "").strip()
    if not text:
        return None
    try:
        percentage = float(text)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(percentage):
        return None
    return percentage / 100.0


def parse_treasury_xml(xml_bytes: bytes) -> List[Dict[str, object]]:
    """Parse an official Atom XML response into sorted daily observations.

    Unknown fields are ignored and omitted/null tenor fields remain absent.
    The returned rates are decimals, not percentages.
    """
    try:
        root = ET.fromstring(xml_bytes)
    except (ET.ParseError, TypeError, ValueError) as exc:
        raise TreasuryYieldCurveError("Treasury feed returned invalid XML") from exc

    observations: Dict[str, Dict[str, Dict[str, object]]] = {}
    for entry in (node for node in root.iter() if _local_name(node.tag) == "entry"):
        properties = next(
            (node for node in entry.iter() if _local_name(node.tag) == "properties"),
            None,
        )
        if properties is None:
            continue
        values = {_local_name(child.tag): child.text for child in list(properties)}
        raw_date = str(values.get("NEW_DATE") or "").strip().split("T", 1)[0]
        try:
            iso_date = normalize_date(raw_date).isoformat()
        except ValueError:
            continue

        by_tenor = observations.setdefault(iso_date, {})
        for spec in TENOR_SPECS:
            rate = _coerce_rate_decimal(values.get(spec.xml_field))
            if rate is None:
                continue
            by_tenor[spec.code] = {
                "tenorCode": spec.code,
                "tenorDays": spec.days,
                "parYield": rate,
                "rate": rate,
                "officialField": spec.xml_field,
            }

    parsed: List[Dict[str, object]] = []
    for iso_date in sorted(observations):
        points = sorted(observations[iso_date].values(), key=lambda point: int(point["tenorDays"]))
        if points:
            parsed.append({"date": iso_date, "points": points})
    return parsed


def download_treasury_observations(
    start_date: DateLike,
    end_date: DateLike,
    fetch_year: Optional[FetchYear] = None,
) -> List[Dict[str, object]]:
    start = normalize_date(start_date)
    end = normalize_date(end_date)
    if start > end:
        raise ValueError("start_date cannot be later than end_date")
    fetch = fetch_year or fetch_treasury_year
    observations: List[Dict[str, object]] = []
    for year in range(start.year, end.year + 1):
        observations.extend(parse_treasury_xml(fetch(year)))
    start_iso = start.isoformat()
    end_iso = end.isoformat()
    return [row for row in observations if start_iso <= str(row["date"]) <= end_iso]


def par_yield_to_continuous_proxy(par_yield: float) -> float:
    """Convert a semiannual bond-equivalent yield to an equivalent CC rate.

    This conversion changes compounding convention only.  It does *not*
    transform the Treasury par curve into a bootstrapped zero-coupon curve.
    """
    value = float(par_yield)
    if not math.isfinite(value) or 1.0 + value / 2.0 <= 0:
        raise ValueError("par_yield is outside the convertible range")
    return 2.0 * math.log1p(value / 2.0)


def _utc_iso(now: Optional[datetime] = None) -> str:
    value = now or datetime.now(timezone.utc)
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _first_weekday(year: int, month: int, weekday: int) -> date:
    first = date(year, month, 1)
    return first + timedelta(days=(weekday - first.weekday()) % 7)


def _last_weekday(year: int, month: int, weekday: int) -> date:
    if month == 12:
        next_month = date(year + 1, 1, 1)
    else:
        next_month = date(year, month + 1, 1)
    last = next_month - timedelta(days=1)
    return last - timedelta(days=(last.weekday() - weekday) % 7)


def _eastern_dst_dates(year: int) -> Tuple[date, date]:
    # U.S. rules covering the Treasury feed's 1990+ nominal history.
    if year >= 2007:
        start = _first_weekday(year, 3, 6) + timedelta(days=7)  # second Sunday
        end = _first_weekday(year, 11, 6)  # first Sunday
    else:
        start = _first_weekday(year, 4, 6)  # first Sunday
        end = _last_weekday(year, 10, 6)  # last Sunday
    return start, end


def _eastern_offset_for_local_day(local_day: date) -> timezone:
    start, end = _eastern_dst_dates(local_day.year)
    return timezone(timedelta(hours=-4 if start <= local_day < end else -5))


def _as_eastern(instant: datetime) -> datetime:
    if instant.tzinfo is None:
        instant = instant.replace(tzinfo=timezone.utc)
    if _NEW_YORK is not None:
        return instant.astimezone(_NEW_YORK)
    utc = instant.astimezone(timezone.utc)
    start_day, end_day = _eastern_dst_dates(utc.year)
    start_utc = datetime.combine(start_day, datetime_time(hour=7), tzinfo=timezone.utc)
    end_utc = datetime.combine(end_day, datetime_time(hour=6), tzinfo=timezone.utc)
    offset = timezone(timedelta(hours=-4 if start_utc <= utc < end_utc else -5))
    return utc.astimezone(offset)


def _quote_as_of_approximate(effective_date: str) -> str:
    # Treasury documents that indicative bid-side inputs are obtained at or
    # near 15:30 ET; the XML itself contains only a date, not a timestamp.
    local_day = normalize_date(effective_date)
    tzinfo = _NEW_YORK or _eastern_offset_for_local_day(local_day)
    local = datetime.combine(local_day, datetime_time(hour=15, minute=30), tzinfo=tzinfo)
    return _utc_iso(local)


def _snapshot_id(effective_date: str, points: List[Dict[str, object]]) -> str:
    canonical = json.dumps(
        {"effectiveDate": effective_date, "points": points},
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return "treasury:{}:{}".format(effective_date, hashlib.sha256(canonical).hexdigest()[:16])


class TreasuryYieldCurveProvider:
    """Official-feed synchronizer plus atomic SQLite curve cache."""

    def __init__(
        self,
        db_path: Union[str, os.PathLike],
        timeout: float = 60.0,
        fetch_year: Optional[FetchYear] = None,
        now: Optional[Callable[[], datetime]] = None,
    ) -> None:
        self.db_path = os.path.abspath(os.fspath(db_path))
        self.timeout = float(timeout)
        self._fetch_year = fetch_year
        self._now = now or (lambda: datetime.now(timezone.utc))

    def _default_fetch_year(self, year: int) -> bytes:
        return fetch_treasury_year(year, timeout=self.timeout)

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, timeout=max(1.0, self.timeout))
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("PRAGMA busy_timeout = 5000")
        return conn

    @staticmethod
    def _ensure_schema(conn: sqlite3.Connection) -> None:
        for statement in SCHEMA_STATEMENTS:
            conn.execute(statement)

    @staticmethod
    def _date_id(conn: sqlite3.Connection, iso_date: str) -> int:
        conn.execute("INSERT INTO dates(date) VALUES (?) ON CONFLICT(date) DO NOTHING", (iso_date,))
        row = conn.execute("SELECT date_id FROM dates WHERE date = ?", (iso_date,)).fetchone()
        if not row:
            raise TreasuryYieldCurveError("Could not resolve rates date {}".format(iso_date))
        return int(row[0])

    def _fetch(self, year: int) -> bytes:
        fetch = self._fetch_year or self._default_fetch_year
        return fetch(year)

    def refresh(
        self,
        start_date: DateLike,
        end_date: DateLike,
        proxy_tenor: object = DEFAULT_PROXY_TENOR,
    ) -> Dict[str, object]:
        """Download then atomically merge an inclusive date range.

        All HTTP and XML work completes before ``BEGIN IMMEDIATE``.  Readers
        therefore observe either the previous cache or the complete new batch,
        never a partial refresh.
        """
        start = normalize_date(start_date)
        end = normalize_date(end_date)
        if start > end:
            raise ValueError("start_date cannot be later than end_date")
        proxy_code = normalize_tenor(proxy_tenor)
        observations = download_treasury_observations(start, end, self._fetch)
        if not observations:
            raise TreasuryYieldCurveError(
                "Treasury feed returned no par-yield observations in {} through {}".format(start, end)
            )

        Path(self.db_path).parent.mkdir(parents=True, exist_ok=True)
        conn = self._connect()
        curve_rows = 0
        proxy_rows = 0
        try:
            conn.execute("BEGIN IMMEDIATE")
            self._ensure_schema(conn)
            for observation in observations:
                iso_date = str(observation["date"])
                date_id = self._date_id(conn, iso_date)
                proxy_rate = None
                for point in observation.get("points", []):
                    conn.execute(
                        """
                        INSERT INTO yield_curve_daily_rates
                            (date_ref, tenor_code, tenor_days, rate, source)
                        VALUES (?, ?, ?, ?, ?)
                        ON CONFLICT(date_ref, tenor_code, source) DO UPDATE SET
                            tenor_days = excluded.tenor_days,
                            rate = excluded.rate
                        """,
                        (
                            date_id,
                            str(point["tenorCode"]),
                            int(point["tenorDays"]),
                            float(point["rate"]),
                            TREASURY_CURVE_SOURCE,
                        ),
                    )
                    curve_rows += 1
                    if str(point["tenorCode"]) == proxy_code:
                        proxy_rate = float(point["rate"])
                if proxy_rate is not None:
                    conn.execute(
                        """
                        INSERT INTO risk_free_daily_rates (date_ref, rate, source)
                        VALUES (?, ?, ?)
                        ON CONFLICT(date_ref) DO UPDATE SET
                            rate = excluded.rate,
                            source = excluded.source
                        """,
                        (date_id, proxy_rate, "{}:{}".format(TREASURY_CURVE_SOURCE, proxy_code)),
                    )
                    proxy_rows += 1

            latest = max(str(row["date"]) for row in observations)
            years = list(range(start.year, end.year + 1))
            conn.execute(
                """
                INSERT INTO treasury_curve_sync_metadata
                    (source, fetched_at_utc, requested_start_date, requested_end_date,
                     latest_effective_date, proxy_tenor, feed_years_json)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(source) DO UPDATE SET
                    fetched_at_utc = excluded.fetched_at_utc,
                    requested_start_date = excluded.requested_start_date,
                    requested_end_date = excluded.requested_end_date,
                    latest_effective_date = excluded.latest_effective_date,
                    proxy_tenor = excluded.proxy_tenor,
                    feed_years_json = excluded.feed_years_json
                """,
                (
                    TREASURY_CURVE_SOURCE,
                    _utc_iso(self._now()),
                    start.isoformat(),
                    end.isoformat(),
                    latest,
                    proxy_code,
                    json.dumps(years, separators=(",", ":")),
                ),
            )
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

        return {
            "status": "refreshed",
            "source": TREASURY_CURVE_SOURCE,
            "requestedStartDate": start.isoformat(),
            "requestedEndDate": end.isoformat(),
            "latestEffectiveDate": max(str(row["date"]) for row in observations),
            "observationCount": len(observations),
            "curvePointUpsertCount": curve_rows,
            "proxyUpsertCount": proxy_rows,
            "proxyTenor": proxy_code,
            "feedYears": list(range(start.year, end.year + 1)),
            "cacheIsAtomic": True,
        }

    def curve_date_bounds(self) -> Optional[Tuple[date, date]]:
        if not os.path.exists(self.db_path):
            return None
        try:
            with closing(self._connect()) as conn:
                row = conn.execute(
                    """
                    SELECT MIN(d.date), MAX(d.date)
                    FROM yield_curve_daily_rates yc
                    JOIN dates d ON d.date_id = yc.date_ref
                    WHERE yc.source = ?
                    """,
                    (TREASURY_CURVE_SOURCE,),
                ).fetchone()
        except sqlite3.OperationalError:
            return None
        if not row or not row[0] or not row[1]:
            return None
        return normalize_date(str(row[0])), normalize_date(str(row[1]))

    def refresh_latest(
        self,
        as_of: Optional[DateLike] = None,
        proxy_tenor: object = DEFAULT_PROXY_TENOR,
        overlap_days: int = DEFAULT_INCREMENTAL_OVERLAP_DAYS,
    ) -> Dict[str, object]:
        end = normalize_date(as_of) if as_of is not None else self._now().date()
        bounds = self.curve_date_bounds()
        if bounds:
            start = max(bounds[0], bounds[1] - timedelta(days=max(0, int(overlap_days))))
        else:
            start = date(end.year, 1, 1)
        return self.refresh(start, end, proxy_tenor=proxy_tenor)

    def _refresh_attempt(self) -> Optional[Dict[str, str]]:
        if not os.path.exists(self.db_path):
            return None
        conn = self._connect()
        try:
            conn.execute("BEGIN")
            self._ensure_schema(conn)
            row = conn.execute(
                """
                SELECT eastern_date, attempted_at_utc, status, error
                FROM treasury_curve_refresh_attempts
                WHERE source = ?
                """,
                (TREASURY_CURVE_SOURCE,),
            ).fetchone()
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()
        if not row:
            return None
        return {
            "easternDate": str(row["eastern_date"]),
            "attemptedAtUtc": str(row["attempted_at_utc"]),
            "status": str(row["status"]),
            "error": str(row["error"] or ""),
        }

    def should_refresh(
        self,
        now: Optional[datetime] = None,
        publication_hour_et: int = DEFAULT_PUBLICATION_HOUR_ET,
    ) -> bool:
        """Return whether this process/database should attempt today's feed.

        Treasury says rates are usually available by 18:00 Eastern on trading
        days.  Before that time an existing cache remains authoritative.  An
        empty cache may bootstrap earlier, once, so a fresh install can work.
        """
        instant = now or self._now()
        if instant.tzinfo is None:
            instant = instant.replace(tzinfo=timezone.utc)
        eastern = _as_eastern(instant)
        attempt = self._refresh_attempt()
        if attempt and attempt["easternDate"] == eastern.date().isoformat():
            # A fresh install (or a very stale workstation) may bootstrap
            # before today's curve is published.  That pre-publication fetch
            # must not suppress the one post-publication check that can pick
            # up today's observation.  Once a post-publication attempt has
            # happened, all further callers on the same Eastern date stop.
            attempted_at = str(attempt.get("attemptedAtUtc") or "").strip()
            try:
                attempted_instant = datetime.fromisoformat(
                    attempted_at.replace("Z", "+00:00")
                )
                attempted_eastern = _as_eastern(attempted_instant)
            except (TypeError, ValueError):
                attempted_eastern = eastern
            already_checked_post_publication = (
                attempted_eastern.date() == eastern.date()
                and attempted_eastern.hour >= int(publication_hour_et)
            )
            if eastern.hour < int(publication_hour_et) or already_checked_post_publication:
                return False
        bounds = self.curve_date_bounds()
        if bounds is None:
            return True
        # A workstation may have been off for months. Do not keep serving a
        # visibly stale cache until 18:00 merely because some old data exists.
        if (eastern.date() - bounds[1]).days > 7:
            return True
        return eastern.hour >= int(publication_hour_et)

    def _claim_refresh(
        self,
        eastern_date: str,
        attempted_at_utc: str,
        force: bool,
        publication_hour_et: int = DEFAULT_PUBLICATION_HOUR_ET,
    ) -> bool:
        Path(self.db_path).parent.mkdir(parents=True, exist_ok=True)
        conn = self._connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            self._ensure_schema(conn)
            row = conn.execute(
                """
                SELECT eastern_date, attempted_at_utc
                FROM treasury_curve_refresh_attempts WHERE source = ?
                """,
                (TREASURY_CURVE_SOURCE,),
            ).fetchone()
            if not force and row and str(row["eastern_date"]) == eastern_date:
                try:
                    previous = _as_eastern(datetime.fromisoformat(
                        str(row["attempted_at_utc"] or "").replace("Z", "+00:00")
                    ))
                    current = _as_eastern(datetime.fromisoformat(
                        str(attempted_at_utc or "").replace("Z", "+00:00")
                    ))
                    allow_post_publication_retry = (
                        previous.date() == current.date()
                        and previous.hour < int(publication_hour_et)
                        and current.hour >= int(publication_hour_et)
                    )
                except (TypeError, ValueError):
                    allow_post_publication_retry = False
                if not allow_post_publication_retry:
                    conn.rollback()
                    return False
            conn.execute(
                """
                INSERT INTO treasury_curve_refresh_attempts
                    (source, eastern_date, attempted_at_utc, status, error)
                VALUES (?, ?, ?, 'in_progress', '')
                ON CONFLICT(source) DO UPDATE SET
                    eastern_date = excluded.eastern_date,
                    attempted_at_utc = excluded.attempted_at_utc,
                    status = excluded.status,
                    error = excluded.error
                """,
                (TREASURY_CURVE_SOURCE, eastern_date, attempted_at_utc),
            )
            conn.commit()
            return True
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def _finish_refresh_attempt(self, status: str, error: str = "") -> None:
        conn = self._connect()
        try:
            conn.execute(
                """
                UPDATE treasury_curve_refresh_attempts
                SET status = ?, error = ?
                WHERE source = ?
                """,
                (str(status), str(error or "")[:1000], TREASURY_CURVE_SOURCE),
            )
            conn.commit()
        finally:
            conn.close()

    def refresh_latest_if_due(
        self,
        now: Optional[datetime] = None,
        proxy_tenor: object = DEFAULT_PROXY_TENOR,
        overlap_days: int = DEFAULT_INCREMENTAL_OVERLAP_DAYS,
        publication_hour_et: int = DEFAULT_PUBLICATION_HOUR_ET,
        force: bool = False,
    ) -> Dict[str, object]:
        """Refresh once per publication phase and Eastern date, with cache fallback.

        The SQLite claim is committed before network I/O, preventing concurrent
        websocket handlers from duplicating the official request. A bootstrap
        before publication may be followed by one post-publication attempt.
        ``force`` exists for the explicit maintenance CLI/admin path only.
        """
        instant = now or self._now()
        if instant.tzinfo is None:
            instant = instant.replace(tzinfo=timezone.utc)
        eastern = _as_eastern(instant)
        requested_date = eastern.date()
        if not force and not self.should_refresh(instant, publication_hour_et):
            return {
                "status": "not_due",
                "refreshAttempted": False,
                "fallbackUsed": False,
                "snapshot": self.get_curve_snapshot(requested_date),
                "refreshAttempt": self._refresh_attempt(),
                "error": "",
            }
        claimed = self._claim_refresh(
            requested_date.isoformat(),
            _utc_iso(instant),
            force=force,
            publication_hour_et=publication_hour_et,
        )
        if not claimed:
            return {
                "status": "already_attempted",
                "refreshAttempted": False,
                "fallbackUsed": False,
                "snapshot": self.get_curve_snapshot(requested_date),
                "refreshAttempt": self._refresh_attempt(),
                "error": "",
            }
        try:
            refresh = self.refresh_latest(
                as_of=requested_date,
                proxy_tenor=proxy_tenor,
                overlap_days=overlap_days,
            )
            self._finish_refresh_attempt("refreshed")
            return {
                "status": "refreshed",
                "refreshAttempted": True,
                "fallbackUsed": False,
                "refresh": refresh,
                "snapshot": self.get_curve_snapshot(requested_date),
                "refreshAttempt": self._refresh_attempt(),
                "error": "",
            }
        except Exception as exc:
            self._finish_refresh_attempt("failed", str(exc))
            snapshot = self.get_curve_snapshot(requested_date)
            return {
                "status": "cache_fallback" if snapshot else "unavailable",
                "refreshAttempted": True,
                "fallbackUsed": bool(snapshot),
                "refresh": None,
                "snapshot": snapshot,
                "refreshAttempt": self._refresh_attempt(),
                "error": str(exc),
            }

    def _latest_effective_date(
        self,
        conn: sqlite3.Connection,
        requested_date: Optional[DateLike],
    ) -> Optional[str]:
        if requested_date is None or str(requested_date).strip() == "":
            row = conn.execute(
                """
                SELECT MAX(d.date)
                FROM yield_curve_daily_rates yc
                JOIN dates d ON d.date_id = yc.date_ref
                WHERE yc.source = ?
                """,
                (TREASURY_CURVE_SOURCE,),
            ).fetchone()
        else:
            requested_iso = normalize_date(requested_date).isoformat()
            row = conn.execute(
                """
                SELECT MAX(d.date)
                FROM yield_curve_daily_rates yc
                JOIN dates d ON d.date_id = yc.date_ref
                WHERE yc.source = ? AND d.date <= ?
                """,
                (TREASURY_CURVE_SOURCE, requested_iso),
            ).fetchone()
        return str(row[0]) if row and row[0] else None

    def get_curve_snapshot(self, requested_date: Optional[DateLike] = None) -> Optional[Dict[str, object]]:
        """Return the official curve dated latest-on-or-before the request.

        A request before the first cached observation returns ``None``; it does
        not silently look into the future.
        """
        if not os.path.exists(self.db_path):
            return None
        requested_iso = (
            normalize_date(requested_date).isoformat()
            if requested_date is not None and str(requested_date).strip()
            else ""
        )
        try:
            with closing(self._connect()) as conn:
                effective = self._latest_effective_date(conn, requested_date)
                if not effective:
                    return None
                rows = conn.execute(
                    """
                    SELECT yc.tenor_code, yc.tenor_days, yc.rate
                    FROM yield_curve_daily_rates yc
                    JOIN dates d ON d.date_id = yc.date_ref
                    WHERE yc.source = ? AND d.date = ?
                    ORDER BY yc.tenor_days, yc.tenor_code
                    """,
                    (TREASURY_CURVE_SOURCE, effective),
                ).fetchall()
                try:
                    sync = conn.execute(
                        """
                        SELECT fetched_at_utc, requested_start_date, requested_end_date,
                               latest_effective_date, proxy_tenor, feed_years_json
                        FROM treasury_curve_sync_metadata WHERE source = ?
                        """,
                        (TREASURY_CURVE_SOURCE,),
                    ).fetchone()
                except sqlite3.OperationalError:
                    sync = None
        except sqlite3.OperationalError:
            return None
        if not rows:
            return None
        sync_metadata = None
        if sync:
            try:
                feed_years = json.loads(str(sync["feed_years_json"] or "[]"))
            except (TypeError, ValueError, json.JSONDecodeError):
                feed_years = []
            sync_metadata = {
                "fetchedAtUtc": str(sync["fetched_at_utc"]),
                "requestedStartDate": str(sync["requested_start_date"]),
                "requestedEndDate": str(sync["requested_end_date"]),
                "latestEffectiveDate": str(sync["latest_effective_date"]),
                "proxyTenor": str(sync["proxy_tenor"]),
                "feedYears": feed_years,
            }
        serialized_points = []
        for row in rows:
            par_yield = float(row["rate"])
            serialized_points.append({
                "tenorCode": str(row["tenor_code"]),
                "tenorDays": int(row["tenor_days"]),
                "parYield": par_yield,
                "rate": par_yield,
                "continuousRate": par_yield_to_continuous_proxy(par_yield),
                "continuousRateIsProxy": True,
                "inputSemantics": "cmt_par_yield",
            })
        quote_as_of = _quote_as_of_approximate(effective)
        return {
            "schemaVersion": SCHEMA_VERSION,
            "kind": "treasury_discount_curve",
            "snapshotId": _snapshot_id(effective, serialized_points),
            "requestedDate": requested_iso,
            "effectiveDate": effective,
            "quoteAsOf": quote_as_of,
            "quoteAsOfPrecision": "approximate_15_30_America/New_York",
            "source": TREASURY_CURVE_SOURCE,
            "sourceUrl": treasury_xml_url(normalize_date(effective).year),
            "points": serialized_points,
            "curveSemantics": dict(CURVE_SEMANTICS),
            "inputSemantics": "cmt_par_yield",
            "discountRateSemantics": "continuous_zero_proxy_from_cmt_par_yield",
            "quality": {
                "status": "degraded",
                "flags": ["cmt_par_yield_proxy", "not_bootstrapped_zero_curve"],
            },
            "syncMetadata": sync_metadata,
        }

    def get_discount_quote(
        self,
        maturity_days: Union[int, float],
        requested_date: Optional[DateLike] = None,
        year_basis: float = 365.0,
        fallback_continuous_rate: Optional[float] = None,
    ) -> Optional[Dict[str, object]]:
        """Return an explicitly approximate continuous discount-rate quote."""
        days = float(maturity_days)
        basis = float(year_basis)
        if not math.isfinite(days) or days < 0:
            raise ValueError("maturity_days must be finite and non-negative")
        if not math.isfinite(basis) or basis <= 0:
            raise ValueError("year_basis must be finite and positive")
        snapshot = self.get_curve_snapshot(requested_date)
        year_fraction = days / basis
        if not snapshot:
            if fallback_continuous_rate is None:
                return None
            fallback = float(fallback_continuous_rate)
            if not math.isfinite(fallback):
                raise ValueError("fallback_continuous_rate must be finite")
            return {
                "requestedDate": normalize_date(requested_date).isoformat() if requested_date else "",
                "effectiveDate": "",
                "maturityDays": days,
                "yearFraction": year_fraction,
                "continuousRate": fallback,
                "discountFactor": math.exp(-fallback * year_fraction),
                "source": "explicit_fallback_continuous_rate",
                "fallbackUsed": True,
                "approximate": True,
                "curveSemantics": dict(CURVE_SEMANTICS),
            }

        points = list(snapshot["points"])
        if not points:
            return None
        points.sort(key=lambda point: int(point["tenorDays"]))
        lower = points[0]
        upper = points[-1]
        interpolation = "flat_nearest"
        extrapolated = False
        weight = 0.0
        if days <= float(points[0]["tenorDays"]):
            lower = upper = points[0]
            extrapolated = days < float(points[0]["tenorDays"])
        elif days >= float(points[-1]["tenorDays"]):
            lower = upper = points[-1]
            extrapolated = days > float(points[-1]["tenorDays"])
        else:
            for left, right in zip(points, points[1:]):
                if float(left["tenorDays"]) <= days <= float(right["tenorDays"]):
                    lower, upper = left, right
                    break
            if int(lower["tenorDays"]) != int(upper["tenorDays"]):
                interpolation = "linear_continuous_rate"
                weight = (
                    (days - float(lower["tenorDays"]))
                    / (float(upper["tenorDays"]) - float(lower["tenorDays"]))
                )

        lower_cc = par_yield_to_continuous_proxy(float(lower["parYield"]))
        upper_cc = par_yield_to_continuous_proxy(float(upper["parYield"]))
        continuous_rate = lower_cc + weight * (upper_cc - lower_cc)
        return {
            "requestedDate": snapshot["requestedDate"],
            "effectiveDate": snapshot["effectiveDate"],
            "maturityDays": days,
            "yearFraction": year_fraction,
            "continuousRate": continuous_rate,
            "discountFactor": math.exp(-continuous_rate * year_fraction),
            "source": TREASURY_CURVE_SOURCE,
            "fallbackUsed": False,
            "approximate": True,
            "interpolation": interpolation,
            "extrapolated": extrapolated,
            "lowerPoint": dict(lower),
            "upperPoint": dict(upper),
            "upperWeight": weight,
            "curveSemantics": dict(CURVE_SEMANTICS),
        }

    def refresh_or_cached(
        self,
        start_date: DateLike,
        end_date: DateLike,
        proxy_tenor: object = DEFAULT_PROXY_TENOR,
        requested_date: Optional[DateLike] = None,
    ) -> Dict[str, object]:
        """Refresh, falling back to the last complete cache on feed failure."""
        try:
            refresh = self.refresh(start_date, end_date, proxy_tenor=proxy_tenor)
            return {
                "status": "refreshed",
                "refresh": refresh,
                "snapshot": self.get_curve_snapshot(requested_date or end_date),
                "fallbackUsed": False,
                "error": "",
            }
        except (TreasuryYieldCurveError, urllib.error.URLError, OSError, ET.ParseError) as exc:
            snapshot = self.get_curve_snapshot(requested_date or end_date)
            return {
                "status": "cache_fallback" if snapshot else "unavailable",
                "refresh": None,
                "snapshot": snapshot,
                "fallbackUsed": bool(snapshot),
                "error": str(exc),
            }


__all__ = [
    "CURVE_SEMANTICS",
    "DEFAULT_INCREMENTAL_OVERLAP_DAYS",
    "DEFAULT_PUBLICATION_HOUR_ET",
    "DEFAULT_PROXY_TENOR",
    "SCHEMA_VERSION",
    "TENOR_SPECS",
    "TREASURY_CURVE_SOURCE",
    "TREASURY_FAQ_URL",
    "TREASURY_METHODOLOGY_URL",
    "TREASURY_XML_URL_TEMPLATE",
    "TreasuryYieldCurveError",
    "TreasuryYieldCurveProvider",
    "download_treasury_observations",
    "fetch_treasury_year",
    "normalize_date",
    "normalize_tenor",
    "par_yield_to_continuous_proxy",
    "parse_treasury_xml",
    "tenor_days",
    "treasury_xml_url",
]
