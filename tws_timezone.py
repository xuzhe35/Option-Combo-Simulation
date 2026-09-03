"""Validate the TWS decoder clock before any IB connection is opened."""

from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


def read_tws_timezone(config):
    name = config.get('tws', 'timezone', fallback='').strip()
    # Keep the historical unset behavior. Ledger imports separately require
    # an explicit clock; never guess a broker clock from the server OS.
    if not name:
        return ''
    try:
        ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError) as exc:
        raise ValueError(
            f'Invalid [tws] timezone {name!r} in config.ini. Set a valid IANA '
            'timezone matching TWS/Gateway login (for example America/New_York). '
            'IB connection has not been started; on Windows also check tzdata '
            'is installed in the bridge Python environment.'
        ) from exc
    return name
