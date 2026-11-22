'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { App, createDevice, fakeClock, manifest } = require('./helpers');

const api = require(path.join(__dirname, '..', 'api.js'));

function appWith(devices) {
  const app = Object.create(App.prototype);
  app.debugMode = false;
  app.startedAt = Date.parse('2026-03-15T08:00:00Z');
  app.homey = {
    manifest,
    version: '12.9.0',
    drivers: { getDriver: () => ({ getDevices: () => devices }) },
  };
  return app;
}

async function heatPump(name, apiKey, values = {}) {
  const device = await createDevice({ store: apiKey ? { apiKey } : {} });
  device.getName = () => name;
  device.deviceTimezone = 'Europe/Stockholm';
  device.stopPolling();
  Object.assign(device, values);
  return device;
}

test('the token status follows what melpump.com answered last', async () => {
  const device = await heatPump('Heat pump', 'api_secret');
  assert.strictEqual(device.tokenStatus(), 'ok');

  device.store.writeAccess = false;
  assert.strictEqual(device.tokenStatus(), 'read_only');

  device.failedPolls = 1;
  device.lastError = { time: Date.now(), message: 'The API token has no permission for this device', status: 403 };
  assert.strictEqual(device.tokenStatus(), 'no_access');
  device.subscriptionWarning = 'device.subscription_inactive';
  assert.strictEqual(device.tokenStatus(), 'subscription');

  device.lastError.status = 401;
  assert.strictEqual(device.tokenStatus(), 'rejected');

  // An old error doesn't count once polling works again.
  device.failedPolls = 0;
  device.subscriptionWarning = null;
  device.store.writeAccess = true;
  assert.strictEqual(device.tokenStatus(), 'ok');

  delete device.store.apiKey;
  assert.strictEqual(device.tokenStatus(), 'missing');
});

test('a 403 from melpump.com is kept with the last error for the token status', async () => {
  const device = await heatPump('Heat pump', 'api_secret');
  device.api = { getDeviceAccess: async () => ({ subscriptionActive: true }) };
  const err = Object.assign(new Error('The API token has no permission for this device'), { status: 403, isAuthError: true });
  await device.handlePollError(err);
  assert.strictEqual(device.lastError.status, 403);
  assert.strictEqual(device.tokenStatus(), 'no_access');
});

test('the overview numbers tokens, never sends one, and has a diagnostics text', async () => {
  const clock = fakeClock('2026-03-15T10:00:00Z');
  try {
    const home = await heatPump('Home', 'api_secret_one', {
      lastSuccess: Date.parse('2026-03-15T09:59:00Z'),
      lastSeenAt: Date.parse('2026-03-15T09:58:00Z'),
      requestTimes: [Date.now() - 1000, Date.now() - 2000],
      boostUntil: Date.parse('2026-03-15T11:00:00Z'),
    });
    const cabin = await heatPump('Cabin', 'api_secret_one', {
      failedPolls: 3,
      lastError: { time: Date.parse('2026-03-15T09:30:00Z'), message: 'Could not reach melpump.com: timeout', status: null },
      unavailableMessage: 'Could not reach melpump.com: timeout',
    });
    await cabin.setUnavailable();
    const garage = await heatPump('Garage', 'api_secret_two');

    const overview = await api.getOverview({ homey: { app: appWith([home, cabin, garage]) } });
    assert.strictEqual(overview.tokens, 2);
    assert.deepStrictEqual(overview.heatPumps.map((hp) => hp.tokenNumber), [1, 1, 2]);
    assert.ok(!JSON.stringify(overview).includes('api_secret'), 'no token anywhere');

    const [first, second] = overview.heatPumps;
    assert.strictEqual(first.lastUpdate, '2026-03-15 10:59', 'Stockholm time');
    assert.strictEqual(first.requestsLastHour, 2);
    assert.strictEqual(first.boostUntil, '2026-03-15 12:00');
    assert.strictEqual(first.available, true);
    assert.strictEqual(second.available, false);
    assert.strictEqual(second.unavailableMessage, 'Could not reach melpump.com: timeout');
    assert.deepStrictEqual(second.lastError, { time: '2026-03-15 10:30', message: 'Could not reach melpump.com: timeout' });

    const lines = overview.text.split('\n');
    assert.strictEqual(lines[0], `MelPump for Homey ${manifest.version}, Homey 12.9.0, debug logging off`);
    assert.ok(lines.includes('Heat pumps: 3, tokens: 2'));
    assert.ok(lines.includes('Heat pump 2: Cabin'));
    assert.ok(lines.includes('  Status: unavailable: Could not reach melpump.com: timeout'));
    assert.ok(lines.includes('  Token: #2, ok'));
    assert.ok(lines.includes('  Requests in the last hour: 2 of 90'));
    assert.ok(lines.includes('  Last error: 2026-03-15 10:30: Could not reach melpump.com: timeout'));
  } finally {
    clock.restore();
  }
});

test('the overview without heat pumps', async () => {
  const overview = appWith([]).getOverview();
  assert.deepStrictEqual(overview.heatPumps, []);
  assert.strictEqual(overview.tokens, 0);
  assert.match(overview.text, /^Heat pumps: 0, tokens: 0$/m);
});

test('the app API declares every endpoint in api.js', () => {
  assert.deepStrictEqual(Object.keys(manifest.api).sort(), Object.keys(api).sort());
  assert.deepStrictEqual(manifest.api.getOverview, { method: 'GET', path: '/overview' });
});

test('the log buffer keeps the last 200 lines of the app, the driver and the heat pumps', async () => {
  const clock = fakeClock('2026-03-15T10:00:00Z');
  try {
    const app = appWith([]);
    app.log('MelPump app has been initialized');
    app.error('Something failed:', new Error('boom'), { status: 500 });
    app.recordLog('log', 'Home', ['Token check with api_secretToken123 failed']);

    const overview = app.getOverview();
    assert.deepStrictEqual(overview.log, [
      { time: '2026-03-15T10:00:00.000Z', level: 'log', source: 'app', message: 'MelPump app has been initialized' },
      { time: '2026-03-15T10:00:00.000Z', level: 'error', source: 'app', message: 'Something failed: boom {"status":500}' },
      { time: '2026-03-15T10:00:00.000Z', level: 'log', source: 'Home', message: 'Token check with api_*** failed' },
    ]);
    const lines = overview.text.split('\n');
    assert.ok(lines.includes('Log, last 3 lines (UTC):'));
    assert.ok(lines.includes('2026-03-15 10:00:00 ERROR [app] Something failed: boom {"status":500}'));
    assert.ok(!overview.text.includes('secretToken'));

    for (let i = 0; i < 250; i += 1) app.recordLog('log', 'app', [`line ${i}`]);
    assert.strictEqual(app.logBuffer.length, 200);
    assert.strictEqual(app.logBuffer[0].message, 'line 50');
    app.recordLog('log', 'app', ['x'.repeat(2000)]);
    assert.strictEqual(app.logBuffer[199].message.length, 500);
  } finally {
    clock.restore();
  }
});

test('heat pumps and the driver send their log lines to the app', async () => {
  const { Device, Driver } = require('./helpers');
  const lines = [];
  const homey = { app: { recordLog: (level, source, args) => lines.push([level, source, ...args]) } };

  const device = Object.create(Device.prototype);
  device.homey = homey;
  device.getName = () => 'Home';
  Device.prototype.log.call(device, 'Polling works again');
  Device.prototype.error.call(device, 'Could not update', 'melpump_mode');

  const driver = Object.create(Driver.prototype);
  driver.homey = homey;
  Driver.prototype.log.call(driver, '[pair]', 'found 2 heat pumps');

  assert.deepStrictEqual(lines, [
    ['log', 'Home', 'Polling works again'],
    ['error', 'Home', 'Could not update', 'melpump_mode'],
    ['log', 'driver', '[pair]', 'found 2 heat pumps'],
  ]);

  // Before the app is ready (or without it), logging still works.
  device.homey = {};
  Device.prototype.log.call(device, 'early');
});
