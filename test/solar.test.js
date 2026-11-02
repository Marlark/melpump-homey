'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createDevice, fakeClock } = require('./helpers');

async function solarDevice() {
  const forced = [];
  const device = await createDevice({
    api: { forceSolarMode: async (id, minutes) => { forced.push(minutes); return { success: true }; } },
  });
  device.store.writeAccess = true;
  device.deviceTimezone = 'Europe/Stockholm';
  return { device, forced };
}

test('"force solar mode until" counts minutes in the heat pump\'s time zone', async () => {
  const clock = fakeClock('2026-11-01T10:00:00Z'); // 11:00 in Stockholm
  try {
    const { device, forced } = await solarDevice();
    await device.forceSolarUntil('13:30');
    assert.deepStrictEqual(forced, [150]);
    assert.strictEqual(device.getCapabilityValue('melpump_solar_forced_until'), '13:30');

    // A time that has passed today means tomorrow.
    await device.forceSolarUntil('09:00');
    assert.strictEqual(forced[1], 22 * 60);
    assert.strictEqual(device.getCapabilityValue('melpump_solar_forced_until'), '2026-11-02 09:00');

    await assert.rejects(device.forceSolarUntil('25:00'), /device\.invalid_time/);
    await assert.rejects(device.forceSolarMode(0), /device\.invalid_solar_minutes/);
    assert.strictEqual(forced.length, 2);
  } finally {
    clock.restore();
  }
});

test('"forced solar mode has ended" fires once when the time has passed', async () => {
  const clock = fakeClock('2026-11-01T10:00:00Z');
  try {
    const { device } = await solarDevice();
    await device.forceSolarMode(30);
    assert.strictEqual(device.store.forcedSolarUntil, Date.now() + 30 * 60000);

    clock.advance(29 * 60000);
    await device.updateForcedSolar();
    assert.ok(!device.fired.some((f) => f.trigger === 'forcedSolarEndedTrigger'));

    clock.advance(2 * 60000);
    await device.updateForcedSolar();
    await device.updateForcedSolar();
    assert.strictEqual(device.fired.filter((f) => f.trigger === 'forcedSolarEndedTrigger').length, 1);
    assert.strictEqual(device.store.forcedSolarUntil, null);
    assert.strictEqual(device.getCapabilityValue('melpump_solar_forced_until'), 'device.solar_not_forced');
  } finally {
    clock.restore();
  }
});

test('an end long past (app not running) is cleared without the trigger', async () => {
  const clock = fakeClock('2026-11-01T10:00:00Z');
  try {
    const { device } = await solarDevice();
    await device.forceSolarMode(10);
    clock.advance(60 * 60000);
    await device.updateForcedSolar();
    assert.ok(!device.fired.some((f) => f.trigger === 'forcedSolarEndedTrigger'));
    assert.strictEqual(device.forcedSolarUntil, null);
  } finally {
    clock.restore();
  }
});
