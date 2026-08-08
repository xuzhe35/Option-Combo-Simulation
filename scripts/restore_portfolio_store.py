"""Install a verified backup as the active workspace database.

STOP ib_server.py and historical_server.py first — restoring under a live
backend corrupts the WAL. The candidate is verified with quick_check before
anything moves; an existing database is displaced to a timestamped
.pre-restore copy (with its WAL/SHM), never overwritten.

    python scripts/restore_portfolio_store.py <backup.db> --yes [--db-path P]
"""

import argparse
import configparser
import pathlib
import sys

REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from portfolio_store import (
    PortfolioStore,
    PortfolioStoreError,
    resolve_db_path,
    restore_database,
)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('backup', help='backup file published by '
                        'backup_portfolio_store.py (never a .partial)')
    parser.add_argument('--db-path', help='active database (default: auto-resolved)')
    parser.add_argument('--yes', action='store_true',
                        help='confirm the backends are stopped and proceed')
    args = parser.parse_args(argv)

    if not args.yes:
        print('Refusing to restore without --yes.\n'
              '1. Stop ib_server.py and historical_server.py.\n'
              '2. Re-run with --yes.', file=sys.stderr)
        return 1

    config = configparser.ConfigParser()
    config.read(REPO_ROOT / 'config.ini')
    db_path = pathlib.Path(args.db_path) if args.db_path else resolve_db_path(config)

    try:
        result = restore_database(args.backup, db_path)
        documents = PortfolioStore(db_path).initialize().list_documents()
    except PortfolioStoreError as exc:
        print(f'restore failed ({exc.code}): {exc}', file=sys.stderr)
        return 1

    print(f"restored {result['restored_from']} -> {result['db_path']}")
    if result['displaced_to']:
        print(f"previous database kept at {result['displaced_to']}")
    print(f'{len(documents)} workspace document(s) visible after restore')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
