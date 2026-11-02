'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { App, createDevice, fakeClock } = require('./helpers');

async function widgetDevice() {
  const device = await createDevice();
  device.deviceTimezone = 'UTC';
  device.store.writeAccess = true;
  await device.setAvailable();
  const set = (values) => Object.entries(values).forEach(([id, value]) => device.capabilities.set(id, value));
  set({
    measure_cop: 3.5,
    measure_power: 1200,
    melpump_tank_temperature: 45,
    'target_temperature.tank': 50,
    melpump_saving_mode: true,
    melpump_defrost: false,
  });
  return device;
}

function appWith(devices) {
  const app = Object.create(App.prototype);
  const sent = [];
  app.error = (err) => { throw err; };
  app.homey = {
    api: { realtime: async (event, data) => { sent.push([event, data.deviceId]); } },
    drivers: { getDriver: () => ({ getDevices: () => devices }) },
    __: (key) => key,
  };
  return { app, sent };
}

test('the widget status has today\'s figures, alarms, warnings and what buttons need', async () => {
  const clock = fakeClock('2026-03-15T12:00:00Z');
  try {
    const device = await widgetDevice();
    device.energyEstimates['2026-03-15'] = 10;
    device.heatEstimates = { '2026-03-15': 33.333 };
    device.runStats['2026-03-15'] = { starts: 4 };
    device.unacknowledgedAlarms = 2;
    device.lastAlarmText = '14:32 High pressure';
    device.lastStateAt = Date.now() - 60000;
    device.subscriptionWarning = 'inactive';
    device.deviceSettings = { smartEnergyActive: true };

    const status = device.getWidgetStatus();
    assert.strictEqual(status.deviceId, '42');
    assert.deepStrictEqual(status.today, { energy: 10, heat: 33.3, cop: 3.33, starts: 4 });
    assert.deepStrictEqual(status.alarms, { unacknowledged: 2, last: '14:32 High pressure' });
    assert.deepStrictEqual(status.modes, ['saving']);
    assert.strictEqual(status.tankTarget, 50);
    assert.strictEqual(status.warning, 'inactive');
    assert.strictEqual(status.savingOn, true);
    assert.strictEqual(status.canWrite, true);
    assert.strictEqual(status.serverTime - status.updatedAt, 60000);

    // Too little energy for a meaningful COP.
    device.energyEstimates['2026-03-15'] = 0.05;
    device.heatEstimates = { '2026-03-15': 0.2 };
    assert.strictEqual(device.getWidgetStatus().today.cop, null);
  } finally {
    clock.restore();
  }
});

test('widget buttons run only their own actions', async () => {
  const device = await widgetDevice();
  const calls = [];
  device.applyHotWaterPreset = async (preset) => calls.push(`preset ${preset}`);
  device.forceSolarMode = async (minutes) => calls.push(`solar ${minutes}`);
  device.setSavingMode = async (on) => calls.push(`saving ${on}`);
  device.acknowledgeAlarms = async () => calls.push('ack');

  for (const action of ['hot_water_hot', 'hot_water_comfort', 'solar_1h', 'saving_on', 'saving_off', 'acknowledge_alarms']) {
    await device.runWidgetAction(action);
  }
  assert.deepStrictEqual(calls, ['preset hot', 'preset comfort', 'solar 60', 'saving true', 'saving false', 'ack']);
  for (const action of ['setDeviceState', '__proto__', 'constructor', undefined]) {
    await assert.rejects(device.runWidgetAction(action), /Unknown widget action/);
  }
});

test('the app pushes updates only while a widget is open', async () => {
  const device = await widgetDevice();
  const { app, sent } = appWith([device]);
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  app.emitWidgetStatus(device);
  await flush();
  assert.strictEqual(sent.length, 0, 'no widget has asked for data');

  assert.strictEqual(app.getWidgetStatus('').deviceId, '42', 'empty setting shows the first heat pump');
  app.emitWidgetStatus(device);
  await flush();
  assert.deepStrictEqual(sent, [['status', '42']]);

  app.widgetSeenAt = Date.now() - 11 * 60000;
  app.emitWidgetStatus(device);
  await flush();
  assert.strictEqual(sent.length, 1, 'no request for over 10 minutes: closed');
});

test('a widget action returns the new status; an unknown heat pump is refused', async () => {
  const device = await widgetDevice();
  device.forceSolarMode = async () => {};
  const { app } = appWith([device]);
  assert.strictEqual((await app.runWidgetAction('42', 'solar_1h')).deviceId, '42');

  const empty = appWith([]).app;
  await assert.rejects(empty.runWidgetAction('42', 'solar_1h'), /widget\.no_device/);
  assert.strictEqual(empty.getWidgetStatus('42'), null);
});
