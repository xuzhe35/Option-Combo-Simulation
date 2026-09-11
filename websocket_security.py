"""Compatibility shim for Docker supervisors built before the Origin rollback.

Both backends accept arbitrary, null and missing Origin headers again. This
module no longer supplies an authorization policy. Already-built supervisors
load this file from the runtime checkout and use the first returned string as
their outgoing monitor Origin, so removing the helper would break their startup.
"""


DEFAULT_ALLOWED_ORIGINS = (
    'http://localhost:8000',
    'http://127.0.0.1:8000',
    'http://[::1]:8000',
)


def read_allowed_ws_origins(config, env=None):
    """Return a nonempty legacy monitor value, not a server Origin allow-list.

    The signature is retained for shipped Docker images. Retired INI and
    environment settings are ignored, even if malformed, so stale configuration
    cannot prevent startup after updating the runtime checkout. Do not pass this
    return value to ``websockets.serve``.
    """
    return DEFAULT_ALLOWED_ORIGINS
