'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createDevice, driverManifest } = require('./helpers');

test('onInit adds every capability of the driver and the device class', async () => {
  const device = await createDevice();
  assert.strictEqual(device.capabilities.size, driverManifest.capabilities.length);
  assert.strictEqual(device.getClass(), 'heatpump');
  // Without a token the device asks for a repair instead of polling.
  assert.strictEqual(device.getAvailable(), false);
  assert.strictEqual(device.timers.length, 0);
});

test('a hidden group is removed and comes back, with listeners registered once', async () => {
  const device = await createDevice();
  assert.ok(device.hasCapability('melpump_quiet_switch'));
  assert.strictEqual(typeof device.listeners.melpump_quiet_switch, 'function');

  await device.onSettings({
    newSettings: { show_switches: false, show_mode_stats: false },
    changedKeys: ['show_switches', 'show_mode_stats'],
  });
  assert.ok(!device.hasCapability('melpump_quiet_switch'));
  assert.ok(!device.hasCapability('melpump_cop_normal_yesterday'));
  assert.ok(device.hasCapability('melpump_compressor_starts_today'), 'other groups stay');

  device.listeners.melpump_quiet_switch = 'kept';
  await device.onSettings({
    newSettings: { show_switches: true, show_mode_stats: false },
    changedKeys: ['show_switches'],
  });
  assert.ok(device.hasCapability('melpump_quiet_switch'));
  assert.strictEqual(device.listeners.melpump_quiet_switch, 'kept', 'not registered twice');
  // Re-added values are filled at the next poll.
  assert.strictEqual(device.refreshDevice, true);
  assert.strictEqual(device.catchUp, true);
});

test('temperature sliders are debounced, other controls are not', async () => {
  const device = await createDevice();
  assert.strictEqual(device.listeners.target_temperature.debounce, 1500);
  assert.strictEqual(device.listeners['target_temperature.tank'].debounce, 1500);
  assert.strictEqual(typeof device.listeners.melpump_mode, 'function');
});

test('a heat pump without cooling loses cooling values and choices', async () => {
  const device = await createDevice();
  await device.updateFeatures({ canCool: false, hasThermostatZone1: true, hasThermostatZone2: false });

  assert.ok(!device.hasCapability('melpump_cop_cooling_yesterday'));
  assert.ok(!device.hasCapability('target_temperature.zone2'));
  assert.ok(device.hasCapability('target_temperature'));
  const modes = device.getCapabilityOptions('melpump_mode').values.map((v) => v.id);
  assert.deepStrictEqual(modes, ['heating', 'off']);
  assert.throws(() => device.assertCanCool('mode', 'cooling'), /device\.cannot_cool/);
  assert.doesNotThrow(() => device.assertCanCool('mode', 'heating'));
  assert.deepStrictEqual(device.store.features, { canCool: false, thermostatZone1: true, thermostatZone2: false });
});

test('the mode follows power when the heat pump cannot cool', async () => {
  const device = await createDevice();
  await device.updateFeatures({ canCool: false });
  const sent = [];
  device.api = {
    setDeviceState: async (id, body) => { sent.push(body); return { success: true }; },
    setDeviceSettings: async (id, body) => { sent.push(body); return { success: true }; },
  };
  device.store.writeAccess = true;
  // "Auto" from a Flow means heating when there is nothing else to switch to.
  await device.setMode('auto');
  assert.strictEqual(device.getCapabilityValue('melpump_mode'), 'heating');
  assert.strictEqual(sent.length, 1);
  assert.ok(sent[0].operationMode !== undefined);

  // Switched off before: power goes on first.
  device.lastPower = false;
  await device.setMode('heating');
  assert.deepStrictEqual(sent[1], { power: true });

  await assert.rejects(device.setMode('cooling'), /device\.cannot_cool/);
  assert.strictEqual(sent.length, 3, 'nothing sent for a refused mode');
});
