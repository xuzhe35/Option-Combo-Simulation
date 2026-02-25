"""
Generate NYSE market holidays for a given year.
Outputs market_holidays.js in the project root.

Usage:
    python scripts/gen_holidays.py 2027
    python scripts/gen_holidays.py 2026 2027 2028
"""

import sys
import os
from datetime import date, timedelta

def easter(year):
    """Compute Easter Sunday using the Anonymous Gregorian algorithm."""
    a = year % 19
    b, c = divmod(year, 100)
    d, e = divmod(b, 4)
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i, k = divmod(c, 4)
    l = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * l) // 451
    month, day = divmod(h + l - 7 * m + 114, 31)
    return date(year, month, day + 1)

def observed(d):
    """If holiday falls on Sat, observe Fri; if Sun, observe Mon."""
    if d.weekday() == 5:  # Saturday
        return d - timedelta(days=1)
    elif d.weekday() == 6:  # Sunday
        return d + timedelta(days=1)
    return d

def nth_weekday(year, month, weekday, n):
    """Return the n-th occurrence of a weekday in a given month.
    weekday: 0=Mon, 1=Tue, ..., 6=Sun
    """
    first = date(year, month, 1)
    # Days until the first occurrence of `weekday`
    offset = (weekday - first.weekday()) % 7
    return first + timedelta(days=offset + 7 * (n - 1))

def last_weekday(year, month, weekday):
    """Return the last occurrence of a weekday in a given month."""
    if month == 12:
        next_month = date(year + 1, 1, 1)
    else:
        next_month = date(year, month + 1, 1)
    last_day = next_month - timedelta(days=1)
    offset = (last_day.weekday() - weekday) % 7
    return last_day - timedelta(days=offset)

def nyse_holidays(year):
    """Return a sorted list of (date, name) for NYSE holidays in a given year."""
    holidays = [
        (observed(date(year, 1, 1)), "New Year's Day"),
        (nth_weekday(year, 1, 0, 3), "Martin Luther King Jr. Day"),
        (nth_weekday(year, 2, 0, 3), "Presidents' Day"),
        (easter(year) - timedelta(days=2), "Good Friday"),
        (last_weekday(year, 5, 0), "Memorial Day"),
        (observed(date(year, 6, 19)), "Juneteenth"),
        (observed(date(year, 7, 4)), "Independence Day"),
        (nth_weekday(year, 9, 0, 1), "Labor Day"),
        (nth_weekday(year, 11, 3, 4), "Thanksgiving Day"),
        (observed(date(year, 12, 25)), "Christmas Day"),
    ]
    holidays.sort(key=lambda x: x[0])
    return holidays

def generate_js(years):
    lines = []
    lines.append('/**')
    lines.append(' * NYSE Market Holidays')
    lines.append(' * ')
    lines.append(' * Regenerate annually:')
    lines.append(' *   python scripts/gen_holidays.py <year> [year2 ...]')
    lines.append(' * ')
    lines.append(' * Sources:')
    lines.append(' *   https://www.nyse.com/markets/hours-calendars')
    lines.append(' */')
    lines.append('const MARKET_HOLIDAYS = new Set([')
    
    for yi, year in enumerate(years):
        holidays = nyse_holidays(year)
        lines.append(f'    // {year}')
        for i, (d, name) in enumerate(holidays):
            day_abbr = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][d.weekday()]
            comma = ','
            lines.append(f"    '{d.isoformat()}'{comma} // {name} ({day_abbr})")
    
    lines.append(']);')
    lines.append('')
    return '\n'.join(lines)

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(f"Usage: python {sys.argv[0]} <year> [year2 ...]")
        print(f"Example: python {sys.argv[0]} 2027")
        sys.exit(1)

    years = [int(y) for y in sys.argv[1:]]
    js_content = generate_js(years)

    # Write to project root
    script_dir = os.path.dirname(os.path.abspath(__file__))
    project_dir = os.path.dirname(script_dir)
    output_path = os.path.join(project_dir, 'market_holidays.js')

    with open(output_path, 'w', encoding='utf-8') as f:
        f.write(js_content)

    print(f"Generated {output_path}")
    for year in years:
        print(f"\n  {year} NYSE Holidays:")
        for d, name in nyse_holidays(year):
            day_abbr = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][d.weekday()]
            print(f"    {d.isoformat()} ({day_abbr}) - {name}")
