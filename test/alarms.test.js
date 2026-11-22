'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createDevice, fakeClock } = require('./helpers');

const DAY = 24 * 60 * 60 * 1000;

const alarm = (id, triggeredAt, values = {}) => ({
  id, type: 'flow_temp', typeLabel: 'Flow temperature', triggeredAt, message: 'Flow temperature too high', actualValue: 61.5, acknowledged: false, ...values,
});

async function alarmDevice(today) {
  const device = await createDevice({ store: { lastAlarmId: 0 }, settings: { alarm_notifications: false } });
  device.deviceTimezone = 'UTC';
  device.api = { getAlarmHistory: async () => today() };
  return device;
}

test('alarms are kept after midnight, when MelPump no longer lists them', async () => {
  const clock = fakeClock('2026-03-15T18:00:00Z');
  try {
    let today = [alarm(7, '2026-03-15T17:55:00Z')];
    const device = await alarmDevice(() => today);
    await device.pollAlarms();
    assert.strictEqual(device.getCapabilityValue('melpump_alarms_7d'), 1);

    clock.set('2026-03-16T00:15:00Z');
    today = [];
    await device.pollAlarms();
    assert.strictEqual(device.getCapabilityValue('melpump_alarms_today'), 0);
    assert.strictEqual(device.getCapabilityValue('melpump_alarms_7d'), 1, 'yesterday still counts');
    assert.deepStrictEqual(device.store.alarmHistory, [{
      id: 7, type: 'flow_temp', label: 'Flow temperature', message: 'Flow temperature too high', value: 61.5, at: Date.parse('2026-03-15T17:55:00Z'), acknowledged: false,
    }]);

    // A week later it no longer counts for the 7 days, but is still in the history.
    clock.set('2026-03-23T00:00:00Z');
    await device.pollAlarms();
    assert.strictEqual(device.getCapabilityValue('melpump_alarms_7d'), 0);
    assert.strictEqual(device.store.alarmHistory.length, 1);
  } finally {
    clock.restore();
  }
});

test('the history follows acknowledgements, from MelPump and from Homey', async () => {
  const clock = fakeClock('2026-03-15T12:00:00Z');
  try {
    let today = [alarm(1, '2026-03-15T08:00:00Z'), alarm(2, '2026-03-15T09:00:00Z'), alarm(3, '2026-03-15T10:00:00Z')];
    const device = await alarmDevice(() => today);
    device.store.writeAccess = true;
    device.api.acknowledgeAlarm = async () => ({ success: true });
    device.api.acknowledgeAllAlarms = async () => ({ success: true });
    device.pollSoon = () => {};
    await device.pollAlarms();

    // Acknowledged in the MelPump app: seen at the next check.
    today = today.map((a) => (a.id === 1 ? { ...a, acknowledged: true } : a));
    await device.pollAlarms();
    assert.deepStrictEqual(device.alarmHistory.map((a) => a.acknowledged), [true, false, false]);

    await device.acknowledgeAlarm(2);
    assert.deepStrictEqual(device.store.alarmHistory.map((a) => a.acknowledged), [true, true, false]);
    await device.acknowledgeAlarms();
    assert.deepStrictEqual(device.store.alarmHistory.map((a) => a.acknowledged), [true, true, true]);
  } finally {
    clock.restore();
  }
});

test('the history keeps 90 days and at most 300 alarms', async () => {
  const clock = fakeClock('2026-06-30T12:00:00Z');
  try {
    const device = await alarmDevice(() => []);
    const old = Date.now() - 91 * DAY;
    device.alarmHistory = [
      { id: 1, type: 'cop', label: 'COP', message: '', value: null, at: old, acknowledged: true },
      ...Array.from({ length: 305 }, (_, i) => ({
        id: 100 + i, type: 'cop', label: 'COP', message: '', value: null, at: Date.now() - (305 - i) * 3600000, acknowledged: false,
      })),
    ];
    await device.pollAlarms();
    const ids = device.store.alarmHistory.map((a) => a.id);
    assert.strictEqual(ids.length, 300);
    assert.ok(!ids.includes(1), 'older than 90 days');
    assert.strictEqual(ids[0], 105, 'the oldest go first');
    assert.strictEqual(ids[299], 404);
  } finally {
    clock.restore();
  }
});

test('an alarm without a time keeps the time it was first seen', async () => {
  const clock = fakeClock('2026-03-15T12:00:00Z');
  try {
    const device = await alarmDevice(() => [alarm(5, null)]);
    await device.pollAlarms();
    clock.advance(15 * 60000);
    await device.pollAlarms();
    assert.strictEqual(device.store.alarmHistory[0].at, Date.parse('2026-03-15T12:00:00Z'));
  } finally {
    clock.restore();
  }
});

test('the diagnostics show the latest alarms, newest first', async () => {
  const clock = fakeClock('2026-03-15T12:00:00Z');
  try {
    const today = Array.from({ length: 12 }, (_, i) => alarm(i + 1, new Date(Date.parse('2026-03-15T00:00:00Z') + i * 3600000).toISOString(), {
      message: i === 11 ? 'Flow temperature' : 'Too high',
      acknowledged: i === 0,
    }));
    const device = await alarmDevice(() => today);
    await device.pollAlarms();
    const { alarms } = device.getDiagnostics();
    assert.strictEqual(alarms.count, 12);
    assert.strictEqual(alarms.last7Days, 12);
    assert.strictEqual(alarms.recent.length, 10);
    assert.deepStrictEqual(alarms.recent[0], {
      time: '2026-03-15 11:00', label: 'Flow temperature', message: null, acknowledged: false,
    }, 'a message equal to the label is left out');
    assert.strictEqual(alarms.recent[9].time, '2026-03-15 02:00');
  } finally {
    clock.restore();
  }
});

test('new alarms fire both triggers and a notification; existing ones after pairing do not', async () => {
  const clock = fakeClock('2026-03-15T12:00:00Z');
  try {
    let today = [alarm(10, '2026-03-15T08:00:00Z')];
    const device = await createDevice({ settings: { alarm_notifications: true } });
    device.deviceTimezone = 'UTC';
    device.api = { getAlarmHistory: async () => today };

    // First check after pairing: remembered, nothing fired.
    await device.pollAlarms();
    assert.strictEqual(device.store.lastAlarmId, 10);
    assert.deepStrictEqual(device.fired, []);
    assert.strictEqual(device.getCapabilityValue('melpump_last_alarm'), '08:00 Flow temperature: Flow temperature too high');

    today = [...today, alarm(12, '2026-03-15T11:00:00Z', { type: 'cop', typeLabel: 'COP', message: '', actualValue: null }), alarm(11, '2026-03-15T10:00:00Z')];
    await device.pollAlarms();
    assert.deepStrictEqual(device.fired.filter((f) => f.trigger === 'alarmTriggeredTrigger').map((f) => f.tokens), [
      { id: 11, type: 'flow_temp', label: 'Flow temperature', message: 'Flow temperature too high', value: 61.5 },
      { id: 12, type: 'cop', label: 'COP', message: 'COP', value: 0 },
    ], 'oldest first; no message gives the label, no value gives 0');
    assert.deepStrictEqual(device.fired.filter((f) => f.trigger === 'alarmTypeTriggeredTrigger').map((f) => f.state), [
      { type: 'flow_temp' }, { type: 'cop' },
    ]);
    assert.strictEqual(device.fired.filter((f) => f.notification).length, 2);
    assert.strictEqual(device.store.lastAlarmId, 12);
    assert.strictEqual(device.getCapabilityValue('melpump_last_alarm'), '11:00 COP');
    assert.strictEqual(device.getCapabilityValue('melpump_alarms_unacknowledged'), 3);
    assert.strictEqual(device.hasUnacknowledgedAlarms(), true);

    // Notifications off: triggers only.
    device.fired.length = 0;
    await device.setSettings({ alarm_notifications: false });
    today = [...today, alarm(13, '2026-03-15T11:30:00Z')];
    await device.pollAlarms();
    assert.strictEqual(device.fired.filter((f) => f.notification).length, 0);
    assert.strictEqual(device.fired.filter((f) => f.trigger === 'alarmTriggeredTrigger').length, 1);
  } finally {
    clock.restore();
  }
});
