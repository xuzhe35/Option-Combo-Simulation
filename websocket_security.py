"""Browser-origin boundary shared by both WebSocket backends.

Binding to loopback prevents direct remote TCP access, but it doesn't stop a
hostile web page open in the same browser from connecting to localhost.  An
exact Origin allow-list closes that cross-site WebSocket path before any JSON
action (including persistence, ledger administration, or execution) is read.
"""

import os
from urllib.parse import urlsplit


DEFAULT_ALLOWED_ORIGINS = (
    'http://localhost:8000',
    'http://127.0.0.1:8000',
    'http://[::1]:8000',
)


def _normalize_origin(value):
    raw = str(value or '').strip()
    if not raw or raw.lower() == 'null':
        raise ValueError('WebSocket allowed origins must be explicit http(s) origins')
    if '*' in raw or any(character.isspace() for character in raw):
        raise ValueError('WebSocket allowed origins cannot contain wildcards or whitespace')
    parsed = urlsplit(raw)
    if parsed.scheme.lower() not in ('http', 'https') or not parsed.hostname:
        raise ValueError(f'invalid WebSocket allowed origin: {raw!r}')
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError(f'invalid WebSocket allowed origin: {raw!r}')
    if parsed.path not in ('', '/'):
        raise ValueError(f'WebSocket allowed origin must not contain a path: {raw!r}')
    try:
        port = parsed.port
    except ValueError as exc:
        raise ValueError(f'invalid WebSocket allowed origin: {raw!r}') from exc

    host = parsed.hostname.lower()
    if ':' in host:
        host = f'[{host}]'
    authority = host if port is None else f'{host}:{port}'
    return f'{parsed.scheme.lower()}://{authority}'


def read_allowed_ws_origins(config, env=None):
    """Return validated exact browser origins for ``websockets.serve``.

    ``None`` is intentionally absent: non-browser clients must also identify
    an approved origin instead of silently bypassing the browser boundary.
    """
    env = os.environ if env is None else env
    fallback = ','.join(DEFAULT_ALLOWED_ORIGINS)
    configured = (config.get('server', 'allowed_origins', fallback=fallback)
                  if config is not None else fallback)
    # Read directly in both backends: old Docker overlays need no new key mapping.
    raw = str(env.get('OPTION_COMBO_WS_ALLOWED_ORIGINS') or '').strip() or configured
    values = []
    for candidate in str(raw or '').replace('\n', ',').split(','):
        if not candidate.strip():
            continue
        origin = _normalize_origin(candidate)
        if origin not in values:
            values.append(origin)
    if not values:
        raise ValueError('server.allowed_origins must contain at least one origin')
    return tuple(values)
