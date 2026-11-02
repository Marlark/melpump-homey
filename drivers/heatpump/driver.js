'use strict';

const Homey = require('homey');
const MelPumpApi = require('../../lib/melpump_api');

class HeatPumpDriver extends Homey.Driver {

  async onInit() {
    this.copChangedTrigger = this.homey.flow.getDeviceTriggerCard('cop_changed');
    this.savingModeActivatedTrigger = this.homey.flow.getDeviceTriggerCard('saving_mode_activated');
    this.savingModeDeactivatedTrigger = this.homey.flow.getDeviceTriggerCard('saving_mode_deactivated');
    this.smartEnergySwitchedOnTrigger = this.homey.flow.getDeviceTriggerCard('smart_energy_switched_on');
    this.smartEnergySwitchedOffTrigger = this.homey.flow.getDeviceTriggerCard('smart_energy_switched_off');
    this.solarModeStartedTrigger = this.homey.flow.getDeviceTriggerCard('solar_mode_started');
    this.solarModeStoppedTrigger = this.homey.flow.getDeviceTriggerCard('solar_mode_stopped');
    this.forcedSolarEndedTrigger = this.homey.flow.getDeviceTriggerCard('forced_solar_ended');
    this.solarFunctionSwitchedTrigger = this.homey.flow.getDeviceTriggerCard('solar_function_switched')
      .registerRunListener(async (args, state) => args.target === state.target && args.state === state.state);
    this.summerEcoActivatedTrigger = this.homey.flow.getDeviceTriggerCard('summer_eco_activated');
    this.summerEcoDeactivatedTrigger = this.homey.flow.getDeviceTriggerCard('summer_eco_deactivated');
    this.compressorStartedTrigger = this.homey.flow.getDeviceTriggerCard('compressor_started');
    this.compressorStoppedTrigger = this.homey.flow.getDeviceTriggerCard('compressor_stopped');
    this.targetFlowChangedTrigger = this.homey.flow.getDeviceTriggerCard('target_flow_changed');
    // state = { previous, current } tank temperature; fires only when the threshold is crossed.
    this.tankFellBelowTrigger = this.homey.flow.getDeviceTriggerCard('tank_temperature_fell_below')
      .registerRunListener(async (args, state) => state.previous >= args.temperature && state.current < args.temperature);
    this.tankRoseAboveTrigger = this.homey.flow.getDeviceTriggerCard('tank_temperature_rose_above')
      .registerRunListener(async (args, state) => state.previous <= args.temperature && state.current > args.temperature);
    this.nightModeActivatedTrigger = this.homey.flow.getDeviceTriggerCard('night_mode_activated');
    this.nightModeDeactivatedTrigger = this.homey.flow.getDeviceTriggerCard('night_mode_deactivated');
    this.errorReportedTrigger = this.homey.flow.getDeviceTriggerCard('error_reported');
    this.alarmTriggeredTrigger = this.homey.flow.getDeviceTriggerCard('alarm_triggered');
    this.legionellaCompletedTrigger = this.homey.flow.getDeviceTriggerCard('legionella_completed');
    this.alarmTypeTriggeredTrigger = this.homey.flow.getDeviceTriggerCard('alarm_type_triggered')
      .registerRunListener(async (args, state) => args.type === state.type);
    this.modeChangedTrigger = this.homey.flow.getDeviceTriggerCard('mode_changed');
    this.zoneModeChangedTrigger = this.homey.flow.getDeviceTriggerCard('zone_mode_changed')
      .registerRunListener(async (args, state) => args.zone === 'any' || args.zone === state.zone);
    // Fired at every start with the starts of the last hour; each Flow fires when its number is reached.
    this.shortCyclingTrigger = this.homey.flow.getDeviceTriggerCard('short_cycling')
      .registerRunListener(async (args, state) => state.starts === args.starts);
    // Checked every reading; the device fires them only when one of its Flows matches
    // (see anyFlowMatches), and each Flow fires when its own limit is reached.
    this.heaterOnLongTrigger = this.homey.flow.getDeviceTriggerCard('heater_on_long')
      .registerRunListener(async (args, state) => args.device.heaterLimitReached(args, state));
    this.roomTemperatureDeviatesTrigger = this.homey.flow.getDeviceTriggerCard('room_temperature_deviates')
      .registerRunListener(async (args, state) => args.device.roomDeviationReached(args, state));
    // A Flow using them was added or changed: the devices read the Flows again.
    for (const card of [this.heaterOnLongTrigger, this.roomTemperatureDeviatesTrigger]) {
      if (typeof card.on === 'function') {
        card.on('update', () => this.getDevices().forEach((device) => { device.argsCache = {}; }));
      }
    }
    this.hotWaterReadyTrigger = this.homey.flow.getDeviceTriggerCard('hot_water_ready');
    this.operationStateChangedTrigger = this.homey.flow.getDeviceTriggerCard('operation_state_changed');

    this.registerConditions();
    this.registerActions();
    if (this.homey.app.debugMode) this.logTriggers();

    this.log('HeatPump driver has been initialized');
  }

  registerConditions() {
    const capabilityIsTrue = {
      saving_mode_active: 'melpump_saving_mode',
      night_mode_running: 'melpump_night_mode',
      summer_eco_running: 'melpump_summer_eco',
      solar_mode_active: 'melpump_solar_mode',
      is_defrosting: 'melpump_defrost',
      immersion_heater_on: 'melpump_immersion_heater',
      booster_heater_on: 'melpump_booster_heater',
    };

    for (const [cardId, capability] of Object.entries(capabilityIsTrue)) {
      this.homey.flow.getConditionCard(cardId)
        .registerRunListener(async ({ device }) => device.getCapabilityValue(capability) === true);
    }

    this.homey.flow.getConditionCard('cop_above')
      .registerRunListener(async ({ device, cop }) => {
        const value = device.getCapabilityValue('measure_cop');
        return value !== null && value > cop;
      });

    this.homey.flow.getConditionCard('has_unacknowledged_alarms')
      .registerRunListener(async ({ device }) => device.hasUnacknowledgedAlarms());

    this.homey.flow.getConditionCard('compressor_running')
      .registerRunListener(async ({ device }) => (device.getCapabilityValue('melpump_compressor_frequency') || 0) > 0);

    this.homey.flow.getConditionCard('tank_temperature_above')
      .registerRunListener(async ({ device, temperature }) => {
        const value = device.getCapabilityValue('melpump_tank_temperature');
        return value !== null && value > temperature;
      });

    this.homey.flow.getConditionCard('function_active')
      .registerRunListener(async ({ device, function: fn }) => device.isFunctionActive(fn));

    this.homey.flow.getConditionCard('zone_active')
      .registerRunListener(async ({ device, zone }) => device.isZoneActive(zone));

    this.homey.flow.getConditionCard('zone_mode_is')
      .registerRunListener(async ({ device, zone, mode }) => device.isZoneMode(zone, mode));

    this.homey.flow.getConditionCard('hot_water_ready_is')
      .registerRunListener(async ({ device }) => device.isHotWaterReady());
  }

  registerActions() {
    const actions = {
      set_melpump_mode: ({ device, mode }) => device.setMode(mode),
      set_function: ({ device, function: fn, state }) => device.setFunction(fn, state === 'on'),
      set_saving_mode: ({ device, state }) => device.setSavingMode(state === 'on'),
      force_solar_mode: ({ device, minutes }) => device.forceSolarMode(minutes),
      force_solar_until: ({ device, time }) => device.forceSolarUntil(time),
      clear_solar_mode: ({ device }) => device.clearSolarMode(),
      set_hot_water_temperature: ({ device, temperature }) => device.setHotWaterTemperature(temperature),
      apply_preset: ({ device, preset }) => device.applyPreset(preset),
      apply_hot_water_preset: ({ device, preset }) => device.applyHotWaterPreset(preset),
      boost_hot_water: ({ device, minutes }) => device.boostHotWater(minutes),
      holiday_until: ({ device, date, time }) => device.turnOnHolidayUntil(date, time),
      acknowledge_alarms: ({ device }) => device.acknowledgeAlarms(),
      acknowledge_alarm: ({ device, id }) => device.acknowledgeAlarm(id),
      block_function: ({ device, action, target }) => device.setBlocked(target, action === 'block'),
      set_curve_correction: ({ device, zone, correction }) => device.setCurveCorrection(zone, correction),
      set_flow_temperature: ({
        device, zone, kind, temperature,
      }) => device.setFlowTemperature(zone, kind, temperature),
      set_zone_mode: ({ device, zone, mode }) => device.setZoneMode(zone, mode),
    };

    for (const [cardId, run] of Object.entries(actions)) {
      this.homey.flow.getActionCard(cardId)
        .registerRunListener(async (args) => {
          if (this.homey.app.debugMode) {
            const { device, ...rest } = args;
            this.log('[debug]', `${device.getName()}: Flow action ${cardId}`, JSON.stringify(rest));
          }
          await run(args);
        });
    }
  }

  /**
   * Debug mode only: logs every trigger fired, with its tokens and state.
   */
  logTriggers() {
    for (const [name, card] of Object.entries(this)) {
      if (!name.endsWith('Trigger') || !card || typeof card.trigger !== 'function') continue;
      const trigger = card.trigger.bind(card);
      card.trigger = (device, tokens, state) => {
        this.log('[debug]', `${device.getName()}: trigger ${card.id || name}`, JSON.stringify(tokens || {}), state ? JSON.stringify(state) : '');
        return trigger(device, tokens, state);
      };
    }
  }

  /**
   * SDK v3 pairing. The custom "start" view emits "login" with the user's
   * melpump.com API token; the built-in list_devices template then calls the
   * "list_devices" handler (onPairListDevices has no access to the token,
   * so the handler is set here).
   */
  async onPair(session) {
    let apiKey = null;
    let devices = null;

    session.setHandler('login', async ({ apiKey: enteredKey }) => {
      const key = String(enteredKey || '').trim();
      devices = await this.fetchDevicesWithKey(key);
      apiKey = key;
      return true;
    });

    session.setHandler('list_devices', async () => {
      if (!apiKey) {
        throw new Error(this.homey.__('pair.not_logged_in'));
      }

      return devices.map((device) => ({
        name: device.name,
        data: {
          id: device.id,
        },
        store: {
          apiKey,
          writeAccess: device.writeAccess,
        },
      }));
    });
  }

  /**
   * Replaces the API token of an existing device, e.g. after the old token was
   * revoked or expired. The new token must have access to this same heat pump.
   */
  async onRepair(session, device) {
    session.setHandler('login', async ({ apiKey: enteredKey }) => {
      const key = String(enteredKey || '').trim();
      const devices = await this.fetchDevicesWithKey(key);

      const match = devices.find((d) => d.id === device.getData().id);
      if (!match) {
        throw new Error(this.homey.__('repair.device_not_found'));
      }

      await device.updateApiKey(key, match.writeAccess);
      return true;
    });
  }

  /**
   * Validates a token by listing its devices (doubles as the token check).
   * @param {string} key
   */
  async fetchDevicesWithKey(key) {
    if (!MelPumpApi.isValidKeyFormat(key)) {
      throw new Error(this.homey.__('pair.invalid_key_format'));
    }

    const api = new MelPumpApi({
      apiKey: key,
      log: (...args) => this.log('[pair]', ...args),
      debug: this.homey.app.debugMode ? (...args) => this.log('[debug] [pair]', ...args) : null,
    });
    try {
      return await api.getDevices();
    } catch (err) {
      this.error('Token check failed:', err.message);
      if (err instanceof MelPumpApi.MelPumpApiError && err.isAuthError) {
        throw new Error(this.homey.__('pair.invalid_key'));
      }
      throw new Error(err.message);
    }
  }

}

module.exports = HeatPumpDriver;
