const assert = require('node:assert/strict');

const { loadBrowserScripts } = require('./helpers/load-browser-scripts');

function createLocalStorageStub(initial = {}) {
    const store = { ...initial };
    return {
        getItem(key) {
            return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null;
        },
        setItem(key, value) {
            store[key] = String(value);
        },
        removeItem(key) {
            delete store[key];
        },
        _store: store,
    };
}

function loadApi(localStorage) {
    const ctx = loadBrowserScripts(['js/ws_auth_client.js'], { localStorage });
    return ctx.OptionComboWsAuthClient;
}

module.exports = {
    name: 'ws_auth_client.js',
    tests: [
        {
            name: 'stores one token per host:port target',
            run() {
                const storage = createLocalStorageStub();
                const api = loadApi(storage);

                api.setTokenForTarget('127.0.0.1', 8765, 'local-token');
                api.setTokenForTarget('100.64.1.2', 8765, 'vm-a-token');
                api.setTokenForTarget('100.64.1.3', 8765, 'vm-b-token');

                assert.equal(api.getTokenForTarget('127.0.0.1', 8765), 'local-token');
                assert.equal(api.getTokenForTarget('100.64.1.2', 8765), 'vm-a-token');
                assert.equal(api.getTokenForTarget('100.64.1.3', 8765), 'vm-b-token');
                assert.equal(api.getTokenForTarget('100.64.1.4', 8765), '');
            },
        },
        {
            name: 'normalizes target keys and trims tokens; empty token deletes the entry',
            run() {
                const storage = createLocalStorageStub();
                const api = loadApi(storage);

                api.setTokenForTarget(' My-Host.Tailnet.TS.NET ', '8765', '  spaced-token  ');
                assert.equal(api.getTokenForTarget('my-host.tailnet.ts.net', 8765), 'spaced-token');

                api.setTokenForTarget('my-host.tailnet.ts.net', 8765, '   ');
                assert.equal(api.getTokenForTarget('my-host.tailnet.ts.net', 8765), '');
            },
        },
        {
            name: 'survives corrupted storage payloads',
            run() {
                const storage = createLocalStorageStub({ optionComboWsAuthTokens: 'not-json{{' });
                const api = loadApi(storage);

                assert.equal(api.getTokenForTarget('127.0.0.1', 8765), '');
                assert.equal(api.setTokenForTarget('127.0.0.1', 8765, 'fresh'), true);
                assert.equal(api.getTokenForTarget('127.0.0.1', 8765), 'fresh');
            },
        },
        {
            name: 'sends the authenticate message only when a token exists',
            run() {
                const storage = createLocalStorageStub();
                const api = loadApi(storage);
                const sent = [];
                const socket = { send(message) { sent.push(JSON.parse(message)); } };

                assert.equal(api.sendAuthTokenIfAvailable(socket, '127.0.0.1', 8765), false);
                assert.equal(sent.length, 0);

                api.setTokenForTarget('127.0.0.1', 8765, 'local-token');
                assert.equal(api.sendAuthTokenIfAvailable(socket, '127.0.0.1', 8765), true);
                assert.deepEqual(sent, [{ action: 'authenticate', token: 'local-token' }]);
            },
        },
    ],
};
