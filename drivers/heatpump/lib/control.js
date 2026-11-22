'use strict';

const {
  FORCED_SOLAR_LATE_MS, BOOST_MINUTES, MAX_END_ATTEMPTS, MODE_TO_OPERATION_MODE, VALID_MODES,
  FUNCTION_TOGGLES, FUNCTION_SETTINGS, FUNCTION_SWITCHES, HOT_WATER_PRESETS, BLOCK_TOGGLES, ZONE_MODES,
  FLOW_TEMPERATURES, ZONES, PRESET_FIELDS,
} = require('./constants');
const { toNumber, clockTime, dateInZone, zonedTime, dateTimeInZone, shiftDate } = require('./helpers');

/**
 * Changing the heat pump: mode, functions, zones, presets, solar mode, and the timed
 * functions the app switches off itself (hot water boost, holiday mode).
 * Part of HeatPumpDevice (drivers/heatpump/device.js), which adds these methods to itself.
 */
class HeatPumpControl {

  async write(action) {
    if (this.getStoreValue('writeAccess') === false) {
      throw new Error(this.homey.__('device.no_write_access'));
    }
    let result;
    try {
      result = await action();
    } catch (err) {
      this.error('Failed to update heat pump:', err.message);
      // Throwing makes Homey revert the UI and show the message to the user.
      throw new Error(this.homey.__('device.update_failed', { message: err.message }), { cause: err });
    }
    this.pollSoon();
    return result;
  }

  async applyMode(mode) {
    if (!VALID_MODES.includes(mode)) {
      throw new Error(this.homey.__('device.invalid_mode', { mode }));
    }

    if (mode === 'off') {
      await this.write(() => this.api.setDeviceState(this.deviceId, { power: false }));
      this.lastPower = false;
      return;
    }

    if (this.lastPower === false) {
      await this.write(() => this.api.setDeviceState(this.deviceId, { power: true }));
      this.lastPower = true;
    }
    await this.write(() => this.api.setDeviceSettings(this.deviceId, {
      operationMode: MODE_TO_OPERATION_MODE[mode],
    }));
  }

  assertZone(zone) {
    if (!ZONES.includes(String(zone))) {
      throw new Error(this.homey.__('device.invalid_zone', { zone }));
    }
    return String(zone);
  }

  /**
   * @param {string} mode one of VALID_MODES
   */
  async setMode(requested) {
    this.assertCanCool('mode', requested);
    // Without cooling, "Auto" is the same as heating (and isn't in the mode picker).
    const mode = requested === 'auto' && this.features.canCool === false ? 'heating' : requested;
    const previous = this.getCapabilityValue('melpump_mode');
    await this.applyMode(mode);
    await this.setCapabilityValue('melpump_mode', mode).catch(this.error);
    await this.triggerModeChanged(previous, mode);
  }

  /**
   * @param {string|null} previous
   * @param {string|null} mode
   */
  async triggerModeChanged(previous, mode) {
    if (!previous || !mode || previous === mode) return;
    await this.driver.modeChangedTrigger
      .trigger(this, {
        mode: this.enumTitle('melpump_mode', mode),
        previous: this.enumTitle('melpump_mode', previous),
      })
      .catch(this.error);
  }

  /**
   * Used by the "Turn saving mode on/off" Flow action (Smart Energy in MelPump).
   * @param {boolean} on
   */
  async setSavingMode(on) {
    await this.setFunction('smart_energy', on);
  }

  /**
   * @param {string} fn key of FUNCTION_TOGGLES
   * @param {boolean} on
   */
  async setFunction(fn, on) {
    const field = FUNCTION_TOGGLES[fn];
    if (!field) throw new Error(this.homey.__('device.invalid_function', { fn }));
    await this.write(() => this.api.setDeviceState(this.deviceId, { [field]: on }));

    // Switched off by hand (or by a Flow): a timed end set from Homey no longer applies.
    if (!on && fn === 'force_hot_water') await this.setBoostUntil(null);
    if (!on && fn === 'holiday') await this.setHolidayUntil(null);

    // Reflect the change right away; the next poll fetches the device to confirm it
    // (and to update e.g. saving / night mode if MelPump starts or stops it at once).
    if (this.deviceSettings && FUNCTION_SETTINGS[fn]) {
      this.deviceSettings[FUNCTION_SETTINGS[fn]] = on;
    }
    const toggle = Object.keys(FUNCTION_SWITCHES).find((capability) => FUNCTION_SWITCHES[capability] === fn);
    if (toggle && this.hasCapability(toggle)) {
      await this.setCapabilityValue(toggle, on).catch(this.error);
    }
    this.refreshDevice = true;
  }

  /**
   * Used by the "Boost hot water" Flow action: forced hot water, switched off again by
   * the app after the given minutes, or earlier once the hot water is ready.
   * @param {number} minutes
   */
  async boostHotWater(minutes) {
    const value = Math.round(minutes);
    if (!(value >= BOOST_MINUTES.min && value <= BOOST_MINUTES.max)) {
      throw new Error(this.homey.__('device.invalid_boost_minutes', BOOST_MINUTES));
    }
    await this.setFunction('force_hot_water', true);
    await this.setBoostUntil(Date.now() + value * 60000);
  }

  /**
   * Used by the "Turn on holiday mode until" Flow action; the app switches it off again.
   * @param {string} date "dd-mm-yyyy" (Homey date argument)
   * @param {string} time "HH:mm" in the heat pump's time zone
   */
  async turnOnHolidayUntil(date, time) {
    const day = /^(\d{2})-(\d{2})-(\d{4})$/.exec(String(date || '').trim());
    const clock = clockTime(time);
    const until = day && clock ? zonedTime(`${day[3]}-${day[2]}-${day[1]}`, clock, this.deviceTimezone) : NaN;
    if (!(until > Date.now())) {
      throw new Error(this.homey.__('device.invalid_end_time', { time: `${date} ${time}` }));
    }
    await this.setFunction('holiday', true);
    await this.setHolidayUntil(until);
  }

  /**
   * @param {number|null} until
   */
  async setBoostUntil(until) {
    this.boostUntil = until;
    await this.setStoreValue('boostUntil', until).catch(this.error);
  }

  /**
   * @param {number|null} until
   */
  async setHolidayUntil(until) {
    this.holidayUntil = until;
    await this.setStoreValue('holidayUntil', until).catch(this.error);
    await this.showHolidayUntil();
  }

  async showHolidayUntil() {
    await this.updateCapabilities({
      melpump_holiday_until: this.holidayUntil ? this.formatMoment(this.holidayUntil) : this.homey.__('device.holiday_no_end'),
    });
  }

  /**
   * Runs every poll: switches off a hot water boost whose time is up or whose hot water
   * is ready, and holiday mode at its end time. If MelPump doesn't accept it, the next
   * poll tries again (see endTimedFunction).
   */
  async endTimedFunctions() {
    const now = Date.now();
    if (this.boostUntil && (now >= this.boostUntil || this.isHotWaterReady())) {
      this.log(now >= this.boostUntil ? 'Hot water boost time is up' : 'Hot water boost: hot water is ready');
      await this.endTimedFunction('force_hot_water', 'device.boost_end_failed', () => this.setBoostUntil(null));
    }
    if (this.holidayUntil && now >= this.holidayUntil) {
      this.log('Holiday mode end time reached');
      await this.endTimedFunction('holiday', 'device.holiday_end_failed', () => this.setHolidayUntil(null));
    }
  }

  /**
   * Switches off a function at its end time. Gives up after MAX_END_ATTEMPTS, or at
   * once without write access, and tells the user the function is still on.
   * @param {string} fn key of FUNCTION_TOGGLES
   * @param {string} failedKey locale key taking __name__
   * @param {Function} forget clears the end time
   */
  async endTimedFunction(fn, failedKey, forget) {
    try {
      await this.setFunction(fn, false);
      delete this.endAttempts[fn];
    } catch (err) {
      this.endAttempts[fn] = (this.endAttempts[fn] || 0) + 1;
      this.error(`Could not switch off ${fn} (attempt ${this.endAttempts[fn]}):`, err.message);
      if (this.endAttempts[fn] < MAX_END_ATTEMPTS && this.getStoreValue('writeAccess') !== false) return;
      delete this.endAttempts[fn];
      await forget();
      await this.notify(failedKey);
    }
  }

  /**
   * @param {string} target key of BLOCK_TOGGLES
   * @param {boolean} blocked
   */
  async setBlocked(target, blocked) {
    const field = BLOCK_TOGGLES[target];
    if (!field) throw new Error(this.homey.__('device.invalid_function', { fn: target }));
    this.assertCanCool('block', target);
    await this.write(() => this.api.setDeviceState(this.deviceId, { [field]: blocked }));
  }

  /**
   * Shifts the online heat curve up or down (only used in Online Curve mode).
   * @param {string} zone "1" or "2"
   * @param {number} correction -10..10
   */
  async setCurveCorrection(zone, correction) {
    const z = this.assertZone(zone);
    const value = Math.round(correction);
    if (!(value >= -10 && value <= 10)) {
      throw new Error(this.homey.__('device.invalid_curve_correction'));
    }
    await this.write(() => this.api.setDeviceSettings(this.deviceId, { [`onlineCurveCorrectionZone${z}`]: value }));
  }

  /**
   * Target flow temperature (only used in constant flow / cooling flow mode).
   * @param {string} zone "1" or "2"
   * @param {string} kind "heating" or "cooling"
   * @param {number} temperature
   */
  async setFlowTemperature(zone, kind, temperature) {
    const z = this.assertZone(zone);
    const limits = FLOW_TEMPERATURES[kind];
    if (!limits) throw new Error(this.homey.__('device.invalid_function', { fn: kind }));
    this.assertCanCool('flow', kind);
    if (!(temperature >= limits.min && temperature <= limits.max)) {
      throw new Error(this.homey.__('device.invalid_flow_temperature', { min: limits.min, max: limits.max }));
    }
    await this.write(() => this.api.setDeviceSettings(this.deviceId, { [`${limits.field}${z}`]: temperature }));
  }

  /**
   * @param {string} zone "1" or "2"
   * @param {string} mode key of ZONE_MODES
   */
  async setZoneMode(zone, mode) {
    const z = this.assertZone(zone);
    if (!(mode in ZONE_MODES)) throw new Error(this.homey.__('device.invalid_mode', { mode }));
    this.assertCanCool('zoneMode', mode);
    await this.write(() => this.api.setDeviceSettings(this.deviceId, { [`operationModeZone${z}`]: ZONE_MODES[mode] }));
  }

  /**
   * @param {number} minutes 1-1440
   */
  async forceSolarMode(minutes) {
    const value = Math.round(minutes);
    if (!(value >= 1 && value <= 1440)) {
      throw new Error(this.homey.__('device.invalid_solar_minutes'));
    }
    await this.write(() => this.api.forceSolarMode(this.deviceId, value));
    // Solar mode itself is confirmed by the device fetch on the next poll, so the
    // "Solar mode started" trigger fires for forced solar mode too.
    this.refreshDevice = true;
    await this.setForcedSolarUntil(Date.now() + value * 60 * 1000);
  }

  /**
   * Used by the "Force solar mode until a time" Flow action.
   * @param {string} time "HH:mm" in the heat pump's time zone
   */
  async forceSolarUntil(time) {
    const match = /^(\d{1,2}):(\d{2})$/.exec(String(time || '').trim());
    const target = match ? Number(match[1]) * 60 + Number(match[2]) : NaN;
    if (!(target >= 0 && target < 1440)) {
      throw new Error(this.homey.__('device.invalid_time', { time }));
    }
    // Counted between real moments, so a daylight saving change in between is included.
    const clock = `${match[1].padStart(2, '0')}:${match[2]}`;
    const today = dateInZone(new Date(), this.deviceTimezone);
    let until = zonedTime(today, clock, this.deviceTimezone);
    // A time that has passed today (or is now) means tomorrow.
    if (until <= Date.now()) until = zonedTime(shiftDate(today, 1), clock, this.deviceTimezone);
    await this.forceSolarMode(Math.max(1, Math.round((until - Date.now()) / 60000)));
  }

  async clearSolarMode() {
    await this.write(() => this.api.clearSolarMode(this.deviceId));
    this.refreshDevice = true;
    await this.setForcedSolarUntil(null);
  }

  /**
   * @param {number|null} until timestamp, or null when solar mode isn't forced
   */
  async setForcedSolarUntil(until) {
    this.forcedSolarUntil = until;
    await this.setStoreValue('forcedSolarUntil', until).catch(this.error);
    await this.updateForcedSolar();
  }

  /**
   * Shows until when solar mode is forced and fires "Forced solar mode has ended"
   * once that time has passed. Runs every poll; needs no API request.
   */
  async updateForcedSolar() {
    const until = this.forcedSolarUntil;
    if (until && Date.now() >= until) {
      this.forcedSolarUntil = null;
      await this.setStoreValue('forcedSolarUntil', null).catch(this.error);
      this.refreshDevice = true;
      if (Date.now() - until <= FORCED_SOLAR_LATE_MS) {
        await this.driver.forcedSolarEndedTrigger.trigger(this).catch(this.error);
      }
    }

    let text = this.homey.__('device.solar_not_forced');
    if (this.forcedSolarUntil) {
      const end = dateTimeInZone(new Date(this.forcedSolarUntil), this.deviceTimezone);
      const today = dateInZone(new Date(), this.deviceTimezone);
      text = end.startsWith(today) ? end.slice(11) : end;
    }
    await this.updateCapabilities({ melpump_solar_forced_until: text });
  }

  /**
   * @param {number} temperature 30-80
   */
  async setHotWaterTemperature(temperature) {
    await this.write(() => this.api.setDeviceSettings(this.deviceId, { tankWaterTemperature: temperature }));
    await this.setCapabilityValue('target_temperature.tank', temperature).catch(this.error);
  }

  /**
   * Sets zone 1 to one of the preset temperatures configured in MelPump.
   * @param {string} preset key of PRESET_FIELDS
   */
  async applyPreset(preset) {
    const temperature = await this.presetTemperature(PRESET_FIELDS[preset]);
    await this.write(() => this.api.setDeviceSettings(this.deviceId, { temperatureZone1: temperature }));
    await this.updateCapabilities({ target_temperature: temperature });
  }

  /**
   * Sets the hot water to one of the tank presets configured in MelPump.
   * @param {string} preset key of HOT_WATER_PRESETS
   */
  async applyHotWaterPreset(preset) {
    const temperature = await this.presetTemperature(HOT_WATER_PRESETS[preset]);
    await this.setHotWaterTemperature(temperature);
  }

  /**
   * @param {string} field DeviceSettings field of a quick preset
   * @returns {Promise<number>}
   */
  async presetTemperature(field) {
    if (!this.deviceSettings) {
      const device = await this.write(() => this.api.getDevice(this.deviceId));
      if (device) await this.applyDevice(device);
    }
    const temperature = field && this.deviceSettings ? toNumber(this.deviceSettings[field]) : null;
    if (temperature === null) {
      throw new Error(this.homey.__('device.preset_not_set'));
    }
    return temperature;
  }

}

module.exports = HeatPumpControl;
