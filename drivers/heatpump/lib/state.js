'use strict';

const {
  HEATERS, SOLAR_FUNCTIONS, OPERATION_STATES, FEATURE_CAPABILITIES, ZONE_MODE_IDS, ZONE_MODE_CAPABILITIES,
  LIVE_CAPABILITIES, ZONE2_CAPABILITIES, OPTIONAL_CAPABILITIES, INSTALLATION_TYPES,
} = require('./constants');
const { difference, toNumber, toBoolean, toWatt, round, clockTime, dateTimeInZone } = require('./helpers');

/**
 * Applying what MelPump reports: the live state, the device details and its settings,
 * features and zone 2.
 * Part of HeatPumpDevice (drivers/heatpump/device.js), which adds these methods to itself.
 */
class HeatPumpState {

  /**
   * @param {{ state: object|null, dataQuality: number|null }} current
   */
  async applyCurrentState(current) {
    // dataQuality 2 = no data: keep the last values rather than storing blanks or zeros.
    if (!current || !current.state || current.dataQuality === 2) {
      this.lastPowerSample = null;
      await this.clearLiveValues();
      this.dataWarning = this.homey.__('device.no_data');
      await this.refreshWarning();
      return;
    }

    this.dataWarning = null;
    await this.refreshWarning();
    await this.applyState(current.state);
    this.lastStateAt = Date.now();
  }

  /**
   * Clears LIVE_CAPABILITIES while there is no current reading; the next one fills them.
   */
  async clearLiveValues() {
    for (const capability of LIVE_CAPABILITIES) {
      if (!this.hasCapability(capability) || this.getCapabilityValue(capability) === null) continue;
      await this.setCapabilityValue(capability, null).catch(this.error);
    }
  }

  async applyState(state) {
    const previousCop = this.getCapabilityValue('measure_cop');
    const previousError = this.getCapabilityValue('alarm_generic');
    const power = toBoolean(state.power);
    if (power !== null) this.lastPower = power;

    // MelPump reports OperationMode 0 ("Off") also when the pump is on but idle;
    // only show "off" when it is actually switched off.
    let operationState = OPERATION_STATES[toNumber(state.OperationMode)] || null;
    if (operationState === 'off' && power !== false) operationState = 'standby';

    // EstCop is 0 while the compressor is stopped. Keep the last real COP instead,
    // so Insights averages and the "COP changed" trigger aren't flooded with zeros.
    const frequency = toNumber(state.HeatPumpFrequency);
    const estCop = toNumber(state.EstCop);
    const runningCop = frequency !== 0 && estCop !== null && estCop > 0 ? estCop : null;

    let mode;
    if (power === false) {
      mode = 'off';
    } else if (power === true && this.features.canCool === false) {
      // Without cooling there is only one "on" mode, so the state is known.
      mode = 'heating';
    } else if (power === true && this.getCapabilityValue('melpump_mode') === 'off') {
      // Switched on elsewhere; the API doesn't report which of heating/cooling/auto is configured.
      mode = null;
    }

    const heaters = Object.fromEntries(Object.entries(HEATERS).map(([heater, read]) => [heater, read(state)]));

    await this.addOptionalCapabilities(state);

    const previousOperationState = this.getCapabilityValue('melpump_operation_state');
    const previousTank = this.getCapabilityValue('melpump_tank_temperature');
    const previousTargetFlow = this.getCapabilityValue('melpump_target_flow_temperature');
    const previousZoneModes = ZONE_MODE_CAPABILITIES.map((capability) => this.getCapabilityValue(capability));
    const optionalValues = {};
    for (const { capability, field, read } of OPTIONAL_CAPABILITIES) {
      optionalValues[capability] = read ? read(state) : toNumber(state[field]);
    }

    await this.updateCapabilities({
      ...optionalValues,
      'melpump_zone_mode.zone2': ZONE_MODE_IDS[toNumber(state.OperationModeZone2)] || null,
      melpump_delta_t: difference(toNumber(state.FlowTemperature), toNumber(state.ReturnTemperature)),
      melpump_target_flow_temperature: toNumber(state.TargetHCTemperatureZone1),
      'melpump_target_flow_temperature.zone2': toNumber(state.TargetHCTemperatureZone2),
      'measure_temperature.flow_zone2': toNumber(state.FlowTemperatureZone2),
      melpump_zone_active: toBoolean(state.isZone1),
      'melpump_zone_active.zone2': toBoolean(state.isZone2),
      measure_temperature: toNumber(state.RoomTemperatureZone1),
      'measure_temperature.outdoor': toNumber(state.OutdoorTemperature),
      melpump_tank_temperature: toNumber(state.TankWaterTemperature),
      'measure_temperature.flow': toNumber(state.FlowTemperature),
      'measure_temperature.return': toNumber(state.ReturnTemperature),
      'measure_temperature.zone2': toNumber(state.RoomTemperatureZone2),
      target_temperature: toNumber(state.SetTemperatureZone1),
      'target_temperature.tank': toNumber(state.SetTankWaterTemperature),
      'target_temperature.zone2': toNumber(state.SetTemperatureZone2),
      measure_cop: runningCop,
      measure_power: toWatt(state.EstInputPower),
      melpump_heat_output: toWatt(state.EstOutputPower),
      melpump_compressor_frequency: frequency,
      melpump_flow_rate: toNumber(state.FlowRate),
      melpump_operation_state: operationState,
      melpump_defrost: toBoolean(state.DefrostMode),
      melpump_immersion_heater: heaters.immersion,
      melpump_booster_heater: heaters.booster,
      alarm_generic: toBoolean(state.HasError),
    });

    await this.integratePower(toWatt(state.EstInputPower), toWatt(state.EstOutputPower));
    this.recordPower(toNumber(state.EstInputPower));
    await this.trackRuns(frequency, toBoolean(state.DefrostMode), heaters);
    await this.trackHeaters(heaters);
    await this.trackRoomTemperatures();
    await this.checkHotWaterReady();

    // Threshold triggers; the run listeners check which thresholds were crossed.
    const tank = this.getCapabilityValue('melpump_tank_temperature');
    if (previousTank !== null && tank !== null && tank !== previousTank) {
      const tankState = { previous: previousTank, current: tank };
      await this.driver.tankFellBelowTrigger.trigger(this, { temperature: tank }, tankState).catch(this.error);
      await this.driver.tankRoseAboveTrigger.trigger(this, { temperature: tank }, tankState).catch(this.error);
    }

    const targetFlow = this.getCapabilityValue('melpump_target_flow_temperature');
    if (previousTargetFlow !== null && targetFlow !== null && targetFlow !== previousTargetFlow) {
      await this.driver.targetFlowChangedTrigger.trigger(this, { temperature: targetFlow }).catch(this.error);
    }

    // Zone mode changed (in MelPump, on the heat pump, or by a Flow).
    for (const [i, capability] of ZONE_MODE_CAPABILITIES.entries()) {
      const zoneMode = this.getCapabilityValue(capability);
      const previous = previousZoneModes[i];
      if (previous === null || zoneMode === null || zoneMode === previous) continue;
      await this.driver.zoneModeChangedTrigger
        .trigger(this, {
          zone: i + 1,
          mode: this.enumTitle('melpump_zone_mode', zoneMode),
          previous: this.enumTitle('melpump_zone_mode', previous),
        }, { zone: String(i + 1) })
        .catch(this.error);
    }

    const previousMode = this.getCapabilityValue('melpump_mode');
    if (mode !== undefined && previousMode !== mode) {
      await this.setCapabilityValue('melpump_mode', mode).catch(this.error);
      await this.triggerModeChanged(previousMode, mode);
    }

    // previousOperationState is null right after pairing; don't fire for the first value.
    if (operationState && previousOperationState && operationState !== previousOperationState) {
      await this.driver.operationStateChangedTrigger
        .trigger(this, {
          state: this.enumTitle('melpump_operation_state', operationState),
          previous: this.enumTitle('melpump_operation_state', previousOperationState),
        })
        .catch(this.error);
    }

    const cop = this.getCapabilityValue('measure_cop');
    if (cop !== null && cop !== previousCop) {
      await this.driver.copChangedTrigger
        .trigger(this, { cop })
        .catch(this.error);
    }

    // previousError is null right after pairing; don't fire for an error that already existed.
    if (this.getCapabilityValue('alarm_generic') === true && previousError === false) {
      await this.driver.errorReportedTrigger
        .trigger(this, { error_code: state.ErrorCode ? String(state.ErrorCode) : '' })
        .catch(this.error);
    }
  }

  /**
   * Adds the sensors from OPTIONAL_CAPABILITIES that this heat pump turns out to have.
   * @param {object} state DeviceState
   */
  async addOptionalCapabilities(state) {
    for (const {
      capability, field, read, zeroMeansMissing, groundSourceOnly, options,
    } of OPTIONAL_CAPABILITIES) {
      if (this.hasCapability(capability)) continue;
      if (groundSourceOnly && !this.hasGroundSource) continue;

      const value = read ? read(state) : toNumber(state[field]);
      if (value === null || (zeroMeansMissing && value === 0)) continue;

      try {
        await this.addCapability(capability);
        if (options) await this.setCapabilityOptions(capability, options);
        this.log(`Added ${capability}: the heat pump reports ${JSON.stringify(value)}${field ? ` (${field})` : ''}`);
      } catch (err) {
        this.error(`Could not add ${capability}:`, err.message);
      }
    }
  }

  /**
   * Fills the read-only "Installation" fields on the device settings page.
   * @param {object} device Device
   */
  async updateInstallationInfo(device) {
    const installationType = INSTALLATION_TYPES.includes(device.installationType)
      ? this.homey.__(`installation_type.${device.installationType}`)
      : device.installationType;
    // heatingPower is reported x10 (140 = 14 kW).
    const heatingPower = toNumber(device.heatingPower);
    const heatingSurface = toNumber(device.heatingSurface);

    const info = {
      info_model: device.model || '-',
      info_serial_number: device.serialNumber || '-',
      info_heating_power: heatingPower ? `${round(heatingPower / 10, 1)} kW` : '-',
      info_heating_surface: heatingSurface ? `${heatingSurface} m²` : '-',
      info_installation_type: installationType || '-',
      info_integration_type: device.integrationType || '-',
    };

    const current = this.getSettings();
    const changed = Object.fromEntries(Object.entries(info).filter(([key, value]) => current[key] !== value));
    if (Object.keys(changed).length) await this.setSettings(changed).catch(this.error);
  }

  async applyDevice(device) {
    if (device.timezone && device.timezone !== this.deviceTimezone) {
      this.deviceTimezone = device.timezone;
      await this.setStoreValue('timezone', device.timezone).catch(this.error);
    }
    this.hasGroundSource = device.hasGroundSource === true;
    await this.updateInstallationInfo(device);
    await this.updateFeatures(device);

    const lastSeen = device.lastSeenAt ? new Date(device.lastSeenAt) : null;
    this.lastSeenAt = lastSeen && !Number.isNaN(lastSeen.getTime()) ? lastSeen.getTime() : null;
    const lastSeenText = this.lastSeenAt ? this.formatMoment(this.lastSeenAt) : null;
    if (lastSeenText) await this.updateCapabilities({ melpump_last_seen: lastSeenText });

    // integrationActive = the link to the manufacturer cloud (e.g. MELCloud);
    // online = MelPump has received fresh readings recently.
    let offlineReason = null;
    if (device.integrationActive === false) {
      offlineReason = this.homey.__('device.integration_inactive');
    } else if (device.online === false) {
      offlineReason = lastSeenText
        ? this.homey.__('device.offline_since', { time: lastSeenText })
        : this.homey.__('device.offline');
    }
    if (Boolean(offlineReason) !== Boolean(this.offlineReason)) {
      // Don't integrate power across the offline period.
      this.lastPowerSample = null;
      if (offlineReason) await this.clearLiveValues();
      if (!offlineReason) this.catchUp = true;
      this.log(offlineReason ? `Heat pump offline: ${offlineReason}` : 'Heat pump back online');
    }
    this.offlineReason = offlineReason;

    // Only a reported value changes zone 2: removing its capabilities loses their Insights
    // and breaks the Flows that use them, so a response without the field keeps it as it is.
    if (typeof device.zoneTwoActive === 'boolean') await this.updateZone2(device.zoneTwoActive);
    await this.applyLegionella(device.lastLegionella || null);

    if (device.deviceSettings) {
      this.deviceSettings = device.deviceSettings;
      await this.applySettings(device.deviceSettings);
    }
  }

  async applyLegionella(lastLegionella) {
    if (!lastLegionella) return;
    const date = new Date(lastLegionella);
    if (Number.isNaN(date.getTime())) return;

    const formatted = dateTimeInZone(date, this.deviceTimezone);
    await this.updateCapabilities({ melpump_last_legionella: formatted });

    const previous = this.getStoreValue('lastLegionella');
    if (previous === lastLegionella) return;
    // No previous value right after pairing; only fire for runs seen while the app was running.
    if (previous) {
      await this.driver.legionellaCompletedTrigger
        .trigger(this, { time: formatted })
        .catch(this.error);
    }
    await this.setStoreValue('lastLegionella', lastLegionella).catch(this.error);
  }

  async applySettings(settings) {
    const previousSaving = this.getCapabilityValue('melpump_saving_mode');
    const previousNight = this.getCapabilityValue('melpump_night_mode');
    const previousSolar = this.getCapabilityValue('melpump_solar_mode');
    const previousSummerEco = this.getCapabilityValue('melpump_summer_eco');

    // *Enabled = currently running and changing device settings; *Active = feature switched on.
    await this.updateCapabilities({
      melpump_saving_mode: toBoolean(settings.smartEnergyEnabled),
      melpump_night_mode: toBoolean(settings.nightModeEnabled),
      melpump_solar_mode: toBoolean(settings.solarPanelEnabled),
      melpump_summer_eco: toBoolean(settings.summerEcoEnabled),
      // Switched on/off, for the toggles on the device page.
      melpump_smart_energy_switch: toBoolean(settings.smartEnergyActive),
      melpump_night_mode_switch: toBoolean(settings.nightModeActive),
      melpump_summer_eco_switch: toBoolean(settings.summerEcoActive),
    });

    const saving = await this.triggerOnSwitch('melpump_saving_mode', previousSaving,
      this.driver.savingModeActivatedTrigger, this.driver.savingModeDeactivatedTrigger);
    if (saving !== null && this.getSetting('saving_notifications') === true) {
      await this.notify(saving ? 'device.saving_started' : 'device.saving_stopped');
    }

    const solar = await this.triggerOnSwitch('melpump_solar_mode', previousSolar,
      this.driver.solarModeStartedTrigger, this.driver.solarModeStoppedTrigger);
    if (solar !== null && this.getSetting('solar_notifications') === true) {
      await this.notify(solar ? 'device.solar_started' : 'device.solar_stopped');
    }

    await this.triggerOnSwitch('melpump_night_mode', previousNight,
      this.driver.nightModeActivatedTrigger, this.driver.nightModeDeactivatedTrigger,
      { ends: clockTime(settings.nightModeEndHour) || '-' });
    await this.triggerOnSwitch('melpump_summer_eco', previousSummerEco,
      this.driver.summerEcoActivatedTrigger, this.driver.summerEcoDeactivatedTrigger);

    // Solar functions switched on/off. Not stored, so changes made while the app
    // wasn't running don't fire after a restart.
    for (const [target, field] of Object.entries(SOLAR_FUNCTIONS)) {
      const on = toBoolean(settings[field]);
      if (on === null) continue;
      const before = this.solarFunctions[target];
      this.solarFunctions[target] = on;
      if (before === undefined || before === on) continue;
      await this.driver.solarFunctionSwitchedTrigger
        .trigger(this, {}, { target, state: on ? 'on' : 'off' })
        .catch(this.error);
    }

    await this.updateSolarSettings(settings);
    await this.updateNightSettings(settings);

    // Smart Energy switched on/off (not whether it is running). Not stored, so a
    // change made while the app wasn't running doesn't fire after a restart.
    const switchedOn = toBoolean(settings.smartEnergyActive);
    if (switchedOn !== null && this.smartEnergySwitchedOn !== null && switchedOn !== this.smartEnergySwitchedOn) {
      await (switchedOn ? this.driver.smartEnergySwitchedOnTrigger : this.driver.smartEnergySwitchedOffTrigger)
        .trigger(this)
        .catch(this.error);
    }
    if (switchedOn !== null) this.smartEnergySwitchedOn = switchedOn;
  }

  /**
   * Shows MelPump's solar mode configuration (read-only) on the settings page.
   * @param {object} settings DeviceSettings
   */
  async updateSolarSettings(settings) {
    const hours = toNumber(settings.solarModeHours);
    const preferred = toNumber(settings.solarModePreferredHour);
    // solarModePvPower: 3-10 kW, 11 = over 10 kW.
    const pv = toNumber(settings.solarModePvPower);
    let pvText = '-';
    if (pv === 11) pvText = this.homey.__('device.pv_over_10');
    else if (pv) pvText = `${pv} kW`;

    await this.setInfoSettings({
      info_solar_hours: hours === null ? '-' : `${hours} h`,
      info_solar_preferred_hour: preferred === null
        ? this.homey.__('device.no_preferred_hour')
        : `${String(preferred).padStart(2, '0')}:00`,
      info_solar_temps: this.formatTemperatures([
        [this.homey.__('device.info_hot_water'), settings.solarTankTemp],
        [this.homey.__('device.info_zone', { zone: 1 }), settings.solarZone1Temp],
        [this.homey.__('device.info_zone', { zone: 2 }), this.hasZone2() ? settings.solarZone2Temp : null],
      ]),
      info_solar_pv: pvText,
    });
  }

  /**
   * Shows MelPump's night mode and summer eco schedule (read-only) on the settings page.
   * @param {object} settings DeviceSettings
   */
  async updateNightSettings(settings) {
    const range = (start, end) => {
      const from = clockTime(start);
      const to = clockTime(end);
      return from && to ? `${from}–${to}` : null;
    };
    await this.setInfoSettings({
      info_night_hours: range(settings.nightModeStartHour, settings.nightModeEndHour) || '-',
      info_night_temps: this.formatTemperatures([
        [this.homey.__('device.info_zone', { zone: 1 }), settings.nightModeZone1Temp],
        [this.homey.__('device.info_zone', { zone: 2 }), this.hasZone2() ? settings.nightModeZone2Temp : null],
      ]),
      info_summer_eco_hours: settings.summerEcoSchedule === false
        ? this.homey.__('device.no_schedule')
        : range(settings.summerEcoStartHour, settings.summerEcoEndHour) || '-',
    });
  }

  /**
   * "Hot water 55 °C · Zone 1 22 °C", leaving out unknown values; "-" when none is known.
   * @param {Array<[string, *]>} parts label and temperature
   */
  formatTemperatures(parts) {
    const text = parts
      .map(([name, value]) => [name, toNumber(value)])
      .filter(([, value]) => value !== null)
      .map(([name, value]) => `${name} ${round(value, 1)} °C`)
      .join(' · ');
    return text || '-';
  }

  /**
   * Updates read-only label settings, only those that changed.
   * @param {object} info setting id -> text
   */
  async setInfoSettings(info) {
    const current = this.getSettings();
    const changed = Object.fromEntries(Object.entries(info).filter(([key, value]) => current[key] !== value));
    if (Object.keys(changed).length) await this.setSettings(changed).catch(this.error);
  }

  /**
   * Fires onTrigger/offTrigger when a boolean capability flips.
   * previous is null right after pairing; don't fire on the first reading.
   * @returns {Promise<boolean|null>} the new value if it flipped, otherwise null
   */
  async triggerOnSwitch(capability, previous, onTrigger, offTrigger, onTokens = {}) {
    const value = this.getCapabilityValue(capability);
    if (previous === null || value === null || value === previous) return null;
    await (value ? onTrigger.trigger(this, onTokens) : offTrigger.trigger(this))
      .catch(this.error);
    return value;
  }

  hasZone2() {
    return this.hasCapability('melpump_zone_active.zone2');
  }

  async updateZone2(active) {
    // Also adds zone 2 capabilities introduced by app updates to devices that already have zone 2.
    const noThermostat = this.features.thermostatZone2 === false ? FEATURE_CAPABILITIES.thermostatZone2 : [];
    for (const [capability, options] of Object.entries(ZONE2_CAPABILITIES)) {
      const wanted = active && !noThermostat.includes(capability);
      // A failure here isn't a failed poll; the next device fetch tries again.
      try {
        if (wanted && !this.hasCapability(capability)) {
          await this.addCapability(capability);
          await this.setCapabilityOptions(capability, options);
        } else if (!wanted && this.hasCapability(capability)) {
          await this.removeCapability(capability);
        }
      } catch (err) {
        this.error(`Could not update ${capability}:`, err.message);
      }
    }
    this.registerListeners();
  }

  /**
   * What the heat pump has, from Device. Removes values and choices it can't use.
   * @param {object} device Device
   */
  async updateFeatures(device) {
    // A field the response doesn't have keeps its last known value (unknown = has it),
    // so a partial response doesn't add or remove capabilities.
    const reported = (field, key) => (typeof device[field] === 'boolean' ? device[field] : this.features[key] !== false);
    const features = {
      canCool: reported('canCool', 'canCool'),
      thermostatZone1: reported('hasThermostatZone1', 'thermostatZone1'),
      thermostatZone2: reported('hasThermostatZone2', 'thermostatZone2'),
    };
    if (Object.keys(features).every((key) => features[key] === this.features[key])) return;
    this.features = features;
    await this.setStoreValue('features', features).catch(this.error);
    await this.syncCapabilities(this.getSettings());
  }

}

module.exports = HeatPumpState;
