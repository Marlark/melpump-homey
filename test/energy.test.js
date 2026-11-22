'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createDevice, fakeClock } = require('./helpers');

// One item per requested day: 10 kWh used, 35 kWh heat (COP 3.5).
function energyApi(calls, { estimated = () => false } = {}) {
  return {
    getDailyEnergy: async (id, start, end) => {
      calls.push(`${start}..${end}`);
      const days = (Date.parse(end) - Date.parse(start)) / 864e5 + 1;
      return Array.from({ length: days }, () => ({
        Total: 10, ProducedTotal: 35, Heating: 7, ProducedHeating: 28, HotWater: 3, ProducedHotWater: 7,
        Cooling: 0, ProducedCooling: 0, OutdoorTemperature: 4.2, isEstimation: estimated(start),
      }));
    },
    getDayStates: async () => {
      calls.push('states');
      const day = Date.parse('2026-03-15T00:00:00Z');
      return [0, 1, 2].map((i) => ({ dateCreated: new Date(day + i * 300000).toISOString(), EstInputPower: 1.2 }));
    },
  };
}

test('month and year totals: completed months are fetched once and cached', async () => {
  const calls = [];
  const device = await createDevice({ api: energyApi(calls) });
  await device.updatePeriodStats('2026-03-15');

  // February (last month) and January, then March 1-14.
  assert.deepStrictEqual(calls, ['2026-02-01..2026-02-28', '2026-01-01..2026-01-31', '2026-03-01..2026-03-14']);
  const value = (id) => device.getCapabilityValue(id);
  assert.strictEqual(value('melpump_energy_this_month'), 140);
  assert.strictEqual(value('melpump_energy_last_month'), 280);
  assert.strictEqual(value('melpump_energy_this_year'), 730, '310 + 280 + 140');
  assert.strictEqual(value('melpump_cop_this_year'), 3.5);
  assert.strictEqual(device.store.periodStatsDay, '2026-03-14');

  calls.length = 0;
  await device.updatePeriodStats('2026-03-15');
  assert.strictEqual(calls.length, 0, 'done for today');
});

test('last month is only cached once its last day is published', async () => {
  // Just after midnight on April 1, MelPump hasn't published March 31 yet.
  const clock = fakeClock('2026-04-01T00:30:00Z');
  try {
    const calls = [];
    let published = false;
    const day = (time) => new Date(time).toISOString().slice(0, 10);
    const device = await createDevice({
      store: { energyCountedThrough: '2026-03-30', monthStats: {} },
      api: {
        getDailyEnergy: async (id, start, end) => {
          calls.push(`${start}..${end}`);
          const items = [];
          for (let time = Date.parse(start); time <= Date.parse(end); time += 864e5) {
            if (day(time) === '2026-03-31' && !published) continue;
            items.push({ Total: 10, ProducedTotal: 30, isEstimation: false });
          }
          return items;
        },
      },
    });
    device.deviceTimezone = 'UTC';
    device.historyNeeded = false;

    await device.pollEnergy();
    assert.strictEqual(device.getCapabilityValue('melpump_energy_last_month'), 300, 'shown without March 31');
    assert.strictEqual(device.store.monthStats['2026-03'], undefined, 'not cached');
    assert.strictEqual(device.store.periodStatsDay, undefined, 'checked again next hour');
    assert.strictEqual(device.store.scopDay, undefined);

    published = true;
    clock.advance(60 * 60 * 1000);
    await device.pollEnergy();
    assert.strictEqual(device.getCapabilityValue('melpump_energy_last_month'), 310, 'March 31 included');
    assert.deepStrictEqual(device.store.monthStats['2026-03'], { kWh: 310, heat: 930 });
    assert.strictEqual(device.store.periodStatsDay, '2026-03-31');
    assert.strictEqual(device.store.scopDay, '2026-03-31');
    assert.strictEqual(device.getCapabilityValue('melpump_energy_this_year'), 900, 'Jan 310 + Feb 280 + Mar 310');

    calls.length = 0;
    clock.advance(60 * 60 * 1000);
    await device.pollEnergy();
    assert.deepStrictEqual(calls, [], 'nothing more to fetch today');
  } finally {
    clock.restore();
  }
});

test('months cached by an earlier version are fetched again', async () => {
  const calls = [];
  const device = await createDevice({
    api: energyApi(calls),
    store: { monthStats: { '2026-02': { kWh: 1, heat: 1 }, '2026-01': { kWh: 1, heat: 1 } } },
  });
  await device.updatePeriodStats('2026-03-15');
  assert.strictEqual(device.getCapabilityValue('melpump_energy_last_month'), 280, 'not the old cached 1');
  assert.ok(device.store.monthStatsVersion > 1);

  calls.length = 0;
  device.forcePeriodStats = true;
  await device.updatePeriodStats('2026-03-15');
  assert.deepStrictEqual(calls, ['2026-03-01..2026-03-14'], 'the new cache is used');
});

test('yesterday\'s figures: an estimate is shown but fetched again until final', async () => {
  const calls = [];
  let estimate = true;
  const device = await createDevice({ api: energyApi(calls, { estimated: () => estimate }) });

  await device.updateYesterdayStats('2026-03-14', null);
  assert.strictEqual(device.getCapabilityValue('melpump_cop_yesterday'), 3.5);
  assert.strictEqual(device.getCapabilityValue('melpump_cop_heating_yesterday'), 4);
  assert.strictEqual(device.store.energyStatsDay, undefined, 'not marked done');

  estimate = false;
  await device.updateYesterdayStats('2026-03-14', null);
  assert.match(device.store.energyStatsDay, /^2026-03-14:v\d+$/);
  calls.length = 0;
  await device.updateYesterdayStats('2026-03-14', null);
  assert.strictEqual(calls.length, 0);
});

test('today\'s state history is only fetched after a gap in the live readings', async () => {
  const clock = fakeClock('2026-03-15T12:00:00Z');
  try {
    const calls = [];
    const device = await createDevice({ api: energyApi(calls), store: { energyCountedThrough: '2026-03-14' } });
    device.deviceTimezone = 'UTC';

    await device.pollEnergy();
    assert.ok(calls.includes('states'), 'after start');
    assert.strictEqual(device.historyNeeded, false);
    assert.ok(device.energyEstimates['2026-03-15'] > 0);

    calls.length = 0;
    await device.pollEnergy();
    assert.ok(!calls.includes('states'), 'live readings complete');

    device.historyNeeded = true;
    await device.pollEnergy();
    assert.ok(calls.includes('states'), 'after a gap');
  } finally {
    clock.restore();
  }
});

test('the energy meter adds completed days and never goes backwards', async () => {
  const clock = fakeClock('2026-03-15T12:00:00Z');
  try {
    const calls = [];
    const device = await createDevice({ api: energyApi(calls), store: { energyCountedThrough: '2026-03-12', energyBase: 100 } });
    device.deviceTimezone = 'UTC';
    device.historyNeeded = false;
    device.energyEstimates = { '2026-03-13': 9, '2026-03-15': 4 };

    await device.pollEnergy();
    assert.strictEqual(device.store.energyCountedThrough, '2026-03-14');
    assert.strictEqual(device.store.energyBase, 120);
    assert.deepStrictEqual(device.energyEstimates, { '2026-03-15': 4 }, 'counted days drop their estimate');
    assert.strictEqual(device.getCapabilityValue('meter_power'), 124);

    // A lower estimate later doesn't move the meter back.
    device.energyEstimates['2026-03-15'] = 1;
    await device.updateMeter();
    assert.strictEqual(device.getCapabilityValue('meter_power'), 124);
  } finally {
    clock.restore();
  }
});

test('warnings: offline before subscription before missing data', async () => {
  const device = await createDevice({
    api: { getDeviceAccess: async () => ({ subscriptionActive: false, writeAccess: false }) },
  });
  device.store.writeAccess = true;

  await device.checkAccess();
  assert.strictEqual(device.store.writeAccess, false);
  device.dataWarning = 'no data';
  await device.refreshWarning();
  assert.strictEqual(device.warning, 'device.subscription_inactive');

  device.offlineReason = 'offline';
  await device.refreshWarning();
  assert.strictEqual(device.warning, 'offline');

  device.offlineReason = null;
  device.subscriptionWarning = null;
  await device.refreshWarning();
  assert.strictEqual(device.warning, 'no data');
});

test('power and compressor values are cleared while there is no current reading', async () => {
  const device = await createDevice();
  const live = {
    measure_power: 1200,
    melpump_heat_output: 4200,
    melpump_compressor_frequency: 40,
    melpump_flow_rate: 12.5,
    melpump_defrost: true,
    melpump_immersion_heater: false,
    melpump_booster_heater: false,
  };
  const fill = () => Object.entries(live).forEach(([id, value]) => device.capabilities.set(id, value));
  fill();
  device.capabilities.set('measure_cop', 3.5);
  device.capabilities.set('measure_temperature.outdoor', 4);

  // MelPump says the heat pump went offline.
  await device.applyDevice({ online: false, integrationActive: true, zoneTwoActive: false });
  for (const id of Object.keys(live)) assert.strictEqual(device.getCapabilityValue(id), null, id);
  assert.strictEqual(device.getCapabilityValue('measure_cop'), 3.5, 'the COP keeps its last value');
  assert.strictEqual(device.getCapabilityValue('measure_temperature.outdoor'), 4, 'temperatures stay');

  // Online, but MelPump has no data.
  await device.applyDevice({ online: true, integrationActive: true, zoneTwoActive: false });
  fill();
  await device.applyCurrentState({ state: null, dataQuality: 2 });
  assert.strictEqual(device.getCapabilityValue('measure_power'), null);
  assert.strictEqual(device.getCapabilityValue('melpump_compressor_frequency'), null);
});
