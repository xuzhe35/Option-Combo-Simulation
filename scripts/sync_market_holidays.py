"""Compatibility entry point for the official exchange-calendar sync.

The former rule/database-diff holiday maintainer has been retired. Keeping
this filename prevents an old weekly command from silently invoking a second
calendar authority.
"""

import json
import sys

from sync_official_exchange_calendars import CalendarSyncError, main


if __name__ == "__main__":
    forwarded = [arg for arg in sys.argv[1:] if arg != "--write"]
    print(
        "scripts/sync_market_holidays.py is retired; running the official "
        "NYSE/CME exchange-calendar sync instead.",
        file=sys.stderr,
    )
    try:
        raise SystemExit(main(forwarded))
    except (CalendarSyncError, json.JSONDecodeError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise SystemExit(1)
