'use strict';

const Homey = require('homey');
const MelPumpApi = require('./lib/melpump_api');

// The widget asks for data when it opens and every few minutes after; without a
// request for this long, no widget is open and realtime updates aren't sent.
const WIDGET_ACTIVE_MS = 10 * 60 * 1000;

// Log lines kept in memory for the settings page and the diagnostics text. Users can
// rarely read the app's log themselves, so these go along with a bug report.
const LOG_BUFFER_SIZE = 200;
const LOG_LINE_MAX = 500;
// Anything that looks like a MelPump API token is masked, should one ever be logged.
const TOKEN_PATTERN = /api_[A-Za-z0-9_-]+/g;

/**
 * One log argument as text: an error as its message, an object as JSON.
 * @param {*} arg
 * @returns {string}
 */
function logText(arg) {
  if (arg instanceof Error) return arg.message;
  if (arg !== null && typeof arg === 'object') {
    try {
      return JSON.stringify(arg);
    } catch (err) {
      return String(arg);
    }
  }
  return String(arg);
}

/**
 * The overview as plain English text for a bug report (in English, so anyone can read it).
 * @param {object} overview see MelPumpApp.getOverview
 * @returns {string}
 */
function diagnosticsText(overview) {
  const { app } = overview;
  const value = (v) => (v === null || v === undefined || v === '' ? '-' : String(v));
  const yesNo = (v) => (v ? 'yes' : 'no');
  const lines = [
    `MelPump for Homey ${app.version}, Homey ${value(app.homeyVersion)}, debug logging ${app.debug ? 'on' : 'off'}`,
    `Generated ${overview.generatedAt}, app running since ${value(app.runningSince)}`,
    `Heat pumps: ${overview.heatPumps.length}, tokens: ${overview.tokens}`,
  ];
  overview.heatPumps.forEach((hp, index) => {
    lines.push(
      '',
      `Heat pump ${index + 1}: ${hp.name}${hp.model ? ` (${hp.model})` : ''}`,
      `  Status: ${hp.available ? 'available' : `unavailable: ${value(hp.unavailableMessage)}`}`,
      `  Warning: ${value(hp.warning)}`,
      `  Token: ${hp.tokenNumber ? `#${hp.tokenNumber}` : '-'}, ${hp.token}`,
      `  Time zone: ${hp.timezone}`,
      `  Last seen by MelPump: ${value(hp.lastSeen)}`,
      `  Last update: ${value(hp.lastUpdate)}`,
      `  Requests in the last hour: ${hp.requestsLastHour} of ${hp.requestBudget}`,
      `  Failed polls in a row: ${hp.failedPolls}`,
      `  Paused until: ${value(hp.pausedUntil)}`,
      `  Last error: ${hp.lastError ? `${hp.lastError.time}: ${hp.lastError.message}` : '-'}`,
      `  Zone 2: ${yesNo(hp.zone2)}, cooling: ${yesNo(hp.canCool)}`,
      `  Hot water boost until: ${value(hp.boostUntil)}, holiday until: ${value(hp.holidayUntil)}, solar mode forced until: ${value(hp.forcedSolarUntil)}`,
      `  Alarms: ${hp.alarms.last7Days} in the last 7 days, ${hp.alarms.count} in the last ${hp.alarms.days} days`,
      ...hp.alarms.recent.map((alarm) => `    ${alarm.time} ${alarm.label}${alarm.message ? `: ${alarm.message}` : ''}${alarm.acknowledged ? ' (acknowledged)' : ''}`),
    );
  });
  lines.push('', `Log, last ${overview.log.length} lines (UTC):`);
  for (const line of overview.log) {
    lines.push(`${line.time.slice(0, 19).replace('T', ' ')} ${line.level === 'error' ? 'ERROR ' : ''}[${line.source}] ${line.message}`);
  }
  return lines.join('\n');
}

class MelPumpApp extends Homey.App {

  async onInit() {
    // Devices initialized shortly after this spread out their first poll.
    this.startedAt = Date.now();

    // `homey app run` starts the app with DEBUG=1: then log details that are too
    // chatty for normal use (every request, poll, changed value, trigger and action).
    this.debugMode = process.env.DEBUG === '1';
    if (this.debugMode) this.log('Debug logging is on (homey app run)');

    // One API client per melpump.com API token, shared by every device paired with it.
    this.clients = new Map();

    // Dashboard widget: pick which heat pump it shows.
    this.homey.dashboards.getWidget('status')
      .registerSettingAutocompleteListener('device', async (query) => this.heatPumps()
        .map((device) => ({ id: device.getData().id, name: device.getName() }))
        .filter((item) => item.name.toLowerCase().includes(String(query || '').toLowerCase())));

    this.log('MelPump app has been initialized');
  }

  /**
   * Keeps a log line of the app, the driver or a heat pump in the log buffer.
   * @param {'log'|'error'} level
   * @param {string} source "app", "driver" or the heat pump's name
   * @param {Array} args what was logged
   */
  recordLog(level, source, args) {
    if (!this.logBuffer) this.logBuffer = [];
    const message = args.map(logText).join(' ').replace(TOKEN_PATTERN, 'api_***').slice(0, LOG_LINE_MAX);
    this.logBuffer.push({ time: Date.now(), level, source, message });
    if (this.logBuffer.length > LOG_BUFFER_SIZE) this.logBuffer.splice(0, this.logBuffer.length - LOG_BUFFER_SIZE);
  }

  log(...args) {
    this.recordLog('log', 'app', args);
    super.log(...args);
  }

  error(...args) {
    this.recordLog('error', 'app', args);
    super.error(...args);
  }

  heatPumps() {
    return this.homey.drivers.getDriver('heatpump').getDevices();
  }

  /**
   * @param {string} [deviceId] MelPump device id from the widget setting; the first heat pump if empty
   */
  /**
   * The heat pump chosen in a widget's settings; the first one when none is chosen.
   * A chosen heat pump that has been removed gives null, not another heat pump.
   * @param {string} [deviceId]
   */
  findHeatPump(deviceId) {
    const devices = this.heatPumps();
    if (!deviceId) return devices[0] || null;
    return devices.find((d) => d.getData().id === deviceId) || null;
  }

  /**
   * Data for the dashboard widget, when it opens and as a fallback refresh.
   * @param {string} [deviceId]
   */
  getWidgetStatus(deviceId) {
    // Widgets are open: push updates to them after each poll (see emitWidgetStatus).
    this.widgetSeenAt = Date.now();
    const device = this.findHeatPump(deviceId);
    if (device) return device.getWidgetStatus();
    // The chosen heat pump is gone: the widget asks to choose another one.
    return deviceId && this.heatPumps().length ? { deviceRemoved: true } : null;
  }

  /**
   * Sends a heat pump's new values to open widgets (realtime event "status"), so
   * they update right after each poll. Skipped when no widget has asked for data
   * for a while, i.e. none is open.
   * @param {Homey.Device} device
   */
  emitWidgetStatus(device) {
    if (!(this.widgetSeenAt > Date.now() - WIDGET_ACTIVE_MS)) return;
    Promise.resolve()
      .then(() => {
        const status = device.getWidgetStatus();
        // The 24-hour graph (288 points) changes per 5-minute bucket: sent only when a
        // new bucket starts. Without it, the widget keeps the graph it has.
        const day = status.powerDay;
        const key = day.length ? day[day.length - 1][0] : null;
        this.widgetDayKeys = this.widgetDayKeys || new Map();
        if (this.widgetDayKeys.get(status.deviceId) === key) delete status.powerDay;
        else this.widgetDayKeys.set(status.deviceId, key);
        return this.homey.api.realtime('status', status);
      })
      .catch(this.error);
  }

  /**
   * A quick button in the widget; returns the new status to show.
   * @param {string} deviceId
   * @param {string} action key of WIDGET_ACTIONS in the device
   */
  async runWidgetAction(deviceId, action) {
    const device = this.findHeatPump(deviceId);
    if (!device) {
      throw new Error(this.homey.__(deviceId && this.heatPumps().length ? 'widget.device_removed' : 'widget.no_device'));
    }
    await device.runWidgetAction(action);
    return device.getWidgetStatus();
  }

  /**
   * For the app settings page: every heat pump's state and a diagnostics text to copy.
   * Heat pumps sharing a token get the same token number; the token itself is never sent.
   */
  getOverview() {
    const tokens = new Map();
    const heatPumps = this.heatPumps().map((device) => {
      const key = device.getStoreValue('apiKey');
      if (key && !tokens.has(key)) tokens.set(key, tokens.size + 1);
      return { ...device.getDiagnostics(), tokenNumber: key ? tokens.get(key) : null };
    });
    const overview = {
      app: {
        version: this.homey.manifest.version,
        homeyVersion: this.homey.version || null,
        debug: this.debugMode,
        runningSince: this.startedAt ? new Date(this.startedAt).toISOString() : null,
      },
      generatedAt: new Date().toISOString(),
      tokens: tokens.size,
      heatPumps,
      log: (this.logBuffer || []).map((line) => ({ ...line, time: new Date(line.time).toISOString() })),
    };
    return { ...overview, text: diagnosticsText(overview) };
  }

  /**
   * Returns the shared API client for a token, creating it when needed.
   * @param {string} apiKey
   * @returns {MelPumpApi}
   */
  getClient(apiKey) {
    let client = this.clients.get(apiKey);

    if (!client) {
      client = new MelPumpApi({
        apiKey,
        log: (...args) => this.log('[api]', ...args),
        debug: this.debugMode ? (...args) => this.log('[debug] [api]', ...args) : null,
      });
      this.clients.set(apiKey, client);
    }

    return client;
  }

  /**
   * Drops the client for a token that is no longer used by any device.
   * @param {string} apiKey
   * @param {Homey.Device} [except] a device being deleted, still in the device list
   */
  removeClient(apiKey, except = null) {
    const stillUsed = this.heatPumps()
      .some((device) => device !== except && device.getStoreValue('apiKey') === apiKey);
    if (!stillUsed) this.clients.delete(apiKey);
  }

  async onUninit() {
    this.clients.clear();
  }

}

module.exports = MelPumpApp;
