'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  Driver, MelPumpApi, createDevice, manifest,
} = require('./helpers');

/**
 * The driver with every Flow card it registers, keyed "type:id", and its log lines.
 * @param {object} [options]
 * @param {boolean} [options.debugMode]
 */
async function flowDriver({ debugMode = false } = {}) {
  const cards = {};
  const logs = [];
  const card = (type) => (id) => {
    const key = `${type}:${id}`;
    if (!cards[key]) {
      cards[key] = {
        id,
        registerRunListener(fn) {
          this.listener = fn;
          return this;
        },
        on() {
          return this;
        },
        trigger: async () => {},
      };
    }
    return cards[key];
  };
  const driver = Object.create(Driver.prototype);
  driver.homey = {
    __: (key) => key,
    app: { debugMode },
    flow: { getDeviceTriggerCard: card('trigger'), getConditionCard: card('condition'), getActionCard: card('action') },
  };
  driver.getDevices = () => [];
  // Own log/error, so this test sees what the driver logs.
  driver.log = (...args) => logs.push(args.join(' '));
  driver.error = (...args) => logs.push(`ERROR ${args.join(' ')}`);
  await driver.onInit();
  return { driver, cards, logs };
}

/** A device that records which of its methods a Flow card calls. */
function recordingDevice(calls) {
  return new Proxy({ getName: () => 'Home' }, {
    get(target, name) {
      if (name in target) return target[name];
      return async (...args) => { calls.push([name, ...args]); return `${String(name)} result`; };
    },
  });
}

test('every condition and action card in app.json has a run listener', async () => {
  const { cards } = await flowDriver();
  for (const type of ['condition', 'action']) {
    for (const { id } of manifest.flow[`${type}s`]) {
      assert.strictEqual(typeof (cards[`${type}:${id}`] || {}).listener, 'function', `${type} ${id}`);
    }
  }
  for (const { id } of manifest.flow.triggers) {
    assert.ok(cards[`trigger:${id}`], `trigger ${id} is fetched by the driver`);
  }
});

test('conditions on capabilities: true only for true, and numbers above the limit', async () => {
  const { cards } = await flowDriver();
  const device = await createDevice();
  const run = (id, args = {}) => cards[`condition:${id}`].listener({ device, ...args });

  for (const [id, capability] of [
    ['saving_mode_active', 'melpump_saving_mode'],
    ['night_mode_running', 'melpump_night_mode'],
    ['summer_eco_running', 'melpump_summer_eco'],
    ['solar_mode_active', 'melpump_solar_mode'],
    ['is_defrosting', 'melpump_defrost'],
    ['immersion_heater_on', 'melpump_immersion_heater'],
    ['booster_heater_on', 'melpump_booster_heater'],
  ]) {
    for (const [value, expected] of [[true, true], [false, false], [null, false]]) {
      device.capabilities.set(capability, value);
      assert.strictEqual(await run(id), expected, `${id} with ${value}`);
    }
  }

  device.capabilities.set('measure_cop', 3.5);
  assert.strictEqual(await run('cop_above', { cop: 3 }), true);
  assert.strictEqual(await run('cop_above', { cop: 3.5 }), false, 'above, not equal');
  device.capabilities.set('measure_cop', null);
  assert.strictEqual(await run('cop_above', { cop: 0 }), false, 'unknown COP');

  device.capabilities.set('melpump_tank_temperature', 48);
  assert.strictEqual(await run('tank_temperature_above', { temperature: 45 }), true);
  assert.strictEqual(await run('tank_temperature_above', { temperature: 48 }), false);
  device.capabilities.set('melpump_tank_temperature', null);
  assert.strictEqual(await run('tank_temperature_above', { temperature: 0 }), false);

  device.capabilities.set('melpump_compressor_frequency', 42);
  assert.strictEqual(await run('compressor_running'), true);
  device.capabilities.set('melpump_compressor_frequency', 0);
  assert.strictEqual(await run('compressor_running'), false);
  device.capabilities.set('melpump_compressor_frequency', null);
  assert.strictEqual(await run('compressor_running'), false, 'unknown, e.g. offline');

  device.capabilities.set('melpump_alarms_unacknowledged', 2);
  assert.strictEqual(await run('has_unacknowledged_alarms'), true);
  device.capabilities.set('melpump_alarms_unacknowledged', 0);
  assert.strictEqual(await run('has_unacknowledged_alarms'), false);
});

test('conditions that ask the device pass their arguments on', async () => {
  const { cards } = await flowDriver();
  const calls = [];
  const device = recordingDevice(calls);
  await cards['condition:function_active'].listener({ device, function: 'quiet' });
  await cards['condition:zone_active'].listener({ device, zone: '2' });
  await cards['condition:zone_mode_is'].listener({ device, zone: '1', mode: 'heat_curve' });
  await cards['condition:hot_water_ready_is'].listener({ device });
  assert.deepStrictEqual(calls, [
    ['isFunctionActive', 'quiet'],
    ['isZoneActive', '2'],
    ['isZoneMode', '1', 'heat_curve'],
    ['isHotWaterReady'],
  ]);
});

test('every action card calls the right device method with the right arguments', async () => {
  const { cards } = await flowDriver();
  const cases = {
    set_melpump_mode: [{ mode: 'heating' }, ['setMode', 'heating']],
    set_function: [{ function: 'quiet', state: 'on' }, ['setFunction', 'quiet', true]],
    set_saving_mode: [{ state: 'off' }, ['setSavingMode', false]],
    force_solar_mode: [{ minutes: 90 }, ['forceSolarMode', 90]],
    force_solar_until: [{ time: '15:30' }, ['forceSolarUntil', '15:30']],
    clear_solar_mode: [{}, ['clearSolarMode']],
    set_hot_water_temperature: [{ temperature: 52 }, ['setHotWaterTemperature', 52]],
    apply_preset: [{ preset: 'away' }, ['applyPreset', 'away']],
    apply_hot_water_preset: [{ preset: 'comfort' }, ['applyHotWaterPreset', 'comfort']],
    boost_hot_water: [{ minutes: 60 }, ['boostHotWater', 60]],
    holiday_until: [{ date: '24-12-2026', time: '18:00' }, ['turnOnHolidayUntil', '24-12-2026', '18:00']],
    acknowledge_alarms: [{}, ['acknowledgeAlarms']],
    acknowledge_alarm: [{ id: 17 }, ['acknowledgeAlarm', 17]],
    block_function: [{ action: 'block', target: 'hot_water' }, ['setBlocked', 'hot_water', true]],
    set_curve_correction: [{ zone: '1', correction: -2 }, ['setCurveCorrection', '1', -2]],
    set_flow_temperature: [{ zone: '2', kind: 'cooling', temperature: 18 }, ['setFlowTemperature', '2', 'cooling', 18]],
    set_zone_mode: [{ zone: '1', mode: 'room_control' }, ['setZoneMode', '1', 'room_control']],
  };
  assert.deepStrictEqual(Object.keys(cases).sort(), manifest.flow.actions.map((c) => c.id).sort(), 'one case per action card');

  for (const [id, [args, expected]] of Object.entries(cases)) {
    const calls = [];
    await cards[`action:${id}`].listener({ device: recordingDevice(calls), ...args });
    assert.deepStrictEqual(calls, [expected], id);
  }

  // The other choice of the on/off and block/unblock arguments.
  const calls = [];
  await cards['action:set_function'].listener({ device: recordingDevice(calls), function: 'quiet', state: 'off' });
  await cards['action:set_saving_mode'].listener({ device: recordingDevice(calls), state: 'on' });
  await cards['action:block_function'].listener({ device: recordingDevice(calls), action: 'unblock', target: 'heating' });
  assert.deepStrictEqual(calls, [['setFunction', 'quiet', false], ['setSavingMode', true], ['setBlocked', 'heating', false]]);
});

test('an action that fails passes the error on to the Flow', async () => {
  const { cards } = await flowDriver();
  const device = { getName: () => 'Home', setMode: async () => { throw new Error('device.no_write_access'); } };
  await assert.rejects(cards['action:set_melpump_mode'].listener({ device, mode: 'off' }), /no_write_access/);
});

test('debug mode logs every Flow action and every trigger', async () => {
  const { driver, cards, logs } = await flowDriver({ debugMode: true });
  const calls = [];
  await cards['action:force_solar_mode'].listener({ device: recordingDevice(calls), minutes: 30 });
  assert.ok(logs.includes('[debug] Home: Flow action force_solar_mode {"minutes":30}'), logs.join('\n'));

  await driver.copChangedTrigger.trigger({ getName: () => 'Home' }, { cop: 3.2 });
  assert.ok(logs.includes('[debug] Home: trigger cop_changed {"cop":3.2} '), logs.join('\n'));
});

/** A pairing or repair session: the handlers the driver sets. */
function session() {
  const handlers = {};
  return { handlers, setHandler: (name, fn) => { handlers[name] = fn; } };
}

/** Lets MelPumpApi.getDevices answer with `result` (a list, or an error to throw). */
function stubDevices(t, result) {
  const original = MelPumpApi.prototype.getDevices;
  const keys = [];
  MelPumpApi.prototype.getDevices = async function getDevices() {
    keys.push(this.apiKey);
    if (result instanceof Error) throw result;
    return result;
  };
  t.after(() => { MelPumpApi.prototype.getDevices = original; });
  return keys;
}

test('pairing: the token is checked, then its heat pumps are listed with it', async (t) => {
  const { driver } = await flowDriver();
  const keys = stubDevices(t, [
    { id: '42', name: 'Home', writeAccess: true },
    { id: '43', name: 'Cabin', writeAccess: false },
  ]);
  const s = session();
  await driver.onPair(s);

  await assert.rejects(s.handlers.list_devices(), /pair\.not_logged_in/, 'not before the token');
  await assert.rejects(s.handlers.login({ apiKey: 'secret' }), /pair\.invalid_key_format/);
  assert.strictEqual(await s.handlers.login({ apiKey: '  api_token  ' }), true);
  assert.deepStrictEqual(keys, ['api_token'], 'trimmed');
  assert.deepStrictEqual(await s.handlers.list_devices(), [
    { name: 'Home', data: { id: '42' }, store: { apiKey: 'api_token', writeAccess: true } },
    { name: 'Cabin', data: { id: '43' }, store: { apiKey: 'api_token', writeAccess: false } },
  ]);
});

test('pairing: a rejected token and other errors give clear messages', async (t) => {
  const { driver, logs } = await flowDriver();
  const rejected = new MelPumpApi.MelPumpApiError('melpump.com rejected the API token', { status: 401 });
  stubDevices(t, rejected);
  const s = session();
  await driver.onPair(s);
  await assert.rejects(s.handlers.login({ apiKey: 'api_wrong' }), (err) => {
    assert.strictEqual(err.message, 'pair.invalid_key');
    assert.strictEqual(err.cause, rejected, 'the original error is kept');
    return true;
  });
  assert.ok(logs.some((line) => line.startsWith('ERROR Token check failed:')));

  MelPumpApi.prototype.getDevices = async () => { throw new Error('Could not reach melpump.com: timeout'); };
  await assert.rejects(s.handlers.login({ apiKey: 'api_token' }), /Could not reach melpump\.com: timeout/);
});

test('repair: a token without this heat pump is refused; others with the old token get the new one', async (t) => {
  const { driver } = await flowDriver();
  stubDevices(t, [{ id: '42', writeAccess: true }, { id: '43', writeAccess: false }]);
  const updates = [];
  const heatPump = (id, apiKey) => ({
    getData: () => ({ id }),
    getStoreValue: (key) => (key === 'apiKey' ? apiKey : null),
    updateApiKey: async (key, writeAccess) => { updates.push([id, key, writeAccess]); },
  });
  const home = heatPump('42', 'api_old');
  const cabin = heatPump('43', 'api_old');
  const garage = heatPump('44', 'api_old'); // the new token has no access to it
  const other = heatPump('45', 'api_other'); // another token: left alone
  driver.getDevices = () => [home, cabin, garage, other];

  const missing = session();
  await driver.onRepair(missing, heatPump('99', 'api_old'));
  await assert.rejects(missing.handlers.login({ apiKey: 'api_new' }), /repair\.device_not_found/);
  assert.deepStrictEqual(updates, []);

  const s = session();
  await driver.onRepair(s, home);
  assert.strictEqual(await s.handlers.login({ apiKey: 'api_new' }), true);
  assert.deepStrictEqual(updates, [['42', 'api_new', true], ['43', 'api_new', false]]);

  // The same token again: only this heat pump.
  updates.length = 0;
  const same = session();
  await driver.onRepair(same, heatPump('42', 'api_new'));
  await same.handlers.login({ apiKey: 'api_new' });
  assert.deepStrictEqual(updates, [['42', 'api_new', true]]);
});
