/**
 * Per-target WebSocket auth token storage shared by all pages.
 *
 * Tokens are keyed by "host:port" so each backend server (local TWS, each
 * cloud VM) keeps its own token, mirroring how WS targets are already
 * distinguished by address. Stored in localStorage like the WS host/port.
 */

(function attachWsAuthClient(globalScope) {
    const STORAGE_KEY = 'optionComboWsAuthTokens';

    function _getStorage() {
        try {
            return globalScope.localStorage || null;
        } catch (e) {
            return null;
        }
    }

    function buildTargetKey(host, port) {
        const safeHost = String(host || '').trim().toLowerCase();
        const safePort = String(port || '').trim();
        return `${safeHost}:${safePort}`;
    }

    function _readTokenMap() {
        const storage = _getStorage();
        if (!storage) return {};
        try {
            const parsed = JSON.parse(storage.getItem(STORAGE_KEY) || '{}');
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
        } catch (e) {
            return {};
        }
    }

    function _writeTokenMap(map) {
        const storage = _getStorage();
        if (!storage) return false;
        try {
            storage.setItem(STORAGE_KEY, JSON.stringify(map || {}));
            return true;
        } catch (e) {
            return false;
        }
    }

    function getTokenForTarget(host, port) {
        const token = _readTokenMap()[buildTargetKey(host, port)];
        return typeof token === 'string' ? token : '';
    }

    function setTokenForTarget(host, port, token) {
        const map = _readTokenMap();
        const key = buildTargetKey(host, port);
        const trimmed = String(token || '').trim();
        if (trimmed) {
            map[key] = trimmed;
        } else {
            delete map[key];
        }
        return _writeTokenMap(map);
    }

    function buildAuthenticateMessage(token) {
        return {
            action: 'authenticate',
            token: String(token || ''),
        };
    }

    function sendAuthTokenIfAvailable(socket, host, port) {
        if (!socket || typeof socket.send !== 'function') {
            return false;
        }
        const token = getTokenForTarget(host, port);
        if (!token) {
            return false;
        }
        socket.send(JSON.stringify(buildAuthenticateMessage(token)));
        return true;
    }

    globalScope.OptionComboWsAuthClient = {
        buildTargetKey,
        getTokenForTarget,
        setTokenForTarget,
        buildAuthenticateMessage,
        sendAuthTokenIfAvailable,
    };
})(typeof globalThis !== 'undefined' ? globalThis : window);
