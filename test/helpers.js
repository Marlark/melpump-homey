'use strict';

/*
 * Test helpers: a stand-in for the Homey SDK, so the app's classes run in plain Node.
 * Only what the app uses is implemented.
 */

const Module = require('module');
const path = require('path');

// `require('homey')` returns empty base classes; the mocks below add what the app calls.
const originalLoad = Module._load;
Module._load = function load(request, ...rest) {
  if (request === 'homey') return { App: class {}, Driver: class {}, Device: class {} };
  return originalLoad.call(this, request, ...rest);
};

const ROOT = path.join(__dirname, '..');
const manifest = require(path.join(ROOT, 'app.json'));
const Device = require(path.join(ROOT, 'drivers/heatpump/device.js'));
const Driver = require(path.join(ROOT, 'drivers/heatpump/driver.js'));
const App = require(path.join(ROOT, 'app.js'));
const MelPumpApi = require(path.join(ROOT, 'lib/melpump_api.js'));

const driverManifest = manifest.drivers.find((driver) => driver.id === 'heatpump');

/**
 * Replaces Date with a clock that only moves when told to.
 * @param {string|number} start
 */
function fakeClock(start) {
  const RealDate = global.Date;
  let now = typeof start === 'number' ? start : RealDate.parse(start);
  class FakeDate extends RealDate {
    constructor(...args) {
      super(...(args.length ? args : [now]));
    }

    static now() {
      return now;
    }
  }
  global.Date = FakeDate;
  return {
    get now() {
      return now;
    },
    set(time) {
      now = typeof time === 'number' ? time : RealDate.parse(time);
    },
    advance(ms) {
      now += ms;
    },
    restore() {
      global.Date = RealDate;
    },
  };
}

/**
 * A heat pump device with an in-memory Homey: capabilities, store, settings, timers,
 * triggers (recorded in `fired`) and an API mock (`api`, replace methods as needed).
 * Initialized with the device's own onInit, without an API token, so it doesn't poll.
 * @param {object} [options]
 * @param {object} [options.store] initial store values
 * @param {object} [options.settings] initial settings
 * @param {object} [options.api] API methods
 */
async function createDevice({ store = {}, settings = {}, api = {} } = {}) {
  const device = Object.create(Device.prototype);
  const capabilities = new Map();
  const options = new Map();
  const values = { ...store };
  const deviceSettings = { ...settings };
  const fired = [];
  const timers = [];
  const logs = [];
  const listeners = {};
  let deviceClass = 'other';
  let available = true;

  // Trigger name -> argument values of the Flows using it; not set = unknown (null).
  const flowArgValues = {};
  const triggers = {};
  const driver = new Proxy({ manifest: driverManifest }, {
    get(target, name) {
      if (name in target) return target[name];
      if (!triggers[name]) {
        triggers[name] = {
          trigger: async (dev, tokens, state) => { fired.push({ trigger: name, tokens, state }); },
          getArgumentValues: async () => (name in flowArgValues ? flowArgValues[name] : null),
        };
      }
      return triggers[name];
    },
  });

  Object.assign(device, {
    fired,
    flowArgValues,
    timers,
    logs,
    listeners,
    capabilities,
    homey: {
      __: (key, tokens) => (tokens ? `${key} ${JSON.stringify(tokens)}` : key),
      manifest,
      i18n: { getLanguage: () => 'en' },
      app: { debugMode: false, emitWidgetStatus() {}, removeClient() {} },
      notifications: { createNotification: async (n) => { fired.push({ notification: n.excerpt }); } },
      setTimeout: (fn, delay) => {
        const timer = { fn, delay, cleared: false };
        timers.push(timer);
        return timer;
      },
      clearTimeout: (timer) => {
        if (timer) timer.cleared = true;
      },
    },
    driver,
    getData: () => ({ id: '42' }),
    getName: () => 'Heat pump',
    getClass: () => deviceClass,
    setClass: async (value) => { deviceClass = value; },
    getAvailable: () => available,
    setAvailable: async () => { available = true; },
    setUnavailable: async () => { available = false; },
    setWarning: async (message) => { device.warning = message; },
    unsetWarning: async () => { device.warning = null; },
    hasCapability: (id) => capabilities.has(id),
    getCapabilityValue: (id) => (capabilities.has(id) ? capabilities.get(id) : null),
    setCapabilityValue: async (id, value) => {
      if (!capabilities.has(id)) throw new Error(`Missing capability ${id}`);
      capabilities.set(id, value);
    },
    addCapability: async (id) => { capabilities.set(id, null); },
    removeCapability: async (id) => { capabilities.delete(id); },
    getCapabilityOptions: (id) => options.get(id) || {},
    setCapabilityOptions: async (id, value) => { options.set(id, value); },
    registerCapabilityListener: (id, fn) => { listeners[id] = fn; },
    registerMultipleCapabilityListener: (ids, fn, debounce) => {
      for (const id of ids) listeners[id] = { fn, debounce };
    },
    getStoreValue: (key) => values[key],
    setStoreValue: async (key, value) => { values[key] = value; },
    getSettings: () => ({ ...deviceSettings }),
    getSetting: (key) => deviceSettings[key],
    setSettings: async (changed) => { Object.assign(deviceSettings, changed); },
    log: (...args) => logs.push(args.join(' ')),
    error: (...args) => logs.push(`ERROR ${args.join(' ')}`),
  });
  device.store = values;

  await device.onInit();

  // The real getter builds a counting proxy around the app's client; tests use a plain mock.
  Object.defineProperty(device, 'api', { value: api, writable: true });
  return device;
}

module.exports = {
  App,
  Device,
  Driver,
  MelPumpApi,
  manifest,
  driverManifest,
  fakeClock,
  createDevice,
};
