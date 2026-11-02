'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createDevice, fakeClock } = require('./helpers');

const FIVE_MINUTES = 5 * 60000;

/**
 * Today's history from midnight UTC: one state every 5 minutes.
 * @param {Array<[number, number, number, boolean]>} rows [input kW, output kW, compressor Hz, defrost]
 */
function history(rows) {
  const midnight = Date.parse('2026-03-15T00:00:00Z');
  return rows.map(([input, output, frequency, defrost], i) => ({
    dateCreated: new Date(midnight + i * FIVE_MINUTES).toISOString(),
    EstInputPower: input,
    EstOutputPower: output,
    HeatPumpFrequency: frequency,
    DefrostMode: defrost,
  }));
}

async function deviceWithHistory(rows) {
  const device = await createDevice({ api: { getDayStates: async () => history(rows) } });
  device.deviceTimezone = 'UTC';
  return device;
}

test('today is recalculated from history: energy, heat, runs and defrosts', async () => {
  const clock = fakeClock('2026-03-15T01:00:00Z');
  try {
    // 1 kW in / 3 kW out for an hour with the compressor running, except a stop and a defrost.
    const device = await deviceWithHistory([
      [1, 3, 40, false], [1, 3, 40, false], [1, 3, 0, false], [1, 3, 40, false], [1, 3, 40, true],
      [1, 3, 40, false], [1, 3, 40, false], [1, 3, 40, false], [1, 3, 40, false], [1, 3, 40, false],
      [1, 3, 40, false], [1, 3, 40, false], [1, 3, 40, false],
    ]);

    assert.strictEqual(await device.estimateDayFromHistory('2026-03-15'), true);
    assert.ok(Math.abs(device.energyEstimates['2026-03-15'] - 1) < 1e-9, '1 kW for 1 hour');
    assert.ok(Math.abs(device.heatEstimates['2026-03-15'] - 3) < 1e-9, '3 kW for 1 hour');
    assert.strictEqual(device.runStats['2026-03-15'].starts, 1, 'the restart after the stop');
    assert.strictEqual(device.runStats['2026-03-15'].defrosts, 1);
    assert.strictEqual(device.runStats['2026-03-15'].defrostMinutes, 5);
    assert.ok(Math.abs(device.runStats['2026-03-15'].hours - 55 / 60) < 1e-9, 'running in 11 of 12 intervals');
    assert.strictEqual(device.getCapabilityValue('melpump_compressor_starts_today'), 1);
    assert.strictEqual(device.getCapabilityValue('melpump_defrosts_today'), 1);
  } finally {
    clock.restore();
  }
});

test('short runs the live readings caught are kept when the history misses them', async () => {
  const clock = fakeClock('2026-03-15T01:00:00Z');
  try {
    const device = await deviceWithHistory([[1, 3, 40, false], [1, 3, 40, false], [1, 3, 40, false]]);
    device.runStats['2026-03-15'] = {
      starts: 4, hours: 0.05, defrosts: 0, defrostMinutes: 0,
    };
    await device.estimateDayFromHistory('2026-03-15');
    const stats = device.runStats['2026-03-15'];
    assert.strictEqual(stats.starts, 4, 'live count is higher');
    assert.ok(Math.abs(stats.hours - 10 / 60) < 1e-9, 'history covers more running time');
  } finally {
    clock.restore();
  }
});

test('the widget\'s 24-hour graph is filled from history, keeping newer live readings', async () => {
  const clock = fakeClock('2026-03-15T00:20:00Z');
  try {
    const device = await deviceWithHistory([[1, 3, 40, false], [2, 6, 40, false], [1.5, 4, 40, false]]);
    const midnight = Date.parse('2026-03-15T00:00:00Z');
    // A live bucket after the history, and a stale one the history replaces.
    device.powerDay = [[midnight + FIVE_MINUTES, 9, 1], [midnight + 3 * FIVE_MINUTES, 1.2, 2]];

    await device.estimateDayFromHistory('2026-03-15');
    assert.deepStrictEqual(device.powerDay, [
      [midnight, 1, 1],
      [midnight + FIVE_MINUTES, 2, 1],
      [midnight + 2 * FIVE_MINUTES, 1.5, 1],
      [midnight + 3 * FIVE_MINUTES, 1.2, 2],
    ]);
  } finally {
    clock.restore();
  }
});

test('live heat adds up like energy, and only today is kept', async () => {
  const clock = fakeClock('2026-03-15T10:00:00Z');
  try {
    const device = await createDevice();
    device.deviceTimezone = 'UTC';
    device.heatEstimates = { '2026-03-14': 40 };
    // One reading a minute for an hour: 1 kW in, 4 kW out.
    for (let i = 0; i <= 60; i += 1) {
      await device.integratePower(1000, 4000);
      clock.advance(60000);
    }
    assert.deepStrictEqual(Object.keys(device.heatEstimates), ['2026-03-15']);
    assert.ok(Math.abs(device.heatEstimates['2026-03-15'] - 4) < 1e-9);
    assert.strictEqual(device.getWidgetStatus().today.cop, 4);
  } finally {
    clock.restore();
  }
});
