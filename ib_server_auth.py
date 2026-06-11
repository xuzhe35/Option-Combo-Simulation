"""WebSocket authentication helpers: token storage, origin allowlisting, action gating.

Threat model notes:
- Tailscale (WireGuard) already authenticates and encrypts the network path, so a
  static per-server token over plain ws:// is sound inside the tailnet; the token
  authorizes the client, it does not need to provide transport secrecy.
- The Origin allowlist exists because WebSocket is not subject to the browser
  same-origin policy: any web page visited on a trusted device can open a socket
  to this server. Browsers always send Origin and scripts cannot forge it.
"""

from __future__ import annotations

import hmac
import logging
import os
import secrets
from urllib.parse import urlsplit


LOOPBACK_HOSTS = {'127.0.0.1', 'localhost', '::1', '[::1]'}

DEFAULT_ALLOWED_ORIGIN_HOSTS = {'127.0.0.1', 'localhost', '::1'}

# Actions an unauthenticated client may still call while auth is required.
# Everything else is rejected until the session presents the token.
UNAUTHENTICATED_ACTIONS = {
    'authenticate',
    'request_ib_connection_status',
}

# Actions that place, extend, or reprice real broker orders. Blocked when the
# server-side live-order switch is off. Cancels stay allowed on purpose: the
# kill switch must never prevent getting OUT of an order.
LIVE_ORDER_ACTIONS = {
    'submit_combo_order',
    'resume_managed_combo_order',
    'concede_managed_combo_order',
    'submit_hedge_order',
}

COMBO_ACTIONS = {
    'validate_combo_order',
    'preview_combo_order',
    'submit_combo_order',
    'resume_managed_combo_order',
    'concede_managed_combo_order',
    'cancel_managed_combo_order',
}

HEDGE_ACTIONS = {
    'validate_hedge_order',
    'preview_hedge_order',
    'submit_hedge_order',
    'cancel_hedge_order',
}

MAX_FAILED_AUTH_ATTEMPTS = 5

AUTH_REQUIRED_MESSAGE = (
    'Authentication required. Paste this server\'s auth token into the WS Target '
    'panel (see the server log for the token file path).'
)

LIVE_ORDERS_DISABLED_MESSAGE = (
    'Live order routing is disabled on this server ([execution] allow_live_orders = false).'
)


def load_or_create_token(path, logger=None):
    """Read the shared auth token from disk, creating it on first run.

    The token persists across restarts so the browser-side paste is a one-time
    setup per server. Returns an empty string only if the file cannot be read
    or written, which leaves auth fail-closed when enforcement is on.
    """
    log = logger or logging.getLogger(__name__)
    resolved_path = os.path.abspath(path)
    try:
        with open(resolved_path, 'r', encoding='utf-8') as handle:
            token = handle.read().strip()
        if token:
            return token
        log.warning("Auth token file %s is empty; generating a new token.", resolved_path)
    except FileNotFoundError:
        pass
    except OSError:
        log.exception("Unable to read auth token file %s", resolved_path)
        return ''

    token = secrets.token_urlsafe(32)
    try:
        parent_dir = os.path.dirname(resolved_path)
        if parent_dir:
            os.makedirs(parent_dir, exist_ok=True)
        descriptor = os.open(resolved_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(descriptor, 'w', encoding='utf-8') as handle:
            handle.write(token + '\n')
    except OSError:
        log.exception("Unable to write auth token file %s", resolved_path)
        return ''

    log.info("Generated new WebSocket auth token at %s", resolved_path)
    return token


def is_loopback_host(host):
    return str(host or '').strip().lower() in LOOPBACK_HOSTS


def resolve_auth_required(mode, ws_hosts):
    """Decide whether token auth is enforced.

    auto   - required as soon as any bind address is non-loopback (the
             Tailscale / LAN case); loopback-only keeps today's behavior.
    always - required regardless of bind addresses.
    never  - never required (token is still accepted if presented).
    """
    normalized = str(mode or 'auto').strip().lower()
    if normalized == 'always':
        return True
    if normalized == 'never':
        return False
    return any(not is_loopback_host(host) for host in ws_hosts or [])


def parse_extra_origin_hosts(raw_value):
    hosts = set()
    for candidate in str(raw_value or '').split(','):
        host = candidate.strip().lower()
        if host:
            hosts.add(host)
    return hosts


def build_allowed_origin_hosts(ws_hosts, extra_hosts_raw=''):
    """Loopback hosts, the server's own bind addresses, plus configured extras.

    Including the bind addresses means a page served from the same machine as
    the backend (http://<tailscale-ip>:8000) passes without extra config.
    """
    allowed = set(DEFAULT_ALLOWED_ORIGIN_HOSTS)
    for host in ws_hosts or []:
        normalized = str(host or '').strip().lower().strip('[]')
        if normalized:
            allowed.add(normalized)
    allowed |= parse_extra_origin_hosts(extra_hosts_raw)
    return allowed


def extract_origin_host(origin):
    """Return the lowercased host part of an Origin header value, or ''."""
    raw = str(origin or '').strip()
    if not raw or raw.lower() == 'null':
        return ''
    try:
        return (urlsplit(raw).hostname or '').lower()
    except ValueError:
        return ''


def is_origin_allowed(origin, allowed_hosts):
    """Browser pages must come from an allowlisted host.

    A missing Origin header means a non-browser client (scripts, monitors);
    those are allowed through the handshake and gated by the token instead.
    An unparsable or 'null' Origin is rejected: it is a browser context we
    cannot identify.
    """
    if origin is None or str(origin).strip() == '':
        return True
    host = extract_origin_host(origin)
    if not host:
        return False
    return host in (allowed_hosts or set())


def verify_token(expected_token, provided_token):
    expected = str(expected_token or '')
    provided = str(provided_token or '')
    if not expected or not provided:
        return False
    return hmac.compare_digest(expected, provided)


def build_auth_status_payload(required, authenticated, message=''):
    payload = {
        'action': 'auth_status',
        'authRequired': bool(required),
        'authenticated': bool(authenticated),
    }
    if message:
        payload['message'] = message
    return payload


def build_auth_result_payload(ok, required, message=''):
    payload = {
        'action': 'auth_result',
        'ok': bool(ok),
        'authRequired': bool(required),
        'authenticated': bool(ok),
    }
    if message:
        payload['message'] = message
    return payload


def build_action_rejected_payload(data, message):
    """Shape a rejection so the existing UI error surfaces pick it up."""
    request_data = data if isinstance(data, dict) else {}
    action = request_data.get('action')
    if action in COMBO_ACTIONS:
        return {
            'action': 'combo_order_error',
            'groupId': request_data.get('groupId'),
            'message': message,
            'requestAction': action,
        }
    if action in HEDGE_ACTIONS:
        return {
            'action': 'hedge_order_error',
            'hedgeId': request_data.get('hedgeId'),
            'message': message,
            'requestAction': action,
        }
    return {
        'action': 'auth_error',
        'requestAction': action,
        'message': message,
    }
