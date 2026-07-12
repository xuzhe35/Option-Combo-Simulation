"""Download forward exchange calendars from official NYSE and CME sources.

The generated browser snapshot is the source of truth for future trading-day
calculations.  No holiday rule is used to invent future closures.

NYSE publishes a public HTML table for several forward years.  CME publishes
product-level schedules through its OAuth-protected Reference Data API.

Weekly use (all configured markets):

    CME_API_ID=... CME_API_SECRET=... \
      python3 scripts/sync_official_exchange_calendars.py

NYSE-only bootstrap/refresh (explicitly leaves CME products unavailable):

    python3 scripts/sync_official_exchange_calendars.py --nyse-only

For testing or an API response archived by another approved client:

    python3 scripts/sync_official_exchange_calendars.py \
      --cme-products-json products.json --cme-schedules-json schedules.json

Outputs:
    exchange_calendars/official_exchange_calendars.json
    js/official_exchange_calendars.generated.js
"""

from __future__ import annotations

import argparse
import base64
import datetime as dt
import hashlib
import html
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import re
import ssl
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request


PROJECT_ROOT = Path(__file__).resolve().parents[1]
JSON_OUTPUT = PROJECT_ROOT / "exchange_calendars" / "official_exchange_calendars.json"
JS_OUTPUT = PROJECT_ROOT / "js" / "official_exchange_calendars.generated.js"

NYSE_URL = "https://www.nyse.com/trade/hours-calendars"
CME_TOKEN_URL = "https://auth.cmegroup.com/as/token.oauth2"
CME_API_ROOT = "https://refdata.api.cmegroup.com/refdata/v3"
USER_AGENT = "OptionComboOfficialCalendarSync/1.0"
CME_DERIVATION_VERSION = "business-trade-date-gaps-v2"

# Product-level keys avoid pretending every product on a CME-owned exchange
# shares identical holiday sessions.
CME_PRODUCTS = {
    "CME:ES": "ES",
    "CME:NQ": "NQ",
    "CME:MES": "MES",
    "CME:MNQ": "MNQ",
    "NYMEX:CL": "CL",
    "COMEX:GC": "GC",
    "COMEX:SI": "SI",
    "COMEX:HG": "HG",
}

WEEKDAYS = "Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday"
MONTHS = (
    "January|February|March|April|May|June|July|August|September|"
    "October|November|December"
)
DATED_TEXT_RE = re.compile(
    rf"(?:{WEEKDAYS}),\s+({MONTHS})\s+(\d{{1,2}}),\s+(\d{{4}})",
    re.IGNORECASE,
)


class CalendarSyncError(RuntimeError):
    pass


class _TableParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.tables = []
        self._table = None
        self._row = None
        self._cell = None

    def handle_starttag(self, tag, attrs):
        if tag == "table":
            self._table = []
        elif tag == "tr" and self._table is not None:
            self._row = []
        elif tag in ("th", "td") and self._row is not None:
            self._cell = []

    def handle_data(self, data):
        if self._cell is not None:
            self._cell.append(data)

    def handle_endtag(self, tag):
        if tag in ("th", "td") and self._cell is not None:
            text = " ".join("".join(self._cell).split())
            self._row.append(text)
            self._cell = None
        elif tag == "tr" and self._row is not None:
            if self._row:
                self._table.append(self._row)
            self._row = None
        elif tag == "table" and self._table is not None:
            self.tables.append(self._table)
            self._table = None


def _ssl_context():
    try:
        import certifi  # type: ignore
        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        default_paths = ssl.get_default_verify_paths()
        if default_paths.cafile and Path(default_paths.cafile).is_file():
            return ssl.create_default_context(cafile=default_paths.cafile)
        # python.org macOS frameworks may not be linked to the system keychain,
        # while curl and the OS maintain this verified bundle.
        for candidate in ("/etc/ssl/cert.pem", "/etc/ssl/certs/ca-certificates.crt"):
            if Path(candidate).is_file():
                return ssl.create_default_context(cafile=candidate)
        return ssl.create_default_context()


def _download(url, *, headers=None, data=None, method=None):
    request_headers = {"User-Agent": USER_AGENT, "Accept": "*/*"}
    request_headers.update(headers or {})
    request = urllib.request.Request(
        url, headers=request_headers, data=data, method=method)
    try:
        with urllib.request.urlopen(request, timeout=45, context=_ssl_context()) as response:
            return response.read(), dict(response.headers)
    except urllib.error.URLError as exc:
        # Some project interpreters do not see the OS trust store.  Curl uses
        # its own verified CA bundle and is available on supported macOS and
        # modern Windows installations.  Never disable certificate checks.
        if data is not None or method not in (None, "GET"):
            raise CalendarSyncError(f"Official download failed: {url}: {exc}") from exc
        with tempfile.NamedTemporaryFile(delete=False) as handle:
            temp_path = Path(handle.name)
        try:
            command = [
                "curl", "-L", "--fail", "--silent", "--show-error",
                "--max-time", "45", "-A", USER_AGENT,
            ]
            for key, value in request_headers.items():
                if key.lower() != "user-agent":
                    command.extend(["-H", f"{key}: {value}"])
            command.extend(["-o", str(temp_path), url])
            subprocess.run(command, check=True)
            return temp_path.read_bytes(), {}
        except (OSError, subprocess.CalledProcessError) as curl_exc:
            raise CalendarSyncError(f"Official download failed: {url}: {exc}") from curl_exc
        finally:
            temp_path.unlink(missing_ok=True)


def _parse_nyse_date(value, year):
    cleaned = html.unescape(value).replace("—", "").strip()
    cleaned = re.sub(r"\*+", "", cleaned)
    cleaned = re.sub(r"\s*\([^)]*\)\s*", " ", cleaned).strip()
    if not cleaned:
        return None
    cleaned = re.sub(rf"^(?:{WEEKDAYS}),\s*", "", cleaned, flags=re.IGNORECASE)
    try:
        parsed = dt.datetime.strptime(f"{cleaned} {year}", "%B %d %Y").date()
    except ValueError as exc:
        raise CalendarSyncError(f"Unrecognized NYSE holiday date: {value!r}") from exc
    return parsed.isoformat()


def parse_nyse_calendar(page_bytes, fetched_at):
    source = page_bytes.decode("utf-8")
    parser = _TableParser()
    parser.feed(source)
    table = next((item for item in parser.tables
                  if item and item[0] and item[0][0].strip().lower() == "holiday"), None)
    if not table or len(table[0]) < 2:
        raise CalendarSyncError("NYSE holiday table was not found; refusing to guess")

    years = []
    for value in table[0][1:]:
        if not re.fullmatch(r"20\d{2}", value):
            raise CalendarSyncError(f"Unexpected NYSE year header: {value!r}")
        years.append(int(value))

    closures = []
    for row in table[1:]:
        if len(row) != len(years) + 1:
            raise CalendarSyncError(f"Unexpected NYSE holiday row: {row!r}")
        holiday_name = row[0]
        for year, value in zip(years, row[1:]):
            date_key = _parse_nyse_date(value, year)
            if date_key:
                closures.append({"date": date_key, "name": holiday_name, "status": "closed"})

    # Early-close announcements are prose footnotes on the same official
    # page. Preserve them because a future weighted clock may use session
    # length, even though a partial session still counts as a trading day now.
    plain_text = html.unescape(re.sub(r"<[^>]+>", " ", source))
    plain_text = " ".join(plain_text.split())
    early_closes = []
    for sentence in re.findall(
            r"Each market will close early.*?All times are Eastern Time\.",
            plain_text):
        for month, day, year in DATED_TEXT_RE.findall(sentence):
            date_key = dt.datetime.strptime(
                f"{month} {day} {year}", "%B %d %Y").date().isoformat()
            early_closes.append({
                "date": date_key,
                "status": "early_close",
                "closeTime": "13:00",
                "optionCloseTime": "13:15",
                "timezone": "America/New_York",
            })

    if len(closures) < len(years) * 8:
        raise CalendarSyncError(
            f"NYSE parser found only {len(closures)} closures for {len(years)} years")

    return {
        "calendarKey": "NYSE",
        "sourceKind": "official_html",
        "sourceUrl": NYSE_URL,
        "fetchedAt": fetched_at,
        "coverageStart": f"{min(years)}-01-01",
        "coverageEnd": f"{max(years)}-12-31",
        "closures": sorted(closures, key=lambda item: item["date"]),
        "earlyCloses": sorted(
            {item["date"]: item for item in early_closes}.values(),
            key=lambda item: item["date"],
        ),
        "sourceSha256": hashlib.sha256(page_bytes).hexdigest(),
    }


def _json_records(payload, marker):
    found = []

    def walk(value):
        if isinstance(value, dict):
            if marker in value:
                found.append(value)
            for child in value.values():
                walk(child)
        elif isinstance(value, list):
            for child in value:
                walk(child)

    walk(payload)
    return found


def _normalize_cme_date(value):
    text = str(value or "").strip()
    # CME currently returns tradingDate as MM-DD-YY (for example 07-09-25).
    # Keep the older observed/API-fixture encodings explicit as well; do not
    # infer an unknown ordering because a swapped month/day would silently
    # corrupt the forward calendar.
    for pattern in ("%m-%d-%y", "%m%d%y", "%Y-%m-%d", "%m/%d/%Y"):
        try:
            return dt.datetime.strptime(text, pattern).date().isoformat()
        except ValueError:
            pass
    raise CalendarSyncError(f"Unrecognized CME trading date: {value!r}")


def _date_range(start, end):
    current = start
    while current <= end:
        yield current
        current += dt.timedelta(days=1)


def parse_cme_calendars(products_payload, schedules_payload, fetched_at):
    product_records = _json_records(products_payload, "globexProductCode")
    schedule_records = _json_records(schedules_payload, "marketEventsByDate")
    if not product_records or not schedule_records:
        raise CalendarSyncError("CME API response lacks product or trading schedule records")

    output = {}
    for calendar_key, product_code in CME_PRODUCTS.items():
        product = next((item for item in product_records
                        if str(item.get("globexProductCode", "")).upper() == product_code), None)
        if not product:
            raise CalendarSyncError(f"CME product response omitted {product_code}")
        group_code = str(product.get("globexGroupCode") or "").strip()
        if not group_code:
            raise CalendarSyncError(f"CME product {product_code} lacks globexGroupCode")

        schedules = [item for item in schedule_records
                     if group_code in [str(code) for code in item.get("applicableGlobexGroupCodes", [])]]
        if not schedules:
            raise CalendarSyncError(
                f"CME trading schedules omitted group {group_code} for {product_code}")

        dates = {}
        for schedule in schedules:
            for entry in schedule.get("marketEventsByDate", []):
                date_key = _normalize_cme_date(entry.get("tradingDate"))
                events = entry.get("marketEvents") or []
                event_types = [str(event.get("marketEventType", "")).lower()
                               for event in events if isinstance(event, dict)]
                has_open = "open" in event_types
                dates.setdefault(date_key, {"hasOpen": False, "events": []})
                dates[date_key]["hasOpen"] = dates[date_key]["hasOpen"] or has_open
                dates[date_key]["events"].extend(events)

        if not dates:
            raise CalendarSyncError(f"CME schedule for {product_code} contained no dates")
        coverage_start = dt.date.fromisoformat(min(dates))
        coverage_end = dt.date.fromisoformat(max(dates))
        weekdays = [day for day in _date_range(coverage_start, coverage_end)
                    if day.weekday() < 5]
        present_weekdays = {key for key in dates
                            if dt.date.fromisoformat(key).weekday() < 5}

        # tradingDate is CME's Business Trade Date.  A full holiday can be
        # represented by the absence of that weekday from marketEventsByDate,
        # rather than by a synthetic date containing only a `closed` event.
        # Both representations are official evidence of a non-trading date.
        closures = []
        for day in weekdays:
            key = day.isoformat()
            if key not in dates:
                closures.append({
                    "date": key,
                    "status": "closed",
                    "name": "CME official schedule: no business trade date",
                    "reason": "missing_business_trade_date",
                })
            elif not dates[key]["hasOpen"]:
                closures.append({
                    "date": key,
                    "status": "closed",
                    "name": "CME official schedule: no open market event",
                    "reason": "no_open_event",
                })

        # A sparse or truncated response must not be converted into hundreds
        # of invented holidays.  Normal holiday gaps are only a small share of
        # weekdays across the API's multi-year window.
        if len(weekdays) >= 60 and len(present_weekdays) < len(weekdays) * 0.75:
            raise CalendarSyncError(
                f"CME schedule for {product_code} is unexpectedly sparse: "
                f"{len(present_weekdays)} of {len(weekdays)} weekdays present")
        if len(weekdays) >= 250 and not closures:
            raise CalendarSyncError(
                f"CME schedule for {product_code} produced zero closures across "
                f"{len(weekdays)} weekdays; refusing an implausible snapshot")
        output[calendar_key] = {
            "calendarKey": calendar_key,
            "productCode": product_code,
            "globexGroupCode": group_code,
            "sourceKind": "cme_reference_data_api",
            "sourceUrl": f"{CME_API_ROOT}/tradingSchedules",
            "fetchedAt": fetched_at,
            "derivationVersion": CME_DERIVATION_VERSION,
            "coverageStart": coverage_start.isoformat(),
            "coverageEnd": coverage_end.isoformat(),
            "sourceTradingDateCount": len(dates),
            "sourceWeekdayCount": len(present_weekdays),
            "closures": sorted(closures, key=lambda item: item["date"]),
            "earlyCloses": [],
        }
    return output


def _oauth_token(api_id, api_secret):
    credentials = base64.b64encode(f"{api_id}:{api_secret}".encode()).decode()
    body = urllib.parse.urlencode({"grant_type": "client_credentials"}).encode()
    payload, _ = _download(
        CME_TOKEN_URL,
        headers={
            "Authorization": f"Basic {credentials}",
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept": "application/json",
        },
        data=body,
        method="POST",
    )
    parsed = json.loads(payload)
    token = parsed.get("access_token")
    if not token:
        raise CalendarSyncError("CME OAuth response did not include access_token")
    return token


def _fetch_cme_collection(endpoint, token, *, query=None):
    query = dict(query or {})
    query.update({"page": 0, "size": 20})
    pages = []
    while True:
        url = f"{CME_API_ROOT}/{endpoint}?{urllib.parse.urlencode(query)}"
        payload, _ = _download(
            url, headers={"Authorization": f"Bearer {token}", "Accept": "application/json"})
        parsed = json.loads(payload)
        pages.append(parsed)
        metadata = parsed.get("_metadata") or {}
        total_pages = int(metadata.get("totalPages") or 1)
        if query["page"] + 1 >= total_pages:
            break
        query["page"] += 1
    return {"pages": pages}


def _load_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def _write_snapshot(snapshot):
    JSON_OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    JSON_OUTPUT.write_text(
        json.dumps(snapshot, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    js = (
        "// Generated by scripts/sync_official_exchange_calendars.py. Do not edit.\n"
        "globalThis.OptionComboOfficialExchangeCalendars = "
        + json.dumps(snapshot, indent=2, ensure_ascii=False)
        + ";\n"
    )
    JS_OUTPUT.write_text(js, encoding="utf-8", newline="\n")


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--nyse-only", action="store_true",
                        help="refresh NYSE only; CME calendars remain unavailable")
    parser.add_argument("--cme-products-json")
    parser.add_argument("--cme-schedules-json")
    parser.add_argument("--check", action="store_true",
                        help="download and validate without writing output")
    args = parser.parse_args(argv)

    fetched_at = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()
    nyse_bytes, _ = _download(NYSE_URL, headers={"Accept": "text/html"})
    calendars = {"NYSE": parse_nyse_calendar(nyse_bytes, fetched_at)}

    if not args.nyse_only:
        if bool(args.cme_products_json) != bool(args.cme_schedules_json):
            raise CalendarSyncError("provide both CME JSON fixture paths or neither")
        if args.cme_products_json:
            products = _load_json(args.cme_products_json)
            schedules = _load_json(args.cme_schedules_json)
        else:
            token = os.environ.get("CME_ACCESS_TOKEN", "").strip()
            if not token:
                api_id = os.environ.get("CME_API_ID", "").strip()
                api_secret = os.environ.get("CME_API_SECRET", "").strip()
                if not api_id or not api_secret:
                    raise CalendarSyncError(
                        "CME requires official OAuth credentials. Set CME_API_ID and "
                        "CME_API_SECRET (or CME_ACCESS_TOKEN), or explicitly use --nyse-only.")
                token = _oauth_token(api_id, api_secret)
            product_pages = []
            for product_code in sorted(set(CME_PRODUCTS.values())):
                product_pages.append(_fetch_cme_collection(
                    "products", token, query={"globexProductCode": product_code}))
            products = {"queries": product_pages}
            schedules = _fetch_cme_collection("tradingSchedules", token)
        calendars.update(parse_cme_calendars(products, schedules, fetched_at))

    snapshot = {
        "version": 2,
        "generatedAt": fetched_at,
        "calendars": calendars,
    }
    if args.check:
        print(json.dumps({
            key: {
                "coverageStart": value["coverageStart"],
                "coverageEnd": value["coverageEnd"],
                "closures": len(value["closures"]),
                "earlyCloses": len(value["earlyCloses"]),
            }
            for key, value in calendars.items()
        }, indent=2))
        return 0
    _write_snapshot(snapshot)
    print(f"Wrote {JSON_OUTPUT}")
    print(f"Wrote {JS_OUTPUT}")
    for key, value in calendars.items():
        print(f"  {key}: {value['coverageStart']} .. {value['coverageEnd']}, "
              f"{len(value['closures'])} closures, {len(value['earlyCloses'])} early closes")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (CalendarSyncError, json.JSONDecodeError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)
