'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createDevice, fakeClock } = require('./helpers');

const state = (values = {}) => ({
  power: true,
  OperationMode: 2,
  HeatPumpFrequency: 40,
  EstCop: 3.4,
  TankWaterTemperature: 46,
  TargetHCTemperatureZone1: 35,
  HasError: false,
  ...values,
});

const fired = (device, trigger) => device.fired.filter((f) => f.trigger === trigger);

test('the live state fires triggers only for changes, not for the first reading', async () => {
  const device = await createDevice();
  device.deviceTimezone = 'UTC';
  await device.applyState(state());
  for (const trigger of ['operationStateChangedTrigger', 'tankFellBelowTrigger', 'targetFlowChangedTrigger', 'errorReportedTrigger']) {
    assert.strictEqual(fired(device, trigger).length, 0, trigger);
  }
  assert.deepStrictEqual(fired(device, 'copChangedTrigger').map((f) => f.tokens), [{ cop: 3.4 }], 'the first COP');

  await device.applyState(state({
    OperationMode: 1, TankWaterTemperature: 41, TargetHCTemperatureZone1: 33, EstCop: 3.1, HasError: true, ErrorCode: 'E4',
  }));
  assert.deepStrictEqual(fired(device, 'operationStateChangedTrigger').map((f) => f.tokens), [
    { state: device.enumTitle('melpump_operation_state', 'tank_water'), previous: device.enumTitle('melpump_operation_state', 'heating') },
  ]);
  const tank = fired(device, 'tankFellBelowTrigger')[0];
  assert.deepStrictEqual([tank.tokens, tank.state], [{ temperature: 41 }, { previous: 46, current: 41 }]);
  assert.strictEqual(fired(device, 'tankRoseAboveTrigger').length, 1, 'both fire; their run listeners check the limit');
  assert.deepStrictEqual(fired(device, 'targetFlowChangedTrigger').map((f) => f.tokens), [{ temperature: 33 }]);
  assert.deepStrictEqual(fired(device, 'copChangedTrigger').map((f) => f.tokens.cop), [3.4, 3.1]);
  assert.deepStrictEqual(fired(device, 'errorReportedTrigger').map((f) => f.tokens), [{ error_code: 'E4' }]);

  // The error goes on: no new trigger. A stopped compressor keeps the last COP.
  await device.applyState(state({
    OperationMode: 1, TankWaterTemperature: 41, TargetHCTemperatureZone1: 33, HeatPumpFrequency: 0, EstCop: 0, HasError: true,
  }));
  assert.strictEqual(fired(device, 'errorReportedTrigger').length, 1);
  assert.strictEqual(device.getCapabilityValue('measure_cop'), 3.1);
  assert.strictEqual(fired(device, 'copChangedTrigger').length, 2);
});

test('the mode: off when switched off, heating without cooling, unknown when switched on elsewhere', async () => {
  const device = await createDevice();
  device.capabilities.set('melpump_mode', 'auto');

  await device.applyState(state({ power: false, OperationMode: 0 }));
  assert.strictEqual(device.getCapabilityValue('melpump_mode'), 'off');
  assert.strictEqual(device.getCapabilityValue('melpump_operation_state'), 'off');
  assert.deepStrictEqual(fired(device, 'modeChangedTrigger').length, 1);

  // Switched on in the MelPump app: heating or auto isn't reported, so it's unknown.
  await device.applyState(state({ power: true, OperationMode: 0 }));
  assert.strictEqual(device.getCapabilityValue('melpump_mode'), null);
  assert.strictEqual(device.getCapabilityValue('melpump_operation_state'), 'standby', 'mode 0 while on is idle');

  device.features = { ...device.features, canCool: false };
  await device.applyState(state({ power: true }));
  assert.strictEqual(device.getCapabilityValue('melpump_mode'), 'heating', 'the only "on" mode');
});

test('device details: offline reasons, installation info and legionella', async () => {
  const clock = fakeClock('2026-03-15T12:00:00Z');
  try {
    const device = await createDevice();
    const base = {
      timezone: 'Europe/Stockholm', online: true, integrationActive: true, zoneTwoActive: false,
      model: 'Ecodan PUZ-WM85', serialNumber: 'X1', heatingPower: 85, heatingSurface: 140,
      installationType: 'underfloor', integrationType: 'MELCloud',
    };
    await device.applyDevice({ ...base, lastLegionella: '2026-03-10T03:00:00Z' });
    assert.strictEqual(device.deviceTimezone, 'Europe/Stockholm');
    assert.strictEqual(device.store.timezone, 'Europe/Stockholm');
    assert.deepStrictEqual(
      ['info_model', 'info_heating_power', 'info_heating_surface', 'info_installation_type', 'info_integration_type']
        .map((key) => device.getSetting(key)),
      ['Ecodan PUZ-WM85', '8.5 kW', '140 m²', 'installation_type.underfloor', 'MELCloud'],
    );
    assert.strictEqual(device.getCapabilityValue('melpump_last_legionella'), '2026-03-10 04:00');
    assert.strictEqual(fired(device, 'legionellaCompletedTrigger').length, 0, 'no trigger for the first one seen');

    await device.applyDevice({ ...base, lastLegionella: '2026-03-15T03:00:00Z' });
    assert.deepStrictEqual(fired(device, 'legionellaCompletedTrigger').map((f) => f.tokens), [{ time: '2026-03-15 04:00' }]);
    await device.applyDevice({ ...base, lastLegionella: 'not a date' });
    assert.strictEqual(fired(device, 'legionellaCompletedTrigger').length, 1);

    await device.applyDevice({ ...base, integrationActive: false });
    assert.strictEqual(device.offlineReason, 'device.integration_inactive');
    await device.applyDevice({ ...base, online: false, lastSeenAt: '2026-03-15T10:30:00Z' });
    assert.strictEqual(device.offlineReason, 'device.offline_since {"time":"11:30"}');
    await device.applyDevice({ ...base, online: false, lastSeenAt: null });
    assert.strictEqual(device.offlineReason, 'device.offline');

    await device.applyDevice({
      ...base, online: false, model: '', heatingPower: 0, heatingSurface: null, installationType: 'other_kind',
    });
    assert.deepStrictEqual(
      ['info_model', 'info_heating_power', 'info_heating_surface', 'info_installation_type'].map((key) => device.getSetting(key)),
      ['-', '-', '-', 'other_kind'],
    );
    assert.strictEqual(device.catchUp, false);
    await device.applyDevice(base);
    assert.strictEqual(device.offlineReason, null);
    assert.strictEqual(device.catchUp, true, 'back online: skipped checks run at the next poll');
  } finally {
    clock.restore();
  }
});

test('MelPump settings: function triggers, notifications, solar functions and Smart Energy switched', async () => {
  const device = await createDevice({ settings: { saving_notifications: true, solar_notifications: false } });
  const settings = (values = {}) => ({
    smartEnergyEnabled: false, nightModeEnabled: false, solarPanelEnabled: false, summerEcoEnabled: false,
    smartEnergyActive: true, nightModeActive: true, summerEcoActive: false,
    solarTankActive: true, solarZone1Active: false, nightModeEndHour: '06:30',
    ...values,
  });

  await device.applySettings(settings());
  assert.deepStrictEqual(device.fired, [], 'nothing for the first values');

  await device.applySettings(settings({
    smartEnergyEnabled: true, nightModeEnabled: true, solarPanelEnabled: true, summerEcoEnabled: true,
    solarTankActive: false, smartEnergyActive: false,
  }));
  const names = device.fired.map((f) => f.trigger || `notification: ${f.notification}`);
  assert.deepStrictEqual(names, [
    'savingModeActivatedTrigger',
    'notification: device.saving_started {"name":"Heat pump"}',
    'solarModeStartedTrigger',
    'nightModeActivatedTrigger',
    'summerEcoActivatedTrigger',
    'solarFunctionSwitchedTrigger',
    'smartEnergySwitchedOffTrigger',
  ]);
  assert.deepStrictEqual(fired(device, 'nightModeActivatedTrigger')[0].tokens, { ends: '06:30' });
  assert.deepStrictEqual(fired(device, 'solarFunctionSwitchedTrigger')[0].state, { target: 'solar_hot_water', state: 'off' });

  device.fired.length = 0;
  await device.applySettings(settings({ smartEnergyActive: true }));
  assert.deepStrictEqual(device.fired.map((f) => f.trigger || 'notification'), [
    'savingModeDeactivatedTrigger',
    'notification',
    'solarModeStoppedTrigger',
    'nightModeDeactivatedTrigger',
    'summerEcoDeactivatedTrigger',
    'solarFunctionSwitchedTrigger',
    'smartEnergySwitchedOnTrigger',
  ]);
});

test('MelPump settings shown on the settings page', async () => {
  const device = await createDevice();
  await device.applySettings({
    solarModeHours: 3, solarModePreferredHour: 9, solarModePvPower: 11,
    solarTankTemp: 55, solarZone1Temp: 22.25, solarZone2Temp: 21,
    nightModeStartHour: '22', nightModeEndHour: '2026-03-15T06:00:00', nightModeZone1Temp: 19,
    summerEcoSchedule: false,
  });
  assert.deepStrictEqual(
    ['info_solar_hours', 'info_solar_preferred_hour', 'info_solar_pv', 'info_solar_temps', 'info_night_hours', 'info_night_temps', 'info_summer_eco_hours']
      .map((key) => device.getSetting(key)),
    [
      '3 h', '09:00', 'device.pv_over_10',
      'device.info_hot_water 55 °C · device.info_zone {"zone":1} 22.3 °C',
      '22:00–06:00', 'device.info_zone {"zone":1} 19 °C', 'device.no_schedule',
    ],
  );

  await device.updateZone2(true);
  await device.applySettings({
    solarModePvPower: 6, solarZone2Temp: 21, nightModeStartHour: '25', summerEcoStartHour: '10', summerEcoEndHour: '16',
  });
  assert.deepStrictEqual(
    ['info_solar_hours', 'info_solar_preferred_hour', 'info_solar_pv', 'info_solar_temps', 'info_night_hours', 'info_summer_eco_hours']
      .map((key) => device.getSetting(key)),
    ['-', 'device.no_preferred_hour', '6 kW', 'device.info_zone {"zone":2} 21 °C', '-', '10:00–16:00'],
  );
});
