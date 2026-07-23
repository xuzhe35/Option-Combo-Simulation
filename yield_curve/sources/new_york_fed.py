"""New York Fed SOFR source adapter.

The 30/90/180-day SOFR Averages are intentionally retained only as
diagnostics.  They are backward-looking compounded realized rates and are not
future 30/90/180-day zero-rate observations.
"""

from __future__ import annotations

import json
import math
import ssl
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta
from typing import Callable, Dict, Mapping, Optional


SOFR_SOURCE = "nyfed:sofr"
SOFR_LATEST_URL = "https://markets.newyorkfed.org/api/rates/all/latest.json"
SOFR_SEARCH_URL = "https://markets.newyorkfed.org/api/rates/secured/sofr/search.json"
SOFR_INFORMATION_URL = "https://www.newyorkfed.org/markets/reference-rates/sofr"
SOFR_AVERAGES_INFORMATION_URL = (
    "https://www.newyorkfed.org/markets/reference-rates/sofr-averages-and-index"
)


class SofrSourceError(RuntimeError):
    """The official SOFR response could not be downloaded or interpreted."""


FetchJson = Callable[[str], Mapping[str, object]]


def _verified_ssl_context() -> ssl.SSLContext:
    context = ssl.create_default_context()
    if context.cert_store_stats().get("x509_ca", 0):
        return context
    for candidate in ("/etc/ssl/cert.pem", "/private/etc/ssl/cert.pem"):
        try:
            context.load_verify_locations(cafile=candidate)
        except (FileNotFoundError, OSError, ssl.SSLError):
            continue
        if context.cert_store_stats().get("x509_ca", 0):
            break
    return context


def fetch_json(url: str, timeout: float = 20.0) -> Mapping[str, object]:
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "application/json",
            "User-Agent": "OptionComboSimulation/3.0 (+https://markets.newyorkfed.org/)",
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
        raise SofrSourceError("NY Fed SOFR request failed: HTTP {}".format(exc.code)) from exc
    except (urllib.error.URLError, OSError, TimeoutError) as exc:
        raise SofrSourceError("NY Fed SOFR request failed: {}".format(exc)) from exc
    try:
        decoded = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError, TypeError) as exc:
        raise SofrSourceError("NY Fed SOFR response was not valid JSON") from exc
    if not isinstance(decoded, dict):
        raise SofrSourceError("NY Fed SOFR response has an unexpected shape")
    return decoded


def _iso_date(value: object) -> str:
    text = str(value or "").strip().replace("/", "-")
    for fmt in ("%Y-%m-%d", "%Y%m%d"):
        try:
            return datetime.strptime(text, fmt).date().isoformat()
        except ValueError:
            continue
    return ""


def _finite_decimal_percent(value: object) -> Optional[float]:
    try:
        parsed = float(value) / 100.0
    except (TypeError, ValueError):
        return None
    return parsed if math.isfinite(parsed) else None


def _records(payload: Mapping[str, object]):
    for key in ("refRates", "rates", "results"):
        value = payload.get(key)
        if isinstance(value, list):
            return [row for row in value if isinstance(row, dict)]
    return []


def parse_sofr_payload(
    payload: Mapping[str, object],
    requested_date: Optional[object] = None,
) -> Dict[str, object]:
    """Return the latest official SOFR observation on or before a date."""
    requested = _iso_date(requested_date) if requested_date else "9999-12-31"
    rows = _records(payload)
    sofr_candidates = []
    averages_candidates = []
    for row in rows:
        row_type = str(row.get("type") or row.get("rateType") or "").strip().upper()
        effective = _iso_date(row.get("effectiveDate") or row.get("date"))
        if not effective or effective > requested:
            continue
        if row_type == "SOFR" or (not row_type and row.get("percentRate") is not None):
            rate = _finite_decimal_percent(row.get("percentRate") or row.get("rate"))
            if rate is not None:
                sofr_candidates.append((effective, rate, row))
        if row_type in ("SOFRAI", "SOFR AVERAGES", "SOFR_AVERAGES"):
            averages_candidates.append((effective, row))

    if not sofr_candidates:
        raise SofrSourceError("NY Fed response contains no SOFR observation on or before {}".format(requested))
    effective, rate, raw = max(sofr_candidates, key=lambda item: item[0])
    result: Dict[str, object] = {
        "source": SOFR_SOURCE,
        "effectiveDate": effective,
        "rate": rate,
        "percentRate": rate * 100.0,
        "dayCount": "ACT/360",
        "quoteConvention": "annualized_simple_overnight",
        "revisionIndicator": str(raw.get("revisionIndicator") or ""),
        "volumeBillions": raw.get("volumeInBillions") or raw.get("volume"),
        "sourceUrl": SOFR_LATEST_URL,
        "methodologyUrl": SOFR_INFORMATION_URL,
    }
    if averages_candidates:
        avg_effective, avg_raw = max(averages_candidates, key=lambda item: item[0])
        diagnostics = {
            "effectiveDate": avg_effective,
            "semantics": "backward_looking_realized_compounded_average_not_curve_nodes",
            "sourceUrl": SOFR_AVERAGES_INFORMATION_URL,
        }
        for output_key, candidates in (
            ("average30Day", ("average30day", "average30Day")),
            ("average90Day", ("average90day", "average90Day")),
            ("average180Day", ("average180day", "average180Day")),
            ("index", ("index", "sofrIndex")),
        ):
            raw_value = next((avg_raw.get(key) for key in candidates if avg_raw.get(key) not in (None, "")), None)
            if raw_value is None:
                continue
            try:
                value = float(raw_value)
            except (TypeError, ValueError):
                continue
            diagnostics[output_key] = value / 100.0 if output_key.startswith("average") else value
        result["backwardLookingDiagnostics"] = diagnostics
    return result


def load_sofr_observation(
    requested_date: Optional[date] = None,
    timeout: float = 20.0,
    fetcher: Optional[FetchJson] = None,
) -> Dict[str, object]:
    target = requested_date or date.today()
    loader = fetcher or (lambda url: fetch_json(url, timeout=timeout))
    latest = loader(SOFR_LATEST_URL)
    try:
        return parse_sofr_payload(latest, target)
    except SofrSourceError:
        # A historical CLI request cannot use a later observation from the
        # "latest" endpoint. Search a short on-or-before window instead.
        start = target - timedelta(days=14)
        query = urllib.parse.urlencode({
            "startDate": start.isoformat(),
            "endDate": target.isoformat(),
            "type": "rate",
        })
        historical = loader("{}?{}".format(SOFR_SEARCH_URL, query))
        return parse_sofr_payload(historical, target)


__all__ = [
    "SOFR_AVERAGES_INFORMATION_URL",
    "SOFR_INFORMATION_URL",
    "SOFR_LATEST_URL",
    "SOFR_SEARCH_URL",
    "SOFR_SOURCE",
    "SofrSourceError",
    "fetch_json",
    "load_sofr_observation",
    "parse_sofr_payload",
]
