'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { MelPumpApi } = require('./helpers');

/**
 * A local stand-in for melpump.com. `handler(req, res, body)` answers each request.
 */
async function server(handler) {
  const requests = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      handler(req, res, body);
    });
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  return {
    requests,
    url: `http://127.0.0.1:${srv.address().port}`,
    close: () => {
      srv.closeAllConnections();
      return new Promise((resolve) => srv.close(resolve));
    },
  };
}

const json = (res, status, data) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
};

test('requests carry the token and parse JSON; current state drops fullExternalData', async () => {
  const srv = await server((req, res) => json(res, 200, { state: { Power: true }, dataQuality: 0, fullExternalData: { big: 1 } }));
  try {
    const api = new MelPumpApi({ apiKey: 'api_secret', baseUrl: srv.url });
    const status = await api.getDeviceStatus('42');
    assert.deepStrictEqual(status, { state: { Power: true }, dataQuality: 0 });
    assert.strictEqual(srv.requests[0].url, '/api/devices/42/current-state');
    assert.strictEqual(srv.requests[0].headers.authorization, 'Bearer api_secret');
  } finally {
    await srv.close();
  }
});

test('the device list keeps only devices the token can read', async () => {
  const srv = await server((req, res) => json(res, 200, [
    { readAccess: true, writeAccess: true, device: { id: 1, name: 'Pump' } },
    { readAccess: false, writeAccess: false, device: { id: 2, name: 'Other' } },
    { readAccess: true, device: { id: 3 } },
  ]));
  try {
    const devices = await new MelPumpApi({ apiKey: 'api_x', baseUrl: srv.url }).getDevices();
    assert.deepStrictEqual(devices.map((d) => [d.id, d.name, d.writeAccess]), [['1', 'Pump', true], ['3', 'MelPump 3', false]]);
  } finally {
    await srv.close();
  }
});

test('changes are POSTed as JSON and need success: true', async () => {
  let reply = { success: true };
  const srv = await server((req, res) => json(res, 200, reply));
  try {
    const api = new MelPumpApi({ apiKey: 'api_x', baseUrl: srv.url });
    await api.setDeviceSettings('42', { temperatureZone1: 21.5 });
    assert.strictEqual(srv.requests[0].method, 'POST');
    assert.strictEqual(srv.requests[0].url, '/api/change-temperature/42');
    assert.deepStrictEqual(JSON.parse(srv.requests[0].body), { temperatureZone1: 21.5 });

    reply = { success: false };
    await assert.rejects(api.setDeviceState('42', { power: false }), /did not accept/);
    await assert.rejects(api.setDeviceState('42', {}), /No settings provided/);
    await assert.rejects(api.acknowledgeAlarm('42', '1/../2'), /Invalid alarm id/);
    assert.strictEqual(srv.requests.length, 2, 'invalid input is not sent');
  } finally {
    await srv.close();
  }
});

test('HTTP errors become clear messages with flags', async () => {
  let status = 401;
  const srv = await server((req, res) => json(res, status, { message: 'from api' }));
  try {
    const api = new MelPumpApi({ apiKey: 'api_x', baseUrl: srv.url });
    const failure = () => api.getDevice('42').then(() => null, (err) => err);

    let err = await failure();
    assert.ok(err.isAuthError);
    assert.match(err.message, /rejected the API token/);

    status = 403;
    err = await failure();
    assert.ok(err.isAuthError);
    assert.strictEqual(err.status, 403);

    status = 429;
    err = await failure();
    assert.ok(err.isRateLimited);

    status = 500;
    err = await failure();
    assert.strictEqual(err.message, 'from api');
  } finally {
    await srv.close();
  }
});

test('a response that stalls after the headers times out', async () => {
  const srv = await server((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write('{"state":');
    // ...and never finishes.
  });
  try {
    const api = new MelPumpApi({ apiKey: 'api_x', baseUrl: srv.url, timeout: 200 });
    const started = Date.now();
    await assert.rejects(api.getDevice('42'), /timed out/);
    assert.ok(Date.now() - started < 2000);
  } finally {
    await srv.close();
  }
});

test('no request without a token; debug logging never shows the token', async () => {
  await assert.rejects(new MelPumpApi({ apiKey: '' }).getDevice('1'), (err) => err.isAuthError);
  assert.strictEqual(MelPumpApi.isValidKeyFormat('api_abc'), true);
  assert.strictEqual(MelPumpApi.isValidKeyFormat('abc'), false);

  const srv = await server((req, res) => json(res, 200, { id: 42 }));
  try {
    const lines = [];
    const api = new MelPumpApi({ apiKey: 'api_secret', baseUrl: srv.url, debug: (line) => lines.push(line) });
    await api.getDevice('42');
    assert.match(lines[0], /^GET \/api\/devices\/42 -> HTTP 200 in \d+ ms, \d+ bytes$/);
    assert.ok(!lines.join('').includes('secret'));
  } finally {
    await srv.close();
  }
});
