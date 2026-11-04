'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createDevice } = require('./helpers');

const state = (values = {}) => ({
  power: true,
  OperationMode: 2,
  HeatPumpFrequency: 40,
  FlowTemperature: 38.4,
  ReturnTemperature: 33.1,
  OperationModeZone1: 2,
  ...values,
});

test('zone 1 mode and flow/return sensors are added when the heat pump reports them', async () => {
  const device = await createDevice();
  await device.applyState(state({ FlowTemperatureZone1: 35.2, ReturnTemperatureZone1: 30.0, FlowTemperatureBoiler: 0 }));

  assert.strictEqual(device.getCapabilityValue('melpump_zone_mode'), 'heat_curve');
  assert.strictEqual(device.getCapabilityValue('measure_temperature.flow_zone1'), 35.2);
  assert.strictEqual(device.getCapabilityValue('measure_temperature.return_zone1'), 30);
  assert.strictEqual(device.getCapabilityValue('melpump_delta_t.zone1'), 5.2);
  assert.strictEqual(device.getCapabilityValue('melpump_delta_t'), 5.3, 'main circuit');
  assert.ok(!device.hasCapability('measure_temperature.flow_boiler'), '0 means no sensor');
  assert.ok(!device.hasCapability('measure_temperature.return_zone2'));
});

test('a zone mode change fires the trigger, filtered by zone', async () => {
  const device = await createDevice();
  await device.applyState(state());
  assert.ok(!device.fired.some((f) => f.trigger === 'zoneModeChangedTrigger'), 'not for the first value');

  await device.applyState(state({ OperationModeZone1: 0 }));
  const fired = device.fired.filter((f) => f.trigger === 'zoneModeChangedTrigger');
  assert.strictEqual(fired.length, 1);
  assert.strictEqual(fired[0].tokens.zone, 1);
  assert.deepStrictEqual(fired[0].state, { zone: '1' });
  assert.match(fired[0].tokens.mode, /room/i);
  assert.match(fired[0].tokens.previous, /curve/i);

  assert.strictEqual(device.isZoneMode('1', 'room_control'), true);
  assert.strictEqual(device.isZoneMode('1', 'heat_curve'), false);
  assert.strictEqual(device.isZoneMode('2', 'room_control'), false, 'no zone 2');
  assert.throws(() => device.isZoneMode('3', 'room_control'), /invalid_zone/);
});

test('an unknown zone mode number is ignored', async () => {
  const device = await createDevice();
  await device.applyState(state({ OperationModeZone1: 99 }));
  assert.ok(!device.hasCapability('melpump_zone_mode'));
});

test('night mode, summer eco and solar mode settings from MelPump', async () => {
  const device = await createDevice();
  await device.updateZone2(true);
  await device.applySettings({
    nightModeStartHour: '22:00',
    nightModeEndHour: '1970-01-01T06:30:00+00:00',
    nightModeZone1Temp: 19,
    nightModeZone2Temp: 18.5,
    summerEcoSchedule: false,
    solarModeHours: 4,
    solarModePreferredHour: 13,
    solarTankTemp: 55,
    solarZone1Temp: 23,
    solarZone2Temp: null,
    solarModePvPower: 11,
  });
  const settings = device.getSettings();
  assert.strictEqual(settings.info_night_hours, '22:00–06:30');
  assert.strictEqual(settings.info_night_temps, 'device.info_zone {"zone":1} 19 °C · device.info_zone {"zone":2} 18.5 °C');
  assert.strictEqual(settings.info_summer_eco_hours, 'device.no_schedule');
  assert.strictEqual(settings.info_solar_temps, 'device.info_hot_water 55 °C · device.info_zone {"zone":1} 23 °C');
  assert.strictEqual(settings.info_solar_pv, 'device.pv_over_10');

  await device.applySettings({ summerEcoSchedule: true, summerEcoStartHour: '7', summerEcoEndHour: 'x', solarModePvPower: 6 });
  assert.strictEqual(device.getSettings().info_summer_eco_hours, '-');
  assert.strictEqual(device.getSettings().info_solar_pv, '6 kW');
  assert.strictEqual(device.getSettings().info_night_hours, '-');
});

test('"night mode activated" tells when night mode ends', async () => {
  const device = await createDevice();
  await device.applySettings({ nightModeEnabled: false, nightModeEndHour: '06:00' });
  await device.applySettings({ nightModeEnabled: true, nightModeEndHour: '06:00' });
  const fired = device.fired.find((f) => f.trigger === 'nightModeActivatedTrigger');
  assert.deepStrictEqual(fired.tokens, { ends: '06:00' });
});

test('a zone 2 capability that can\'t be added is not a failed poll', async () => {
  const device = await createDevice();
  const add = device.addCapability;
  device.addCapability = async (id) => {
    if (id === 'melpump_zone_active.zone2') throw new Error('Homey says no');
    return add(id);
  };
  await device.updateZone2(true);
  assert.ok(!device.hasCapability('melpump_zone_active.zone2'));
  assert.ok(device.hasCapability('melpump_zone_mode.zone2'), 'the others are still added');
  assert.ok(device.logs.some((line) => line.includes('Homey says no')));

  device.addCapability = add;
  await device.updateZone2(true);
  assert.ok(device.hasCapability('melpump_zone_active.zone2'), 'tried again at the next device fetch');
});
