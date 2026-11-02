'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { App, Device, Driver, createDevice } = require('./helpers');

test('API clients are shared per token and dropped when no device uses them', () => {
  const app = Object.create(App.prototype);
  app.clients = new Map();
  app.debugMode = false;
  app.log = () => {};
  const devices = [{ getStoreValue: () => 'api_a' }, { getStoreValue: () => 'api_a' }];
  app.homey = { drivers: { getDriver: () => ({ getDevices: () => devices }) } };

  const client = app.getClient('api_a');
  assert.strictEqual(app.getClient('api_a'), client);
  assert.notStrictEqual(app.getClient('api_b'), client);

  app.removeClient('api_a', devices[0]);
  assert.ok(app.clients.has('api_a'), 'still used by the other device');
  app.removeClient('api_a');
  devices.length = 0;
  app.removeClient('api_a');
  assert.ok(!app.clients.has('api_a'));
});

test('every request through device.api is counted, with one proxy per client', () => {
  const device = Object.create(Device.prototype);
  let client = { getDevice: async () => 'old', _request: () => {} };
  device.homey = { app: { getClient: () => client } };
  device.getStoreValue = () => 'api_x';
  device.requestTimes = [];

  const proxy = device.api;
  assert.strictEqual(device.api, proxy);
  assert.strictEqual(device.api.getDevice, proxy.getDevice, 'method wrappers are reused');
  return proxy.getDevice().then(async (result) => {
    assert.strictEqual(result, 'old');
    assert.strictEqual(device.requestTimes.length, 1);
    assert.strictEqual(typeof device.api._request, 'function', 'internal methods are not counted');

    // After a repair the token (and client) changes.
    client = { getDevice: async () => 'new' };
    assert.notStrictEqual(device.api, proxy);
    assert.strictEqual(await device.api.getDevice(), 'new');
    assert.strictEqual(device.requestTimes.length, 2);
  });
});

test('debug mode logs changed values; normal mode logs nothing extra', async () => {
  for (const debugMode of [false, true]) {
    const device = await createDevice();
    device.homey.app.debugMode = debugMode;
    device.capabilities.set('measure_power', 100);
    device.logs.length = 0;
    await device.updateCapabilities({ measure_power: 250, measure_temperature: null });
    assert.strictEqual(device.getCapabilityValue('measure_power'), 250);
    assert.deepStrictEqual(device.logs, debugMode ? ['[debug] Changed: measure_power 100 -> 250'] : []);
  }
});

test('debug mode logs every trigger with its tokens', async () => {
  const driver = Object.create(Driver.prototype);
  const lines = [];
  driver.log = (...args) => lines.push(args.join(' '));
  let fired = null;
  driver.copChangedTrigger = { id: 'cop_changed', trigger: async (device, tokens) => { fired = tokens; } };
  driver.logTriggers();

  await driver.copChangedTrigger.trigger({ getName: () => 'Pump' }, { cop: 3.2 });
  assert.deepStrictEqual(fired, { cop: 3.2 }, 'the trigger still fires');
  assert.match(lines[0], /Pump: trigger cop_changed \{"cop":3\.2\}/);
});
