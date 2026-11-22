'use strict';

const {
  FLOW_ARGS_TTL_MS, MAX_INTEGRATION_GAP_MS, HOT_WATER_READY_MARGIN, HOT_WATER_REARM,
  ROOM_DEVIATION_MAX_MINUTES, ROOM_HISTORY_MS, FUNCTION_SETTINGS, ZONE_MODE_CAPABILITIES,
} = require('./constants');
const { round } = require('./helpers');

/**
 * Flow triggers that need history or the Flows' own arguments, and Flow conditions.
 * Part of HeatPumpDevice (drivers/heatpump/device.js), which adds these methods to itself.
 */
class HeatPumpFlows {

  /**
   * Run listener of "Heater on for a long time": true at the reading where the Flow's
   * heater has been on for its number of minutes.
   * @param {{ heater: string, minutes: number }} args
   * @param {{ heater: string, minutes: number, previous: number }} state
   */
  heaterLimitReached(args, state) {
    return (args.heater === 'any' || args.heater === state.heater)
      && state.previous < args.minutes && state.minutes >= args.minutes;
  }

  /**
   * The argument values of this device's Flows using a trigger, kept for
   * FLOW_ARGS_TTL_MS (and cleared by the driver when Flows change). null when unknown.
   * @param {string} name trigger property on the driver
   * @returns {Promise<Array<object>|null>}
   */
  async flowArgs(name) {
    this.argsCache = this.argsCache || {};
    const cached = this.argsCache[name];
    if (cached && Date.now() - cached.at < FLOW_ARGS_TTL_MS) return cached.values;
    const card = this.driver[name];
    let values = null;
    if (typeof card.getArgumentValues === 'function') {
      values = await card.getArgumentValues(this).catch((err) => {
        this.error(`Could not read the Flows of ${name}:`, err.message);
        return null;
      });
    }
    this.argsCache[name] = { at: Date.now(), values: Array.isArray(values) ? values : null };
    return this.argsCache[name].values;
  }

  /**
   * Whether a trigger that is checked every reading needs to fire now: only when one
   * of the Flows using it matches, so Homey isn't asked to run them all every minute.
   * When the Flows can't be read, it fires and the run listeners decide, as before.
   * @param {string} name trigger property on the driver
   * @param {Function} matches (args) => boolean
   */
  async anyFlowMatches(name, matches) {
    const flows = await this.flowArgs(name);
    return flows === null || flows.some(matches);
  }

  /**
   * "Room temperature deviates from target": keeps room minus target per zone for the
   * last hours, and fires every reading; each Flow's run listener checks its own limit
   * and time (see deviationHolds), so it fires once when the deviation has lasted long enough.
   */
  async trackRoomTemperatures() {
    const now = Date.now();
    const zones = {
      1: ['measure_temperature', 'target_temperature'],
      2: ['measure_temperature.zone2', 'target_temperature.zone2'],
    };
    for (const [zone, [roomCapability, targetCapability]] of Object.entries(zones)) {
      const room = this.hasCapability(roomCapability) ? this.getCapabilityValue(roomCapability) : null;
      const target = this.hasCapability(targetCapability) ? this.getCapabilityValue(targetCapability) : null;
      // A gap in the readings starts over: the deviation must be seen for the whole time.
      const readings = this.roomHistory[zone].filter(([time]) => time > now - ROOM_HISTORY_MS);
      const last = readings[readings.length - 1];
      this.roomHistory[zone] = room === null || target === null || (last && now - last[0] > MAX_INTEGRATION_GAP_MS)
        ? []
        : readings;
      if (room === null || target === null) continue;
      this.roomHistory[zone].push([now, round(room - target, 2)]);

      const state = { zone, history: this.roomHistory[zone] };
      if (!await this.anyFlowMatches('roomTemperatureDeviatesTrigger', (args) => this.roomDeviationReached(args, state))) continue;
      await this.driver.roomTemperatureDeviatesTrigger
        .trigger(this, { temperature: room, target, deviation: round(room - target, 1) }, state)
        .catch(this.error);
    }
  }

  /**
   * "Hot water is ready" when the tank reaches its target (within HOT_WATER_READY_MARGIN),
   * then again only after hot water has been used (HOT_WATER_REARM below the target).
   */
  async checkHotWaterReady() {
    const tank = this.getCapabilityValue('melpump_tank_temperature');
    const target = this.getCapabilityValue('target_temperature.tank');
    if (tank === null || target === null) return;
    const ready = tank >= target - HOT_WATER_READY_MARGIN;

    // First reading: no trigger for hot water that was already ready.
    if (this.hotWaterArmed === null) {
      this.hotWaterArmed = !ready;
      return;
    }
    if (!ready && tank < target - HOT_WATER_REARM) this.hotWaterArmed = true;
    if (ready && this.hotWaterArmed) {
      this.hotWaterArmed = false;
      await this.driver.hotWaterReadyTrigger
        .trigger(this, { temperature: tank, target })
        .catch(this.error);
    }
  }

  /**
   * Run listener of "Room temperature deviates from target": true once, at the reading
   * where the deviation has been beyond the Flow's limit for its number of minutes.
   * @param {{ zone: string, direction: string, degrees: number, minutes: number }} args
   * @param {{ zone: string, history: Array<[number, number]> }} state
   */
  roomDeviationReached({
    zone, direction, degrees, minutes,
  }, state) {
    const { history } = state;
    if (String(zone) !== String(state.zone) || !history.length) return false;
    const span = Math.min(minutes, ROOM_DEVIATION_MAX_MINUTES) * 60000;
    const beyond = (deviation) => {
      if (direction === 'below') return deviation <= -degrees;
      if (direction === 'above') return deviation >= degrees;
      return Math.abs(deviation) >= degrees;
    };
    // Whether every reading in the window ending at history[end] is beyond the limit,
    // and the readings go back that far.
    const holdsAt = (end) => {
      const from = history[end][0] - span;
      if (history[0][0] > from) return false;
      for (let i = end; i >= 0 && history[i][0] >= from; i -= 1) {
        if (!beyond(history[i][1])) return false;
      }
      return true;
    };
    const last = history.length - 1;
    return holdsAt(last) && !(last > 0 && holdsAt(last - 1));
  }

  /**
   * Used by the "Hot water is ready" Flow condition.
   * @returns {boolean}
   */
  isHotWaterReady() {
    const tank = this.getCapabilityValue('melpump_tank_temperature');
    const target = this.getCapabilityValue('target_temperature.tank');
    return tank !== null && target !== null && tank >= target - HOT_WATER_READY_MARGIN;
  }

  /**
   * Used by the "Function is on" Flow condition.
   * @param {string} fn key of FUNCTION_SETTINGS
   * @returns {Promise<boolean>}
   */
  async isFunctionActive(fn) {
    const field = FUNCTION_SETTINGS[fn];
    if (!field) throw new Error(this.homey.__('device.invalid_function', { fn }));
    if (!this.deviceSettings) {
      const device = await this.api.getDevice(this.deviceId);
      if (device) await this.applyDevice(device);
    }
    return Boolean(this.deviceSettings && this.deviceSettings[field] === true);
  }

  /**
   * Used by the "Zone is heating/cooling" Flow condition.
   * @param {string} zone "1" or "2"
   * @returns {boolean}
   */
  isZoneActive(zone) {
    const capability = this.assertZone(zone) === '1' ? 'melpump_zone_active' : 'melpump_zone_active.zone2';
    return this.hasCapability(capability) && this.getCapabilityValue(capability) === true;
  }

  /**
   * Used by the "Zone mode is" Flow condition.
   * @param {string} zone "1" or "2"
   * @param {string} mode key of ZONE_MODES
   * @returns {boolean}
   */
  isZoneMode(zone, mode) {
    const capability = ZONE_MODE_CAPABILITIES[Number(this.assertZone(zone)) - 1];
    return this.hasCapability(capability) && this.getCapabilityValue(capability) === mode;
  }

}

module.exports = HeatPumpFlows;
