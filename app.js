'use strict';

const Homey = require('homey');
const MelPumpApi = require('./lib/melpump_api');

// The widget asks for data when it opens and every few minutes after; without a
// request for this long, no widget is open and realtime updates aren't sent.
const WIDGET_ACTIVE_MS = 10 * 60 * 1000;

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

  heatPumps() {
    return this.homey.drivers.getDriver('heatpump').getDevices();
  }

  /**
   * @param {string} [deviceId] MelPump device id from the widget setting; the first heat pump if empty
   */
  findHeatPump(deviceId) {
    const devices = this.heatPumps();
    return devices.find((d) => d.getData().id === deviceId) || devices[0] || null;
  }

  /**
   * Data for the dashboard widget, when it opens and as a fallback refresh.
   * @param {string} [deviceId]
   */
  getWidgetStatus(deviceId) {
    // Widgets are open: push updates to them after each poll (see emitWidgetStatus).
    this.widgetSeenAt = Date.now();
    const device = this.findHeatPump(deviceId);
    return device ? device.getWidgetStatus() : null;
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
    if (!device) throw new Error(this.homey.__('widget.no_device'));
    await device.runWidgetAction(action);
    return device.getWidgetStatus();
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
