'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { Driver, createDevice, fakeClock } = require('./helpers');

const MINUTE = 60000;

/** The driver with every Flow card's run listener, to test the filters. */
async function driverCards() {
  const cards = {};
  const card = (id) => {
    if (!cards[id]) {
      cards[id] = {
        id,
        registerRunListener(fn) {
          this.listener = fn;
          return this;
        },
      };
    }
    return cards[id];
  };
  const driver = Object.create(Driver.prototype);
  driver.log = () => {};
  driver.homey = {
    app: { debugMode: false },
    flow: { getDeviceTriggerCard: card, getConditionCard: card, getActionCard: card },
  };
  await driver.onInit();
  return cards;
}

test('short cycling: starts in the last hour, the trigger fires once per Flow limit', async () => {
  const clock = fakeClock('2026-03-15T10:00:00Z');
  try {
    const device = await createDevice();
    device.deviceTimezone = 'UTC';
    // Run 5 minutes, stop 5 minutes, four times.
    for (let cycle = 0; cycle < 4; cycle += 1) {
      for (let i = 0; i < 5; i += 1) {
        await device.trackRuns(i === 0 && cycle === 0 ? 0 : 40, false);
        clock.advance(MINUTE);
      }
      for (let i = 0; i < 5; i += 1) {
        await device.trackRuns(0, false);
        clock.advance(MINUTE);
      }
    }
    const fired = device.fired.filter((f) => f.trigger === 'shortCyclingTrigger');
    assert.deepStrictEqual(fired.map((f) => f.state.starts), [1, 2, 3, 4]);
    assert.strictEqual(device.getCapabilityValue('melpump_avg_run_minutes_today'), 5);

    const { short_cycling: card } = await driverCards();
    assert.strictEqual(await card.listener({ starts: 4 }, { starts: 4 }), true);
    assert.strictEqual(await card.listener({ starts: 4 }, { starts: 3 }), false);
    assert.strictEqual(await card.listener({ starts: 4 }, { starts: 5 }), false, 'only when the limit is reached');

    // Starts older than an hour no longer count.
    clock.advance(2 * 60 * MINUTE);
    await device.trackRuns(0, false);
    clock.advance(MINUTE);
    await device.trackRuns(40, false);
    assert.strictEqual(device.fired.filter((f) => f.trigger === 'shortCyclingTrigger').pop().state.starts, 1);
  } finally {
    clock.restore();
  }
});

test('immersion and booster heater: minutes today and "on for a long time"', async () => {
  const clock = fakeClock('2026-03-15T10:00:00Z');
  try {
    const device = await createDevice();
    device.deviceTimezone = 'UTC';
    for (let i = 0; i <= 30; i += 1) {
      const heaters = { immersion: i < 30, booster: false };
      await device.trackRuns(40, false, heaters);
      await device.trackHeaters(heaters);
      clock.advance(MINUTE);
    }
    assert.strictEqual(device.getCapabilityValue('melpump_immersion_minutes_today'), 30);
    assert.strictEqual(device.getCapabilityValue('melpump_booster_minutes_today'), 0);

    const states = device.fired.filter((f) => f.trigger === 'heaterOnLongTrigger').map((f) => f.state);
    assert.strictEqual(states.length, 29, 'every minute while on');
    assert.deepStrictEqual(states[19], { heater: 'immersion', minutes: 20, previous: 19 });

    const { heater_on_long: card } = await driverCards();
    const args = { device, heater: 'any', minutes: 20 };
    const results = await Promise.all(states.map((state) => card.listener(args, state)));
    assert.strictEqual(results.filter(Boolean).length, 1, 'once when 20 minutes is reached');
    assert.strictEqual(await card.listener({ ...args, heater: 'booster' }, states[19]), false, 'other heater');
    assert.ok(!device.heaterOnSince.immersion, 'reset when it switches off');
  } finally {
    clock.restore();
  }
});

test('room temperature deviation: fires once after the deviation lasted long enough', async () => {
  const clock = fakeClock('2026-03-15T10:00:00Z');
  try {
    const device = await createDevice();
    const { room_temperature_deviates: card } = await driverCards();
    const args = {
      device, zone: '1', direction: 'below', degrees: 1.5, minutes: 30,
    };
    device.capabilities.set('target_temperature', 21);

    // 10 minutes fine, then 60 minutes 2 °C too cold.
    const results = [];
    for (let i = 0; i < 70; i += 1) {
      device.capabilities.set('measure_temperature', i < 10 ? 20.8 : 19);
      await device.trackRoomTemperatures();
      const { state } = device.fired.filter((f) => f.trigger === 'roomTemperatureDeviatesTrigger').pop();
      results.push(await card.listener(args, state));
      clock.advance(MINUTE);
    }
    assert.deepStrictEqual(results.map((r, i) => (r ? i : null)).filter((i) => i !== null), [40]);

    // Above, or the other zone, doesn't match.
    const { state } = device.fired.pop();
    assert.strictEqual(device.roomDeviationReached({ ...args, direction: 'above' }, state), false);
    assert.strictEqual(device.roomDeviationReached({ ...args, zone: '2' }, state), false);
  } finally {
    clock.restore();
  }
});

test('room temperature deviation: a gap in the readings starts the wait over', async () => {
  const clock = fakeClock('2026-03-15T10:00:00Z');
  try {
    const device = await createDevice();
    device.capabilities.set('target_temperature', 21);
    device.capabilities.set('measure_temperature', 19);
    for (let i = 0; i < 20; i += 1) {
      await device.trackRoomTemperatures();
      clock.advance(MINUTE);
    }
    clock.advance(30 * MINUTE);
    await device.trackRoomTemperatures();
    assert.strictEqual(device.roomHistory[1].length, 1);
    assert.deepStrictEqual(device.roomHistory[2], [], 'no zone 2');
  } finally {
    clock.restore();
  }
});

test('hot water ready: fires when the target is reached, again only after hot water is used', async () => {
  const device = await createDevice();
  const tank = async (temperature) => {
    device.capabilities.set('melpump_tank_temperature', temperature);
    await device.checkHotWaterReady();
  };
  device.capabilities.set('target_temperature.tank', 50);
  const count = () => device.fired.filter((f) => f.trigger === 'hotWaterReadyTrigger').length;

  await tank(51); // already ready at start: no trigger
  assert.strictEqual(count(), 0);
  await tank(47); // a little used: not re-armed
  await tank(49.5);
  assert.strictEqual(count(), 0);
  await tank(42); // used
  assert.strictEqual(device.isHotWaterReady(), false);
  await tank(49);
  assert.strictEqual(count(), 1);
  assert.deepStrictEqual(device.fired.pop().tokens, { temperature: 49, target: 50 });
  assert.strictEqual(device.isHotWaterReady(), true);
  await tank(50);
  assert.strictEqual(count(), 0, 'no repeat');
});

async function writableDevice() {
  const sent = [];
  const device = await createDevice({
    api: { setDeviceState: async (id, body) => { sent.push(body); return { success: true }; } },
  });
  device.store.writeAccess = true;
  device.deviceTimezone = 'Europe/Stockholm';
  return { device, sent };
}

test('hot water boost ends when the time is up or the hot water is ready', async () => {
  const clock = fakeClock('2026-03-15T10:00:00Z');
  try {
    const { device, sent } = await writableDevice();
    device.capabilities.set('target_temperature.tank', 50);
    device.capabilities.set('melpump_tank_temperature', 40);

    await device.boostHotWater(30);
    assert.deepStrictEqual(sent, [{ forceHotWater: true }]);
    assert.strictEqual(device.store.boostUntil, Date.now() + 30 * MINUTE);

    clock.advance(10 * MINUTE);
    await device.endTimedFunctions();
    assert.strictEqual(sent.length, 1, 'still heating');

    device.capabilities.set('melpump_tank_temperature', 49.5);
    await device.endTimedFunctions();
    assert.deepStrictEqual(sent[1], { forceHotWater: false }, 'ready');
    assert.strictEqual(device.boostUntil, null);

    // Time up while still cold.
    device.capabilities.set('melpump_tank_temperature', 40);
    await device.boostHotWater(5);
    clock.advance(6 * MINUTE);
    await device.endTimedFunctions();
    assert.deepStrictEqual(sent[3], { forceHotWater: false });

    await assert.rejects(device.boostHotWater(1), /invalid_boost_minutes/);
  } finally {
    clock.restore();
  }
});

test('holiday mode until a date and time in the heat pump\'s time zone', async () => {
  const clock = fakeClock('2026-03-15T10:00:00Z');
  try {
    const { device, sent } = await writableDevice();
    assert.strictEqual(device.getCapabilityValue('melpump_holiday_until'), 'device.holiday_no_end');

    await device.turnOnHolidayUntil('20-03-2026', '18:00');
    assert.deepStrictEqual(sent, [{ HolidayMode: true }]);
    assert.strictEqual(device.holidayUntil, Date.parse('2026-03-20T17:00:00Z'), 'Stockholm is UTC+1 in March');
    assert.strictEqual(device.getCapabilityValue('melpump_holiday_until'), '2026-03-20 18:00');

    // After the switch to summer time the offset is +2.
    await device.turnOnHolidayUntil('15-07-2026', '18:00');
    assert.strictEqual(device.holidayUntil, Date.parse('2026-07-15T16:00:00Z'));

    clock.set('2026-07-15T16:00:00Z');
    await device.endTimedFunctions();
    assert.deepStrictEqual(sent[sent.length - 1], { HolidayMode: false });
    assert.strictEqual(device.holidayUntil, null);
    assert.strictEqual(device.getCapabilityValue('melpump_holiday_until'), 'device.holiday_no_end');

    await assert.rejects(device.turnOnHolidayUntil('01-01-2026', '12:00'), /invalid_end_time/, 'in the past');
    await assert.rejects(device.turnOnHolidayUntil('2026-08-01', '12:00'), /invalid_end_time/, 'wrong format');
  } finally {
    clock.restore();
  }
});

test('switching off by hand cancels the timed end', async () => {
  const { device } = await writableDevice();
  await device.boostHotWater(60);
  await device.turnOnHolidayUntil('20-12-2099', '12:00');
  await device.setFunction('force_hot_water', false);
  await device.setFunction('holiday', false);
  assert.strictEqual(device.boostUntil, null);
  assert.strictEqual(device.holidayUntil, null);
});
