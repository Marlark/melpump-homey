'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { App, createDevice, fakeClock } = require('./helpers');

const MINUTE = 60000;

test('small changes of noisy values are not written; 0 and other values always are', async () => {
  const device = await createDevice();
  const set = (values) => device.updateCapabilities(values);
  device.capabilities.set('measure_power', 1200);
  device.capabilities.set('measure_cop', 3.5);
  device.capabilities.set('melpump_delta_t', 5);
  device.capabilities.set('measure_temperature.outdoor', 7);

  await set({ measure_power: 1205, measure_cop: 3.52, melpump_delta_t: 5.1, 'measure_temperature.outdoor': 7.1 });
  assert.strictEqual(device.getCapabilityValue('measure_power'), 1200);
  assert.strictEqual(device.getCapabilityValue('measure_cop'), 3.5);
  assert.strictEqual(device.getCapabilityValue('melpump_delta_t'), 5);
  assert.strictEqual(device.getCapabilityValue('measure_temperature.outdoor'), 7.1, 'no deadband');

  await set({ measure_power: 1215, measure_cop: 3.56 });
  assert.strictEqual(device.getCapabilityValue('measure_power'), 1215);
  assert.strictEqual(device.getCapabilityValue('measure_cop'), 3.56);

  await set({ measure_power: 0 });
  assert.strictEqual(device.getCapabilityValue('measure_power'), 0, 'stopping is always shown');
  await set({ measure_power: 5 });
  assert.strictEqual(device.getCapabilityValue('measure_power'), 5, 'starting is always shown');

  // Sub-capabilities use their capability's deadband.
  device.capabilities.set('melpump_delta_t.zone1', 4);
  await set({ 'melpump_delta_t.zone1': 4.1 });
  assert.strictEqual(device.getCapabilityValue('melpump_delta_t.zone1'), 4);
});

test('statistics are only saved when they changed', async () => {
  const device = await createDevice();
  const writes = [];
  const save = device.setStoreValue;
  device.setStoreValue = async (key, value) => { writes.push(key); return save(key, value); };

  await device.persistStats();
  assert.deepStrictEqual(writes.sort(), ['energyEstimates', 'heatEstimates', 'modeStats', 'runStats']);
  writes.length = 0;
  await device.persistStats();
  assert.deepStrictEqual(writes, [], 'nothing changed');
  device.runStats['2026-03-15'] = { starts: 1 };
  await device.persistStats();
  assert.deepStrictEqual(writes, ['runStats']);
});

test('per-minute triggers only fire when one of the Flows matches', async () => {
  const clock = fakeClock('2026-03-15T10:00:00Z');
  try {
    const device = await createDevice();
    device.flowArgValues.heaterOnLongTrigger = [{ heater: 'immersion', minutes: 10 }];
    for (let i = 0; i <= 20; i += 1) {
      await device.trackHeaters({ immersion: true, booster: true });
      clock.advance(MINUTE);
    }
    const fired = device.fired.filter((f) => f.trigger === 'heaterOnLongTrigger');
    assert.deepStrictEqual(fired.map((f) => [f.state.heater, f.state.minutes]), [['immersion', 10]]);

    // No Flows at all: nothing is fired.
    const quiet = await createDevice();
    quiet.flowArgValues.roomTemperatureDeviatesTrigger = [];
    quiet.capabilities.set('target_temperature', 21);
    quiet.capabilities.set('measure_temperature', 18);
    for (let i = 0; i < 5; i += 1) {
      await quiet.trackRoomTemperatures();
      clock.advance(MINUTE);
    }
    assert.strictEqual(quiet.fired.length, 0);
    assert.strictEqual(quiet.roomHistory[1].length, 5, 'readings are still kept');
  } finally {
    clock.restore();
  }
});

test('the Flows of a trigger are read once per 5 minutes, and again after a Flow changes', async () => {
  const clock = fakeClock('2026-03-15T10:00:00Z');
  try {
    const device = await createDevice();
    let reads = 0;
    device.driver.heaterOnLongTrigger.getArgumentValues = async () => {
      reads += 1;
      return [];
    };
    await device.flowArgs('heaterOnLongTrigger');
    await device.flowArgs('heaterOnLongTrigger');
    assert.strictEqual(reads, 1);
    clock.advance(5 * MINUTE);
    await device.flowArgs('heaterOnLongTrigger');
    assert.strictEqual(reads, 2);
    device.argsCache = {}; // what the driver does on the card's "update" event
    await device.flowArgs('heaterOnLongTrigger');
    assert.strictEqual(reads, 3);
  } finally {
    clock.restore();
  }
});

test('subscription status is checked every 6 hours instead of every hour', async () => {
  const device = await createDevice();
  device.store.apiKey = 'api_x';
  let checks = 0;
  device.api = {
    getDevice: async () => null,
    getDeviceAccess: async () => { checks += 1; return { subscriptionActive: true }; },
    getDeviceStatus: async () => null,
  };
  device.hasBudget = () => true;
  device.pollAlarms = async () => {};
  device.pollEnergy = async () => {};
  device.updateDiagnostics = async () => {};
  device.pollCount = 0;
  for (let i = 0; i <= 360; i += 1) await device.pollOnce();
  assert.strictEqual(checks, 2, 'at the first poll and after 6 hours');
});

test('after an app start the first poll is spread out; after pairing it starts at once, without waiting for it', async () => {
  const device = await createDevice();
  let polls = 0;
  device.pollOnce = async () => { polls += 1; };
  await device.startPolling({ spread: true });
  assert.strictEqual(polls, 0);
  const timer = device.timers.filter((t) => !t.cleared).pop();
  assert.ok(timer.delay >= 0 && timer.delay <= 20000);

  device.startPolling();
  const now = device.timers.filter((t) => !t.cleared).pop();
  assert.strictEqual(now.delay, 0);
  assert.strictEqual(polls, 0, 'not waited for');
  await now.fn();
  assert.strictEqual(polls, 1);
});

test('starting to poll during a poll runs another one right after it', async () => {
  const device = await createDevice();
  let release;
  let polls = 0;
  device.pollOnce = () => {
    polls += 1;
    return polls === 1 ? new Promise((resolve) => { release = resolve; }) : Promise.resolve();
  };
  const running = device.poll();
  device.startPolling();
  release();
  await running;
  assert.strictEqual(polls, 2);
});

test('realtime widget updates leave out an unchanged 24-hour graph', async () => {
  const device = await createDevice();
  const app = Object.create(App.prototype);
  const sent = [];
  app.error = (err) => { throw err; };
  app.widgetSeenAt = Date.now();
  app.homey = { api: { realtime: async (event, data) => { sent.push(data); } } };
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  device.powerDay = [[1000, 1, 1]];
  app.emitWidgetStatus(device);
  await flush();
  app.emitWidgetStatus(device);
  await flush();
  device.powerDay.push([301000, 2, 1]);
  app.emitWidgetStatus(device);
  await flush();
  assert.deepStrictEqual(sent.map((s) => 'powerDay' in s), [true, false, true]);
});

test('alarms are also checked in the last minutes of the day, so a late alarm isn\'t missed', async () => {
  // 23:50 in Stockholm (UTC+1); an alarm at 23:58:30 is in "today's" history until midnight.
  const clock = fakeClock('2026-03-15T22:50:00Z');
  try {
    const device = await createDevice({ store: { lastAlarmId: 100 } });
    device.deviceTimezone = 'Europe/Stockholm';
    device.store.apiKey = 'api_x';
    const raised = Date.parse('2026-03-15T22:58:30Z');
    const midnight = Date.parse('2026-03-15T23:00:00Z');
    const checks = [];
    device.api = {
      getDevice: async () => null,
      getDeviceAccess: async () => ({ subscriptionActive: true }),
      getDeviceStatus: async () => null,
      getAlarmHistory: async () => {
        checks.push(new Date(Date.now()).toISOString().slice(11, 16));
        return Date.now() >= raised && Date.now() < midnight
          ? [{ id: 101, type: 'E1', typeLabel: 'Error', message: 'Late alarm', acknowledged: false }]
          : [];
      },
    };
    device.hasBudget = () => true;
    device.pollEnergy = async () => {};
    device.updateDiagnostics = async () => {};
    device.pollCount = 1; // regular alarm checks at 23:50 + 14 min, and 15 min later

    for (let minute = 0; minute < 30; minute += 1) {
      await device.pollOnce();
      clock.advance(MINUTE);
    }
    // Regular checks at 00:04 and 00:19 local (23:04, 23:19 UTC); extra ones at 23:57-23:59.
    assert.deepStrictEqual(checks, ['22:57', '22:58', '22:59', '23:04', '23:19']);
    assert.deepStrictEqual(device.fired.filter((f) => f.trigger === 'alarmTriggeredTrigger').map((f) => f.tokens.id), [101]);
  } finally {
    clock.restore();
  }
});

test('the subscription warning goes as soon as MelPump answers again after a renewal', async () => {
  const device = await createDevice();
  device.store.apiKey = 'api_x';
  let active = false;
  let checks = 0;
  const forbidden = Object.assign(new Error('403'), { status: 403, isAuthError: true });
  device.api = {
    getDevice: async () => { if (!active) throw forbidden; return null; },
    getDeviceAccess: async () => { checks += 1; return { subscriptionActive: active }; },
    getDeviceStatus: async () => { if (!active) throw forbidden; return null; },
  };
  device.hasBudget = () => true;
  device.pollAlarms = async () => {};
  device.pollEnergy = async () => {};
  device.updateDiagnostics = async () => {};
  device.pollCount = 1;

  await device.pollOnce();
  assert.strictEqual(device.getAvailable(), false);
  assert.ok(device.subscriptionWarning);

  active = true;
  checks = 0;
  await device.pollOnce();
  assert.strictEqual(device.subscriptionWarning, null, 'checked on the first poll that works');
  assert.strictEqual(device.getAvailable(), true);
  assert.strictEqual(checks, 1);

  // Without the warning, the 6-hour interval applies again.
  checks = 0;
  for (let i = 0; i < 30; i += 1) await device.pollOnce();
  assert.strictEqual(checks, 0);
});

test('while the subscription warning is shown and reads work, access is checked every 15 polls', async () => {
  const device = await createDevice();
  device.store.apiKey = 'api_x';
  let active = false;
  let checks = 0;
  device.api = {
    getDevice: async () => null,
    getDeviceAccess: async () => { checks += 1; return { subscriptionActive: active }; },
    getDeviceStatus: async () => null,
  };
  device.hasBudget = () => true;
  device.pollAlarms = async () => {};
  device.pollEnergy = async () => {};
  device.updateDiagnostics = async () => {};
  device.pollCount = 0;

  await device.pollOnce();
  assert.ok(device.subscriptionWarning, 'found at the first poll');
  for (let i = 1; i < 60; i += 1) await device.pollOnce();
  assert.strictEqual(checks, 4, 'polls 0, 15, 30 and 45');

  active = true;
  for (let i = 0; i < 15; i += 1) await device.pollOnce();
  assert.strictEqual(device.subscriptionWarning, null);
  assert.notStrictEqual(device.warning, "device.subscription_inactive", "the warning shown is no longer the subscription");
});
