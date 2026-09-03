"""Shared WebSocket protocol layer for the blended-cost ledger.

Both backends route the same client actions through here so Live and
Historical answer with identical response shapes and error codes. This
module owns loopback enforcement, request validation, and the sync-store to
event-loop bridge (asyncio.to_thread); it never writes SQL itself and never
leaks database paths or raw SQL errors to the browser.

A raised exception must never escape handle_cost_basis_action(): one bad
ledger request must not tear down a socket that is also carrying live
market data and order supervision.

The ledger is a write path for money records, so two rules hold here as
well as in the store: every write carries a client token, event/reset writes
are replay-safe, and nothing in this protocol writes an event the operator
did not confirm in the page. Permanent whole-book deletion cannot retain a
durable idempotency receipt without retaining data about the deleted book;
a retry is still target-safe because the immutable book id no longer exists.
"""

import asyncio
import ipaddress
import json
import logging
import threading
import time

from cost_basis_store import (
    CostBasisStore,
    CostBasisStoreError,
    EVENT_KINDS,
    InvalidRequestError,
    MAX_IMPORT_EVENTS,
    SCHEMA_USER_VERSION,
    resolve_db_path,
)

logger = logging.getLogger('cost_basis.ws')
OPTION_SCENARIO_INPUT_TIMEOUT_SECONDS = 15.0

SERVER_ACTIONS = {
    'request_cost_basis_status': 'cost_basis_status',
    'list_cost_basis_books': 'cost_basis_books_list',
    'create_cost_basis_book': 'cost_basis_book_created',
    'archive_cost_basis_book': 'cost_basis_book_archived',
    'request_cost_basis_delete_plan': 'cost_basis_delete_plan',
    'delete_cost_basis_book': 'cost_basis_book_deleted',
    'list_cost_basis_events': 'cost_basis_events_list',
    'append_cost_basis_event': 'cost_basis_event_appended',
    'void_cost_basis_event': 'cost_basis_event_voided',
    'import_cost_basis_events': 'cost_basis_events_imported',
    'save_cost_basis_snapshot': 'cost_basis_snapshot_saved',
    'list_cost_basis_snapshots': 'cost_basis_snapshots_list',
    'request_cost_basis_reset_plan': 'cost_basis_reset_plan',
    'reset_cost_basis_book': 'cost_basis_book_reset',
    'rebuild_cost_basis_book': 'cost_basis_book_rebuilt',
    'list_cost_basis_resets': 'cost_basis_resets_list',
    'request_cost_basis_executions': 'cost_basis_executions',
    'request_cost_basis_market_price': 'cost_basis_market_price',
    'request_cost_basis_option_scenario_inputs': 'cost_basis_option_scenario_inputs',
}

COST_BASIS_CLIENT_ACTIONS = frozenset(SERVER_ACTIONS)


def create_store_env(config=None):
    """Describe the ledger store without touching the filesystem.

    Cheap enough to run at module import. The database is opened lazily on
    the first loopback request; a failure only disables the ledger while
    market data, replay, and IB keep running.
    """
    enabled = True
    if config is not None:
        try:
            enabled = config.getboolean('cost_basis', 'enabled', fallback=True)
        except ValueError:
            enabled = True
    return {
        '_config': config,
        '_enabled': enabled,
        '_init_lock': threading.Lock(),
        '_initialized': False,
        'store': None,
        'available': False,
        'reason': '' if enabled else 'disabled',
    }


def ensure_store_initialized(store_env):
    """Open (or create) the ledger once, from a worker thread. Idempotent
    and never raises."""
    if store_env is None:
        return None
    lock = store_env.get('_init_lock')
    if lock is None:
        return store_env
    with lock:
        if store_env.get('_initialized'):
            return store_env
        store_env['_initialized'] = True
        if not store_env.get('_enabled', True):
            logger.info('cost basis ledger disabled by configuration')
            return store_env
        try:
            db_path = resolve_db_path(config=store_env.get('_config'))
            store = CostBasisStore(db_path).initialize()
        except CostBasisStoreError as exc:
            logger.error(
                'cost basis ledger unavailable (%s): %s — market data and '
                'replay continue; fix the database location and restart.',
                exc.code, exc,
            )
            store_env['reason'] = exc.code
            return store_env
        store_env['store'] = store
        store_env['available'] = True
        store_env['reason'] = ''
        logger.info('cost basis ledger ready at %s', store.db_path)
        return store_env


def is_loopback_address(remote_address):
    """Strict loopback check; fails closed on anything unparseable."""
    try:
        host = remote_address[0]
    except (TypeError, IndexError, KeyError):
        return False
    if not isinstance(host, str) or not host:
        return False
    candidate = host.strip().lower()
    if '%' in candidate:  # scoped IPv6 like fe80::1%lo0
        candidate = candidate.split('%', 1)[0]
    try:
        ip = ipaddress.ip_address(candidate)
    except ValueError:
        return False
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    return ip.is_loopback


async def handle_cost_basis_action(store_env, websocket, data, *,
                                   client_ip='Unknown', send=None):
    """Answer a ledger action. Returns True when the action belonged to this
    protocol (a response was sent), False otherwise."""
    action = data.get('action') if isinstance(data, dict) else None
    if action not in COST_BASIS_CLIENT_ACTIONS:
        return False
    try:
        response = await build_cost_basis_response(
            store_env, websocket, data, client_ip=client_ip
        )
    except Exception:
        logger.exception('cost basis handler failed for action %r', action)
        response = _error_response(
            SERVER_ACTIONS[action], _request_id(data),
            'internal_store_error', 'internal store error',
        )
    try:
        message = json.dumps(response)
        if send is not None:
            await send(websocket, message)
        else:
            await websocket.send(message)
    except Exception:
        logger.warning('failed to send cost basis response for %r', action)
    return True


async def build_cost_basis_response(store_env, websocket, data, *,
                                    client_ip='Unknown'):
    action = data.get('action')
    server_action = SERVER_ACTIONS[action]
    request_id = _request_id(data)
    started = time.monotonic()

    store_env = store_env or {}
    if not is_loopback_address(getattr(websocket, 'remote_address', None)):
        logger.warning(
            'rejected non-loopback cost basis request %s from %s', action, client_ip)
        if action == 'request_cost_basis_status':
            # No path, schema, or availability detail crosses the boundary.
            return {
                'action': server_action,
                'requestId': request_id,
                'success': True,
                'available': False,
                'reason': 'remote_access_disabled',
            }
        return _error_response(
            server_action, request_id,
            'remote_access_disabled', 'the cost basis ledger is loopback-only',
        )

    if not store_env.get('_initialized') and store_env.get('_init_lock') is not None:
        await asyncio.to_thread(ensure_store_initialized, store_env)

    store = store_env.get('store')
    if action == 'request_cost_basis_status':
        response = {
            'action': server_action,
            'requestId': request_id,
            'success': True,
            'available': store is not None,
        }
        if store is None:
            response['reason'] = store_env.get('reason') or 'store_unavailable'
        else:
            response['storeSchemaVersion'] = SCHEMA_USER_VERSION
            response['eventKinds'] = list(EVENT_KINDS)
            response['maxImportEvents'] = MAX_IMPORT_EVENTS
            response['features'] = {
                'optionScenarioInputs': callable(
                    store_env.get('fetch_option_scenario_inputs')),
            }
        return response

    if store is None:
        return _error_response(
            server_action, request_id,
            store_env.get('reason') or 'store_unavailable',
            'the cost basis ledger is unavailable',
        )

    if action == 'request_cost_basis_executions':
        fetcher = store_env.get('fetch_executions')
        if not callable(fetcher):
            return _error_response(
                server_action, request_id, 'broker_execution_history_unavailable',
                'this backend cannot request TWS executions',
            )
        try:
            book = await asyncio.to_thread(
                store.get_book, _required_str(data, 'bookId'))
            result = await fetcher({
                'account': book['account'],
                'symbol': book['symbol'],
                'secType': book['secType'],
                'sinceTimestamp': data.get('sinceTimestamp') or '',
            })
        except CostBasisStoreError as exc:
            _log_result(action, request_id, data, started, error=exc.code)
            return _error_response(server_action, request_id, exc.code, str(exc))
        except Exception:
            logger.exception('TWS execution-history request failed')
            return _error_response(
                server_action, request_id, 'broker_execution_history_failed',
                'failed to request recent TWS executions',
            )
        response = {'action': server_action, 'requestId': request_id, 'success': True}
        response.update(result)
        _log_result(action, request_id, data, started, result=result)
        return response

    if action == 'request_cost_basis_market_price':
        fetcher = store_env.get('fetch_market_price')
        if not callable(fetcher):
            return _error_response(
                server_action, request_id, 'broker_market_price_unavailable',
                'this backend cannot request a fresh TWS market price',
            )
        try:
            book = await asyncio.to_thread(
                store.get_book, _required_str(data, 'bookId'))
            result = await fetcher({
                'account': book['account'],
                'symbol': book['symbol'],
                'secType': book['secType'],
                'currency': book['currency'],
            })
        except CostBasisStoreError as exc:
            _log_result(action, request_id, data, started, error=exc.code)
            return _error_response(server_action, request_id, exc.code, str(exc))
        except Exception:
            logger.exception('fresh TWS market-price request failed')
            return _error_response(
                server_action, request_id, 'broker_market_price_failed',
                'failed to request a fresh TWS market price',
            )
        response = {'action': server_action, 'requestId': request_id, 'success': True}
        response.update(result)
        _log_result(action, request_id, data, started, result=result)
        return response

    if action == 'request_cost_basis_option_scenario_inputs':
        fetcher = store_env.get('fetch_option_scenario_inputs')
        if not callable(fetcher):
            return _error_response(
                server_action, request_id, 'broker_option_scenario_inputs_unavailable',
                'this backend cannot request TWS option scenario inputs',
            )
        raw_contracts = data.get('contracts')
        if not isinstance(raw_contracts, list) or len(raw_contracts) > 128:
            return _error_response(
                server_action, request_id, 'invalid_request',
                'contracts must be a list with at most 128 rows',
            )
        contracts = []
        for raw in raw_contracts:
            if not isinstance(raw, dict):
                return _error_response(
                    server_action, request_id, 'invalid_request',
                    'each contract request must be an object',
                )
            contracts.append({
                'conId': raw.get('conId'),
                'localSymbol': str(raw.get('localSymbol') or '').strip()[:96],
                'right': str(raw.get('right') or '').strip().upper()[:1],
                'strike': raw.get('strike'),
                'expiry': ''.join(
                    character for character in str(raw.get('expiry') or '')
                    if character.isdigit())[:8],
            })
        try:
            book = await asyncio.to_thread(
                store.get_book, _required_str(data, 'bookId'))
            result = await asyncio.wait_for(fetcher({
                    'account': book['account'],
                    'symbol': book['symbol'],
                    'secType': book['secType'],
                    'currency': book['currency'],
                    'throughExpiry': ''.join(
                        character for character in str(data.get('throughExpiry') or '')
                        if character.isdigit())[:8],
                    'contracts': contracts,
                }), timeout=OPTION_SCENARIO_INPUT_TIMEOUT_SECONDS)
        except CostBasisStoreError as exc:
            _log_result(action, request_id, data, started, error=exc.code)
            return _error_response(server_action, request_id, exc.code, str(exc))
        except asyncio.TimeoutError:
            _log_result(
                action, request_id, data, started,
                error='broker_option_scenario_inputs_timeout')
            return _error_response(
                server_action, request_id,
                'broker_option_scenario_inputs_timeout',
                'TWS option inputs exceeded the 15-second server deadline',
            )
        except ValueError as exc:
            return _error_response(
                server_action, request_id, 'invalid_request', str(exc),
            )
        except Exception:
            logger.exception('TWS option scenario-input request failed')
            return _error_response(
                server_action, request_id, 'broker_option_scenario_inputs_failed',
                'failed to request current TWS option IV or discount inputs',
            )
        response = {'action': server_action, 'requestId': request_id, 'success': True}
        response.update(result)
        _log_result(action, request_id, data, started, result=result)
        return response

    try:
        result = await _dispatch_store_call(store, action, data)
    except CostBasisStoreError as exc:
        _log_result(action, request_id, data, started, error=exc.code)
        return _error_response(server_action, request_id, exc.code, str(exc))
    except Exception:
        logger.exception('unexpected ledger failure for action %r', action)
        _log_result(action, request_id, data, started, error='internal_store_error')
        return _error_response(
            server_action, request_id, 'internal_store_error', 'internal store error'
        )

    response = {'action': server_action, 'requestId': request_id, 'success': True}
    response.update(result)
    _log_result(action, request_id, data, started, result=result)
    return response


async def _dispatch_store_call(store, action, data):
    if action == 'list_cost_basis_books':
        books = await asyncio.to_thread(
            lambda: store.list_books(
                include_archived=data.get('includeArchived') is True)
        )
        return {'books': books}

    if action == 'create_cost_basis_book':
        book = await asyncio.to_thread(
            lambda: store.create_book(
                account=_required_str(data, 'account'),
                symbol=_required_str(data, 'symbol'),
                start_date=_required_str(data, 'startDate'),
                sec_type=data.get('secType') or 'STK',
                currency=data.get('currency') or 'USD',
                default_shares_per_contract=(
                    data.get('defaultSharesPerContract') or 100),
                note=data.get('note') or '',
            )
        )
        return {'book': book}

    if action == 'archive_cost_basis_book':
        book = await asyncio.to_thread(
            store.archive_book, _required_str(data, 'bookId'))
        return {'book': book}

    if action == 'request_cost_basis_delete_plan':
        return await asyncio.to_thread(
            store.delete_confirmation, _required_str(data, 'bookId'))

    if action == 'delete_cost_basis_book':
        # A full deletion is intentionally separate from reset/rebuild: it
        # removes events, snapshots, reset archives and the book row itself.
        # The store rechecks the count-bearing phrase under the write lock.
        return await asyncio.to_thread(
            lambda: store.delete_book(
                _required_str(data, 'bookId'),
                confirmation=_required_str(data, 'confirmation'),
                client_token=_required_str(data, 'clientToken'),
            )
        )

    if action == 'list_cost_basis_events':
        return await asyncio.to_thread(
            lambda: store.list_events(
                _required_str(data, 'bookId'),
                account=data.get('account') or None,
                kinds=_optional_list(data, 'kinds'),
                start_date=data.get('startDate') or None,
                end_date=data.get('endDate') or None,
                include_voided=data.get('includeVoided') is True,
                limit=_optional_int(data, 'limit'),
                offset=_optional_int(data, 'offset') or 0,
            )
        )

    if action == 'append_cost_basis_event':
        return await asyncio.to_thread(
            lambda: store.append_event(
                _required_str(data, 'bookId'),
                _required_object(data, 'event'),
                client_token=_required_str(data, 'clientToken'),
                allow_overdraw=data.get('allowOverdraw') is True,
            )
        )

    if action == 'void_cost_basis_event':
        return await asyncio.to_thread(
            lambda: store.void_event(
                _required_str(data, 'bookId'),
                _required_str(data, 'eventId'),
                reason=_required_str(data, 'reason'),
                client_token=_required_str(data, 'clientToken'),
            )
        )

    if action == 'import_cost_basis_events':
        events = data.get('events')
        supersede_tws_event_ids = data.get('supersedeTwsEventIds', [])
        tws_reconciliation = data.get('twsReconciliation')
        if not isinstance(events, list):
            raise InvalidRequestError('events must be a list')
        if not isinstance(supersede_tws_event_ids, list):
            raise InvalidRequestError('supersedeTwsEventIds must be a list')
        if len(events) > MAX_IMPORT_EVENTS:
            raise InvalidRequestError(
                f'an import batch is limited to {MAX_IMPORT_EVENTS} rows')
        return await asyncio.to_thread(
            lambda: store.import_events(
                _required_str(data, 'bookId'),
                events,
                import_batch_id=_required_str(data, 'importBatchId'),
                client_token_prefix=_required_str(data, 'clientTokenPrefix'),
                allow_overdraw=data.get('allowOverdraw') is True,
                supersede_tws_event_ids=supersede_tws_event_ids,
                tws_reconciliation=tws_reconciliation,
            )
        )

    if action == 'request_cost_basis_reset_plan':
        plan = await asyncio.to_thread(
            store.reset_confirmation, _required_str(data, 'bookId'))
        return plan

    if action == 'reset_cost_basis_book':
        # The recoverable path that deletes active events. Whole-book
        # deletion is a separate, explicitly permanent operation. This
        # phrase is still validated inside the write transaction against the
        # live count, so a stale plan cannot lose unseen rows.
        return await asyncio.to_thread(
            lambda: store.reset_book(
                _required_str(data, 'bookId'),
                confirmation=_required_str(data, 'confirmation'),
                client_token=_required_str(data, 'clientToken'),
                reason=data.get('reason') or '',
            )
        )

    if action == 'rebuild_cost_basis_book':
        # Archive, wipe and refill in one transaction. Never expose this as
        # two calls: a failure between them would leave an empty ledger.
        events = data.get('events')
        if not isinstance(events, list):
            raise InvalidRequestError('events must be a list')
        if len(events) > MAX_IMPORT_EVENTS:
            raise InvalidRequestError(
                f'a rebuild is limited to {MAX_IMPORT_EVENTS} rows')
        return await asyncio.to_thread(
            lambda: store.rebuild_book(
                _required_str(data, 'bookId'),
                events,
                confirmation=_required_str(data, 'confirmation'),
                client_token=_required_str(data, 'clientToken'),
                import_batch_id=_required_str(data, 'importBatchId'),
                allow_overdraw=data.get('allowOverdraw') is True,
                reason=data.get('reason') or '',
            )
        )

    if action == 'list_cost_basis_resets':
        resets = await asyncio.to_thread(
            lambda: store.list_book_resets(
                _required_str(data, 'bookId'),
                limit=_optional_int(data, 'limit') or 20,
            )
        )
        return {'resets': resets}

    if action == 'save_cost_basis_snapshot':
        snapshot = await asyncio.to_thread(
            lambda: store.save_snapshot(
                _required_str(data, 'bookId'),
                as_of_date=_required_str(data, 'asOfDate'),
                summary=_required_object(data, 'summary'),
                account_scope=data.get('accountScope') or '',
                tws_snapshot=data.get('twsSnapshot'),
                reconciled=data.get('reconciled') is True,
                note=data.get('note') or '',
            )
        )
        return {'snapshot': snapshot}

    if action == 'list_cost_basis_snapshots':
        snapshots = await asyncio.to_thread(
            lambda: store.list_snapshots(
                _required_str(data, 'bookId'),
                limit=_optional_int(data, 'limit') or 50,
            )
        )
        return {'snapshots': snapshots}

    raise InvalidRequestError(f'unhandled cost basis action {action}')


def _request_id(data):
    request_id = data.get('requestId') if isinstance(data, dict) else None
    return request_id if isinstance(request_id, str) else ''


def _required_str(data, field):
    value = data.get(field)
    if not isinstance(value, str) or not value:
        raise InvalidRequestError(f'{field} is required')
    return value


def _required_object(data, field):
    value = data.get(field)
    if not isinstance(value, dict):
        raise InvalidRequestError(f'{field} must be an object')
    return value


def _optional_list(data, field):
    value = data.get(field)
    if value is None:
        return None
    if not isinstance(value, list):
        raise InvalidRequestError(f'{field} must be a list')
    return value


def _optional_int(data, field):
    value = data.get(field)
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int):
        raise InvalidRequestError(f'{field} must be an integer')
    return value


def _error_response(server_action, request_id, code, message):
    return {
        'action': server_action,
        'requestId': request_id,
        'success': False,
        'code': code,
        'message': message,
    }


def _log_result(action, request_id, data, started, result=None, error=None):
    elapsed_ms = int((time.monotonic() - started) * 1000)
    book_id = data.get('bookId', '') if isinstance(data, dict) else ''
    if error is not None:
        logger.warning(
            'cost basis %s request=%s book=%s failed code=%s in %dms',
            action, request_id, book_id, error, elapsed_ms,
        )
        return
    detail = ''
    if isinstance(result, dict):
        if 'inserted' in result:
            detail = f"inserted={result.get('inserted')} skipped={result.get('skipped')}"
        elif isinstance(result.get('event'), dict):
            detail = f"seq={result['event'].get('seq', '')}"
        elif 'total' in result:
            detail = f"total={result.get('total')}"
    logger.info(
        'cost basis %s request=%s book=%s %s ok in %dms',
        action, request_id, book_id, detail, elapsed_ms,
    )
