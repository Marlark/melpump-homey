'use strict';

const Homey = require('homey');

const {
  TEMPERATURE_DEBOUNCE_MS, FUNCTION_SWITCHES, CAPABILITY_GROUPS, FEATURE_CAPABILITIES, COOLING_CHOICES,
  REMOVED_CAPABILITIES,
} = require('./lib/constants');
const { withinDeadband, dateInZone, dateTimeInZone } = require('./lib/helpers');

// The device's methods are split by topic over these files in lib/; see the end of this file.
const PARTS = [
  require('./lib/polling'),
  require('./lib/state'),
  require('./lib/alarms'),
  require('./lib/statistics'),
  require('./lib/flows'),
  require('./lib/control'),
  require('./lib/widget'),
  require('./lib/diagnostics'),
];

class HeatPumpDevice extends Homey.Device {

  async onInit() {
    this.failedPolls = 0;
    this.pollCount = 0;
    this.pausedUntil = 0;
    this.lastPower = null;
    this.deviceSettings = null;
    this.deviceTimezone = this.getStoreValue('timezone') || 'UTC';
    this.hasGroundSource = false;
    // { canCool, thermostatZone1, thermostatZone2 } as reported by MelPump (see FEATURE_CAPABILITIES).
    this.features = this.getStoreValue('features') || {};
    // Warnings by source; the most important one is shown (see refreshWarning).
    this.subscriptionWarning = null;
    this.dataWarning = null;
    // Device.lastSeenAt: when MelPump last received fresh readings.
    this.lastSeenAt = null;
    // Set while MelPump reports the heat pump (or its cloud integration) offline.
    this.offlineReason = null;
    // Message currently shown as "unavailable", or null when available.
    this.unavailableMessage = null;
    // Warning currently shown on the device tile, or null.
    this.warningMessage = null;
    // After coming back online, run the alarm and energy checks right away.
    this.catchUp = false;
    // Estimated kWh per not-yet-reported day, from integrating measure_power.
    this.energyEstimates = this.getStoreValue('energyEstimates') || {};
    // The same for heat produced today, for the widget's figures for today.
    this.heatEstimates = this.getStoreValue('heatEstimates') || {};
    this.lastPowerSample = null;
    // Per day: total energy and heat, and hours / energy / heat per MODE_STATS mode.
    this.modeStats = this.getStoreValue('modeStats') || {};
    // DeviceSettings.smartEnergyActive as last seen; null until the first reading.
    this.smartEnergySwitchedOn = null;
    // SOLAR_FUNCTIONS key -> on/off as last seen.
    this.solarFunctions = {};
    // Timestamp until which solar mode was forced from Homey, or null.
    this.forcedSolarUntil = this.getStoreValue('forcedSolarUntil') || null;
    // Timestamps until which a hot water boost / holiday mode set from Homey runs, or null.
    this.boostUntil = this.getStoreValue('boostUntil') || null;
    this.holidayUntil = this.getStoreValue('holidayUntil') || null;
    // FUNCTION_TOGGLES key -> failed attempts to switch it off at its end time.
    this.endAttempts = {};
    // Compressor start times of the last hour, for "Compressor started often".
    this.startTimes = [];
    // Start count -> when "short cycling" last fired for it, see trackRuns.
    this.shortCyclingFiredAt = {};
    // Heater -> when it was switched on (live readings), for "Heater on for a long time".
    this.heaterOnSince = {};
    // Zone -> [timestamp, room minus target] of the last hours.
    this.roomHistory = { 1: [], 2: [] };
    // Whether "Hot water is ready" may fire (false after it fired, until hot water is used).
    this.hotWaterArmed = null;
    // "YYYY-MM-DD HH" of the hour whose extra device fetch has been done.
    this.deviceFetchedHour = null;
    // Set after a Flow changes a function, so the next poll fetches the device.
    this.refreshDevice = false;
    // Timestamps of requests to melpump.com in the last hour (see REQUEST_BUDGET).
    this.requestTimes = [];
    this.overBudget = false;
    // Per day: compressor starts and running hours, defrosts and defrost minutes.
    this.runStats = this.getStoreValue('runStats') || {};
    this.lastRunSample = null;
    this.runStartedAt = null;
    // [timestamp, kW] of the last hour, and 5-minute averages of the last 24 hours,
    // for the dashboard widget's chart. In memory only.
    this.powerHistory = [];
    this.powerDay = [];
    // For the widget: when the last live reading was applied, and the alarm summary.
    this.lastStateAt = null;
    this.unacknowledgedAlarms = null;
    // The app's own alarm history, see rememberAlarms.
    this.alarmHistory = this.getStoreValue('alarmHistory') || [];
    this.lastAlarmText = null;
    // For the diagnostics settings.
    this.lastSuccess = null;
    this.lastError = null;

    for (const capability of REMOVED_CAPABILITIES) {
      if (this.hasCapability(capability)) {
        await this.removeCapability(capability).catch(this.error);
      }
    }
    // Devices paired before the "heatpump" class was used keep their old class otherwise.
    if (this.getClass() !== this.driver.manifest.class) {
      await this.setClass(this.driver.manifest.class).catch(this.error);
    }

    this.registeredListeners = new Set();
    await this.syncCapabilities(this.getSettings());
    await this.updateForcedSolar();
    await this.setHolidayUntil(this.holidayUntil);

    if (this.getStoreValue('apiKey')) {
      // Spread out when the app (or Homey) has just started; a newly paired device starts at once.
      this.startPolling({ spread: Date.now() - (this.homey.app.startedAt || 0) < 60000 });
    } else {
      // Paired with the earlier email/password version of the app; fixed via Repair.
      await this.markUnavailable(this.homey.__('device.no_api_key'));
    }

    this.log(`HeatPump device "${this.getName()}" has been initialized`);
  }

  /**
   * Adds the driver's capabilities (also those introduced by app updates) and
   * removes / re-adds the groups switched off / on in the device settings, and
   * those the heat pump doesn't have (FEATURE_CAPABILITIES).
   * @param {object} settings
   * @returns {Promise<boolean>} whether capabilities were added
   */
  async syncCapabilities(settings) {
    const hidden = new Set([
      ...Object.entries(CAPABILITY_GROUPS).filter(([key]) => settings[key] === false),
      ...Object.entries(FEATURE_CAPABILITIES).filter(([key]) => this.features[key] === false),
    ].flatMap(([, capabilities]) => capabilities));

    let added = false;
    for (const capability of this.driver.manifest.capabilities) {
      if (hidden.has(capability) && this.hasCapability(capability)) {
        await this.removeCapability(capability).catch(this.error);
      } else if (!hidden.has(capability) && !this.hasCapability(capability)) {
        await this.addCapability(capability).then(() => { added = true; }).catch(this.error);
      }
    }

    await this.updateModeOptions();
    this.registerListeners();
    return added;
  }

  /**
   * Listeners for the capabilities that can be changed from Homey. The SDK keeps
   * listeners after a capability is removed, so each is registered once, when the
   * device first has the capability.
   */
  registerListeners() {
    const listeners = {
      target_temperature: (value) => this.write(() => this.api.setDeviceSettings(this.deviceId, { temperatureZone1: value })),
      'target_temperature.zone2': (value) => this.write(() => this.api.setDeviceSettings(this.deviceId, { temperatureZone2: value })),
      'target_temperature.tank': (value) => this.write(() => this.api.setDeviceSettings(this.deviceId, { tankWaterTemperature: value })),
      melpump_mode: async (value) => {
        const previous = this.getCapabilityValue('melpump_mode');
        await this.applyMode(value);
        await this.triggerModeChanged(previous, value);
      },
    };
    for (const [capability, fn] of Object.entries(FUNCTION_SWITCHES)) {
      listeners[capability] = (value) => this.setFunction(fn, value);
    }

    for (const [capability, listener] of Object.entries(listeners)) {
      if (!this.hasCapability(capability) || this.registeredListeners.has(capability)) continue;
      const run = async (value) => {
        this.debug(`Set from Homey: ${capability} = ${JSON.stringify(value)}`);
        await listener(value);
      };
      if (capability.startsWith('target_temperature')) {
        // Dragging a slider sends a quick series of values; the SDK waits until it
        // stops and passes only the last one, so that is one request instead of many.
        this.registerMultipleCapabilityListener([capability], async (values) => {
          await run(values[capability]);
        }, TEMPERATURE_DEBOUNCE_MS);
      } else {
        this.registerCapabilityListener(capability, run);
      }
      this.registeredListeners.add(capability);
    }
  }

  /**
   * Without cooling, the mode picker only offers Heating and Off: "Auto" switches
   * between heating and cooling, so it adds nothing, and with two choices the
   * on/off state reported by MelPump tells which one is active.
   */
  async updateModeOptions() {
    if (!this.hasCapability('melpump_mode')) return;
    const all = this.homey.manifest.capabilities.melpump_mode.values;
    const values = this.features.canCool === false ? all.filter((v) => ['heating', 'off'].includes(v.id)) : all;
    let current;
    try {
      current = (this.getCapabilityOptions('melpump_mode') || {}).values;
    } catch (err) {
      current = undefined;
    }
    if (current ? current.length === values.length : values === all) return;
    await this.setCapabilityOptions('melpump_mode', { values }).catch(this.error);
  }

  /**
   * Refuses a Flow choice that needs cooling on a heat pump that can't cool.
   * @param {string} kind key of COOLING_CHOICES
   * @param {string} choice
   */
  assertCanCool(kind, choice) {
    if (this.features.canCool === false && COOLING_CHOICES[kind].includes(choice)) {
      throw new Error(this.homey.__('device.cannot_cool'));
    }
  }

  async onSettings({ newSettings, changedKeys }) {
    this.debug('Settings changed:', changedKeys.map((key) => `${key}=${JSON.stringify(newSettings[key])}`).join(', '));
    if (!changedKeys.some((key) => key in CAPABILITY_GROUPS)) return;
    const added = await this.syncCapabilities(newSettings);
    if (added) {
      // Values that come from the app, not from MelPump.
      await this.showHolidayUntil();
      await this.updateForcedSolar();
      // Fill re-added values right away instead of waiting for their next interval.
      this.refreshDevice = true;
      this.catchUp = true;
      this.forceYesterdayStats = true;
      this.forcePeriodStats = true;
    }
  }

  /**
   * The shared client for this device's token. Every API method called through it
   * is counted for this heat pump, since melpump.com limits requests per device.
   */
  get api() {
    // Kept until the token changes (repair) instead of building a new proxy per call.
    const client = this.homey.app.getClient(this.getStoreValue('apiKey'));
    if (this.apiProxy && this.apiProxyClient === client) return this.apiProxy;
    this.apiProxyClient = client;
    const counted = {};
    this.apiProxy = new Proxy(client, {
      get: (target, prop) => {
        const value = target[prop];
        if (typeof value !== 'function' || String(prop).startsWith('_')) return value;
        if (!counted[prop]) {
          counted[prop] = (...args) => {
            this.requestTimes.push(Date.now());
            return value.apply(target, args);
          };
        }
        return counted[prop];
      },
    });
    return this.apiProxy;
  }

  get deviceId() {
    return this.getData().id;
  }

  /**
   * Called from the repair flow once the new token has been verified.
   * @param {string} apiKey
   * @param {boolean} writeAccess
   */
  async updateApiKey(apiKey, writeAccess) {
    const oldKey = this.getStoreValue('apiKey');

    await this.setStoreValue('apiKey', apiKey);
    await this.setStoreValue('writeAccess', writeAccess);
    if (oldKey && oldKey !== apiKey) this.homey.app.removeClient(oldKey);

    // poll() only marks the device available when the request succeeds.
    this.startPolling();
    this.log('API token updated via repair');
  }

  /**
   * "HH:mm" for today, otherwise "YYYY-MM-DD HH:mm", in the heat pump's time zone.
   * @param {number} time
   */
  formatMoment(time) {
    const text = dateTimeInZone(new Date(time), this.deviceTimezone);
    return text.startsWith(dateInZone(new Date(), this.deviceTimezone)) ? text.slice(11) : text;
  }

  /**
   * @param {string} key locale key taking __name__
   */
  async notify(key) {
    await this.homey.notifications
      .createNotification({ excerpt: this.homey.__(key, { name: this.getName() }) })
      .catch(this.error);
  }

  /**
   * Title of an enum capability value in Homey's language, for Flow tokens.
   * @param {string} capability
   * @param {string} id
   */
  enumTitle(capability, id) {
    const definition = this.homey.manifest.capabilities[capability];
    const value = definition && definition.values.find((v) => v.id === id);
    if (!value) return id;
    return value.title[this.homey.i18n.getLanguage()] || value.title.en;
  }

  async updateCapabilities(values) {
    // The list of changes is only built for the debug log.
    const changes = this.homey.app.debugMode ? [] : null;
    for (const [capability, value] of Object.entries(values)) {
      if (value === null || !this.hasCapability(capability)) continue;
      const previous = this.getCapabilityValue(capability);
      if (previous === value || withinDeadband(capability, previous, value)) continue;
      await this.setCapabilityValue(capability, value).catch(this.error);
      if (changes) changes.push(`${capability} ${JSON.stringify(previous)} -> ${JSON.stringify(value)}`);
    }
    if (changes && changes.length) this.debug(`Changed: ${changes.join(', ')}`);
  }

  /**
   * Logs only in debug mode (`homey app run`), see MelPumpApp.debugMode.
   */
  debug(...args) {
    if (this.homey.app.debugMode) this.log('[debug]', ...args);
  }

  async onUninit() {
    this.stopPolling();
    await this.persistStats();
  }

  log(...args) {
    this.recordToApp('log', args);
    super.log(...args);
  }

  error(...args) {
    this.recordToApp('error', args);
    super.error(...args);
  }

  /**
   * Adds a log line to the app's log buffer (see MelPumpApp.recordLog).
   * @param {'log'|'error'} level
   * @param {Array} args
   */
  recordToApp(level, args) {
    const app = this.homey && this.homey.app;
    if (app && typeof app.recordLog === 'function') app.recordLog(level, this.getName(), args);
  }

  async onDeleted() {
    // The store is deleted with the device; only the shared API client is left to clean up.
    this.stopPolling();
    this.homey.app.removeClient(this.getStoreValue('apiKey'), this);
    this.log(`HeatPump device "${this.getName()}" has been deleted`);
  }

}

// Adds the methods of PARTS to HeatPumpDevice, as if they were written here.
for (const part of PARTS) {
  for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(part.prototype))) {
    if (name === 'constructor') continue;
    if (Object.prototype.hasOwnProperty.call(HeatPumpDevice.prototype, name)) {
      throw new Error(`HeatPumpDevice.${name} is defined twice`);
    }
    Object.defineProperty(HeatPumpDevice.prototype, name, descriptor);
  }
}

module.exports = HeatPumpDevice;
