'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createDevice, fakeClock } = require('./helpers');

const MINUTE = 60000;

test('saving, solar and normal mode statistics, today and yesterday', async () => {
  const clock = fakeClock('2026-10-31T10:00:00Z');
  try {
    const device = await createDevice();
    device.deviceTimezone = 'Europe/Stockholm';
    const run = async (minutes, watt, heatWatt) => {
      for (let i = 0; i < minutes; i += 1) {
        await device.integratePower(watt, heatWatt);
        clock.advance(MINUTE);
      }
    };
    const setModes = (saving, solar) => {
      device.capabilities.set('melpump_saving_mode', saving);
      device.capabilities.set('melpump_solar_mode', solar);
    };

    setModes(false, false);
    await run(61, 1000, 3000); // 1 h normal: 1 kWh in, 3 kWh heat
    setModes(true, false);
    await run(60, 2000, 5000); // 1 h saving: 2 kWh, 5 kWh heat
    setModes(true, true);
    await run(60, 1000, 4000); // 1 h saving + solar: 1 kWh, 4 kWh heat
    setModes(false, true);
    await run(61, 1000, 4500); // 1 h solar: 1 kWh, 4.5 kWh heat

    assert.strictEqual(device.getCapabilityValue('melpump_saving_time_today'), 2);
    assert.strictEqual(device.getCapabilityValue('melpump_solar_time_today'), 2);

    // Next day: yesterday's figures move over.
    setModes(false, false);
    clock.set('2026-11-01T10:00:00Z');
    device.lastPowerSample = null;
    await run(2, 1000, 3000);

    // The minute in which a mode changes counts for the mode it had at its start,
    // so the figures are a hundredth off the round numbers.
    const value = (id) => device.getCapabilityValue(id);
    const near = (id, expected) => assert.ok(Math.abs(value(id) - expected) <= 0.02, `${id}: ${value(id)} vs ${expected}`);
    assert.strictEqual(value('melpump_saving_time_yesterday'), 2);
    near('melpump_saving_energy_yesterday', 3);
    near('melpump_solar_energy_yesterday', 2);
    assert.strictEqual(value('melpump_saving_share_yesterday'), 60, '3 of 5 kWh');
    assert.strictEqual(value('melpump_solar_share_yesterday'), 40);
    near('melpump_cop_saving_yesterday', 3); // 9 / 3
    near('melpump_cop_solar_yesterday', 4.25); // 8.5 / 2
    near('melpump_cop_normal_yesterday', 3);
  } finally {
    clock.restore();
  }
});

test('a gap in the live readings asks for a recalculation from history', async () => {
  const clock = fakeClock('2026-10-31T10:00:00Z');
  try {
    const device = await createDevice();
    device.historyNeeded = false;
    await device.integratePower(1000, 3000);
    assert.strictEqual(device.historyNeeded, true, 'first reading after start');

    device.historyNeeded = false;
    clock.advance(MINUTE);
    await device.integratePower(1000, 3000);
    assert.strictEqual(device.historyNeeded, false, 'regular reading');

    clock.advance(10 * MINUTE);
    await device.integratePower(1000, 3000);
    assert.strictEqual(device.historyNeeded, true, 'readings 10 minutes apart');
  } finally {
    clock.restore();
  }
});

test('compressor starts, running hours and defrosts', async () => {
  const clock = fakeClock('2026-10-31T10:00:00Z');
  try {
    const device = await createDevice();
    device.deviceTimezone = 'Europe/Stockholm';
    // [compressor frequency, defrosting], one reading per minute.
    const readings = [[0, false], [40, false], [40, false], [40, true], [40, true], [40, false], [0, false], [35, false]];
    for (const [frequency, defrost] of readings) {
      await device.trackRuns(frequency, defrost);
      clock.advance(MINUTE);
    }

    assert.strictEqual(device.getCapabilityValue('melpump_compressor_starts_today'), 2);
    assert.strictEqual(device.getCapabilityValue('melpump_defrosts_today'), 1);
    assert.strictEqual(device.getCapabilityValue('melpump_defrost_minutes_today'), 2);
    assert.strictEqual(device.runStats['2026-10-31'].hours, 5 / 60);

    const triggers = device.fired.filter((f) => f.trigger && f.trigger.startsWith('compressor'));
    assert.deepStrictEqual(triggers.map((f) => f.trigger), [
      'compressorStartedTrigger', 'compressorStoppedTrigger', 'compressorStartedTrigger',
    ]);
    assert.deepStrictEqual(triggers[1].tokens, { run_minutes: 5 });
    assert.deepStrictEqual(triggers[2].tokens, { starts_today: 2 });
  } finally {
    clock.restore();
  }
});

test('the widget graphs keep the last hour and 5-minute averages of 24 hours', async () => {
  const start = Math.floor(Date.parse('2026-10-31T10:00:00Z') / 300000) * 300000;
  const clock = fakeClock(start);
  try {
    const device = await createDevice();
    device.recordPower(1);
    clock.advance(MINUTE);
    device.recordPower(2);
    clock.advance(MINUTE);
    device.recordPower(null);
    clock.advance(MINUTE);
    device.recordPower(3);
    assert.deepStrictEqual(device.powerDay, [[start, 2, 3]]);

    clock.set(start + 5 * MINUTE);
    device.recordPower(4);
    assert.strictEqual(device.powerDay.length, 2);
    assert.strictEqual(device.powerHistory.length, 4);

    clock.set(start + 25 * 60 * MINUTE);
    device.recordPower(5);
    assert.strictEqual(device.powerDay.length, 1, 'older than 24 hours dropped');
    assert.strictEqual(device.powerHistory.length, 1, 'older than an hour dropped');
  } finally {
    clock.restore();
  }
});

test('device details: every 5th poll, after a Flow, and once just after each full hour', async () => {
  const clock = fakeClock('2026-11-01T10:00:30Z');
  try {
    const device = await createDevice();
    device.deviceTimezone = 'UTC';
    device.deviceFetchedHour = '2026-11-01 09';
    assert.strictEqual(device.shouldFetchDevice(0), true, 'every 5th poll');
    assert.strictEqual(device.shouldFetchDevice(1), false, 'minute 0: not yet');
    clock.set('2026-11-01T10:01:30Z');
    assert.strictEqual(device.shouldFetchDevice(1), true, 'first poll after the full hour');
    assert.strictEqual(device.shouldFetchDevice(2), false, 'only once that hour');
    device.refreshDevice = true;
    assert.strictEqual(device.shouldFetchDevice(3), true, 'after a Flow changed something');
  } finally {
    clock.restore();
  }
});
