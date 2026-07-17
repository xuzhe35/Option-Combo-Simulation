"""Single source of truth for locating the options chain service.

Option chains and underlying bars come from a data service that lives outside
this repo and is deliberately swappable — today a local `chain_server.py` in a
sibling workspace, tomorrow possibly a paid vendor endpoint. Two independent
facts describe it:

    chain_service_url   where to talk to it. This is the only thing the
                        running stack needs; everything downstream is HTTP.
    chain_service_dir   where its `chain_server.py` lives, so the replay
                        launchers can start it for you. Purely a convenience.

Keeping them separate is what makes a provider swap a config edit: point the
url at the vendor and blank the dir, and nothing tries to launch a local
server that no longer exists.

Resolution order for each, first hit wins:

    1. environment variable  (OPTION_COMBO_CHAIN_SERVICE_URL / _DIR)
    2. config.ini [historical]
    3. the built-in default below

The env vars are the experiment lever: point the stack at another provider for
a single run without touching tracked config.

Also runnable, so the bash/PowerShell launchers can resolve the same values
without reimplementing INI parsing:

    python3 chain_service_config.py --url
    python3 chain_service_config.py --dir
"""

import configparser
import os

PROJECT_ROOT = os.path.dirname(os.path.abspath(__file__))

DEFAULT_CHAIN_SERVICE_URL = 'http://127.0.0.1:8750'

# Relative to PROJECT_ROOT, matching the historical layout where this repo sits
# at <workspace>/projects/Option Combo Simulation next to <workspace>/Options DB.
DEFAULT_CHAIN_SERVICE_DIR = os.path.join('..', '..', 'Options DB', 'chain_service')

CHAIN_SERVICE_SCRIPT = 'chain_server.py'

ENV_CHAIN_SERVICE_URL = 'OPTION_COMBO_CHAIN_SERVICE_URL'
ENV_CHAIN_SERVICE_DIR = 'OPTION_COMBO_CHAIN_SERVICE_DIR'

_CONFIG_SECTION = 'historical'


def load_config(config_path=None):
    """Parse config.ini. Defaults to the copy next to this module rather than
    the one in the current directory, so launchers and scripts agree no matter
    where they were invoked from."""
    parser = configparser.ConfigParser()
    parser.read(config_path or os.path.join(PROJECT_ROOT, 'config.ini'))
    return parser


def _sources(config, key, env_name):
    """Yield the configured values in precedence order, stripped.

    Presence is what counts, not truthiness: a variable that is *set but empty*
    is a deliberate answer for fields where empty carries meaning. Callers
    decide whether to accept an empty value or keep looking, because the two
    fields differ — an empty url is never usable, while an empty dir is exactly
    how you say "the service is remote".
    """
    if env_name in os.environ:
        yield os.environ[env_name].strip()
    if config is None:
        config = load_config()
    if config.has_option(_CONFIG_SECTION, key):
        yield config.get(_CONFIG_SECTION, key).strip()


def _absolutize(path):
    """Resolve against the repo, never the caller's cwd: the launchers cd
    around, and a relative dir must not mean different places depending on who
    invoked them."""
    if not path:
        return ''
    if not os.path.isabs(path):
        path = os.path.join(PROJECT_ROOT, path)
    return os.path.normpath(path)


def resolve_chain_service_url(config=None):
    """Base URL of the chain service, never with a trailing slash.

    An empty value is not a usable url, so it is skipped rather than honored:
    blanking this cannot leave the stack with nowhere to talk to.
    """
    for value in _sources(config, 'chain_service_url', ENV_CHAIN_SERVICE_URL):
        if value:
            return value.rstrip('/')
    return DEFAULT_CHAIN_SERVICE_URL.rstrip('/')


def resolve_chain_service_dir(config=None):
    """Absolute path to the directory holding chain_server.py, or '' when the
    service is not ours to start.

    Unlike the url, the first configured source wins *even when empty* — that
    is the whole point. Blanking this (in config.ini or via the env var) says
    the service is remote or vendor-hosted, and must not quietly fall back to
    the bundled sibling layout, or the launchers would go start a local server
    that is not supposed to exist any more.
    """
    for value in _sources(config, 'chain_service_dir', ENV_CHAIN_SERVICE_DIR):
        return _absolutize(value)
    return _absolutize(DEFAULT_CHAIN_SERVICE_DIR)


def resolve_chain_service_script(config=None):
    """Absolute path to chain_server.py, or '' when there is no local service
    configured. The path is not checked for existence — a configured-but-absent
    script is a different situation from a deliberately remote service, and
    callers word their diagnostics differently for each."""
    directory = resolve_chain_service_dir(config)
    return os.path.join(directory, CHAIN_SERVICE_SCRIPT) if directory else ''


def _main(argv):
    import argparse

    parser = argparse.ArgumentParser(
        description='Print the resolved options chain service location.'
    )
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument('--url', action='store_true', help='base URL')
    group.add_argument('--dir', action='store_true',
                       help="directory holding chain_server.py; empty if remote")
    group.add_argument('--script', action='store_true',
                       help="full path to chain_server.py; empty if remote")
    args = parser.parse_args(argv)

    config = load_config()
    if args.url:
        print(resolve_chain_service_url(config))
    elif args.dir:
        print(resolve_chain_service_dir(config))
    else:
        print(resolve_chain_service_script(config))
    return 0


if __name__ == '__main__':
    import sys

    sys.exit(_main(sys.argv[1:]))
