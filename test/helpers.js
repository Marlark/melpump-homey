'use strict';

/*
 * Test helpers: a stand-in for the Homey SDK, so the app's classes run in plain Node.
 * Only what the app uses is implemented.
 */

const Module = require('module');
const { after } = require('node:test');
const path = require('path');

// `require('homey')` returns empty base classes; the mocks below add what the app calls.
const originalLoad = Module._load;
Module._load = function load(request, ...rest) {
  if (request === 'homey') {
    // log and error as in the SDK (SimpleClass), so the app's own log / error can call super.
    class SimpleClass {
      log() {}

      error() {}
    }
    return { App: class extends SimpleClass {}, Driver: class extends SimpleClass {}, Device: class extends SimpleClass {} };
  }
  return originalLoad.call(this, request, ...rest);
};

const ROOT = path.join(__dirname, '..');
const manifest = require(path.join(ROOT, 'app.json'));
const Device = require(path.join(ROOT, 'drivers/heatpump/device.js'));
const Driver = require(path.join(ROOT, 'drivers/heatpump/driver.js'));
const App = require(path.join(ROOT, 'app.js'));
const MelPumpApi = require(path.join(ROOT, 'lib/melpump_api.js'));

const driverManifest = manifest.drivers.find((driver) => driver.id === 'heatpump');
const translations = require(path.join(ROOT, 'locales/en.json'));

/*
 * Checks that mirror Homey, so mistakes fail in the tests instead of on a real Homey.
 * Flow cards and trigger tokens follow the SDK (@athombv/homey-apps-sdk-v3, FlowCard and
 * FlowCardTriggerDevice). Capability values are checked against their type in app.json;
 * Homey core does that check, and its code isn't public, so the rules here are a little
 * stricter (a number must also be finite). Missing translations are an error as well.
 */

// Every check that failed, also those the app caught and only logged; see the `after` hook.
const violations = [];

/** Records a broken Homey rule and throws, as Homey would. */
function violation(message) {
  violations.push(message);
  throw new Error(message);
}

// Fails the test file when the app broke a Homey rule, even if it caught the error.
// A test that breaks a rule on purpose removes its message with `expectViolation`.
after(() => {
  if (violations.length) {
    throw new Error(`Homey would reject:\n  ${[...new Set(violations)].join('\n  ')}`);
  }
});

/**
 * Runs fn and returns the Homey rules it broke, without failing the test file for them.
 * @param {Function} fn
 * @returns {Promise<string[]>}
 */
async function expectViolation(fn) {
  const start = violations.length;
  try {
    await fn();
  } catch (err) {
    // The check also throws; the caller asserts on what was recorded.
  }
  return violations.splice(start);
}

// System capabilities the app uses; app.json only defines the app's own.
const SYSTEM_CAPABILITIES = {
  alarm_generic: { type: 'boolean' },
  measure_power: { type: 'number' },
  measure_temperature: { type: 'number' },
  meter_power: { type: 'number' },
  target_temperature: { type: 'number' },
};

/** The definition of a capability, also for sub-capabilities such as `measure_temperature.outdoor`. */
function capabilityDefinition(id) {
  const base = id.split('.')[0];
  return (manifest.capabilities || {})[base] || SYSTEM_CAPABILITIES[base];
}

function checkCapabilityValue(id, value) {
  if (value === null) return;
  const { type, values } = capabilityDefinition(id);
  const fail = (expected) => {
    violation(`Invalid value for capability ${id}: expected ${expected}, got ${JSON.stringify(value)}`);
  };
  if (type === 'number' && !(typeof value === 'number' && Number.isFinite(value))) fail('a finite number');
  if (type === 'boolean' && typeof value !== 'boolean') fail('a boolean');
  if (type === 'string' && typeof value !== 'string') fail('a string');
  if (type === 'enum' && !values.some((option) => option.id === value)) {
    fail(`one of ${values.map((option) => option.id).join(', ')}`);
  }
}

/** Like Homey's `__`, but throws for a key that isn't in locales/en.json. */
function translate(key, tokens) {
  const text = String(key).split('.').reduce((node, part) => (node == null ? undefined : node[part]), translations);
  if (typeof text !== 'string') violation(`Missing translation: ${key}`);
  return tokens ? `${key} ${JSON.stringify(tokens)}` : key;
}

// How the SDK checks trigger tokens (FlowCardTriggerDevice.trigger).
const TOKEN_TYPES = {
  string: 'string',
  number: 'number',
  boolean: 'boolean',
  image: 'object',
};

/**
 * A Flow card as the SDK builds it: the id must be in app.json, and a trigger checks its
 * tokens against the card's manifest before it fires.
 * @param {string} type trigger, condition or action
 * @param {string} id
 * @param {object} context
 * @param {object} context.device the only device a trigger accepts
 * @param {Array} context.fired where triggers are recorded
 * @param {object} context.flowArgValues argument values per trigger name
 */
function createFlowCard(type, id, { device, fired, flowArgValues }) {
  const cards = manifest.flow && manifest.flow[`${type}s`];
  const cardManifest = Array.isArray(cards) ? cards.find((card) => card.id === id) : undefined;
  if (!cardManifest) violation(`Invalid Flow Card ID: ${id} (${type})`);

  const card = {
    id,
    type,
    manifest: cardManifest,
    // The driver property that holds the card, such as `copChangedTrigger`; set by createDevice.
    name: id,
    registerRunListener(fn) {
      card.runListener = fn;
      return card;
    },
    registerArgumentAutocompleteListener(name, fn) {
      card.autocomplete = { ...card.autocomplete, [name]: fn };
      return card;
    },
    on() {
      return card;
    },
    getArgumentValues: async () => (card.name in flowArgValues ? flowArgValues[card.name] : null),
  };

  if (type === 'trigger') {
    card.trigger = async (dev, tokens, state) => {
      if (dev !== device) violation(`Could not trigger Flow card with id "${id}": expected the device`);
      if (tokens == null) tokens = {};
      if (typeof tokens !== 'object') {
        violation(`Could not trigger Flow card with id "${id}": expected tokens to be an object`);
      }
      for (const { name, type: tokenType = 'string' } of cardManifest.tokens || []) {
        const expected = TOKEN_TYPES[tokenType];
        const provided = typeof tokens[name];
        if (provided !== expected) {
          violation(`Could not trigger Flow card with id "${id}": Invalid value for token ${name}. Expected ${expected} but got ${provided}`);
        }
      }
      fired.push({ trigger: card.name, tokens, state });
    };
  }
  return card;
}

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

  // The app's own driver, with Flow cards that check their id and tokens like the SDK.
  const cardContext = { device, fired, flowArgValues };
  const driver = Object.create(Driver.prototype);
  Object.assign(driver, {
    manifest: driverManifest,
    log: () => {},
    error: () => {},
    getDevices: () => [device],
    homey: {
      __: translate,
      app: { debugMode: false },
      flow: {
        getDeviceTriggerCard: (id) => createFlowCard('trigger', id, cardContext),
        getConditionCard: (id) => createFlowCard('condition', id, cardContext),
        getActionCard: (id) => createFlowCard('action', id, cardContext),
      },
    },
  });
  await driver.onInit();
  // Triggers are recorded under the driver property that holds them, such as `copChangedTrigger`.
  for (const [name, value] of Object.entries(driver)) {
    if (value && value.type === 'trigger') value.name = name;
  }

  Object.assign(device, {
    fired,
    flowArgValues,
    timers,
    logs,
    listeners,
    capabilities,
    homey: {
      __: translate,
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
      checkCapabilityValue(id, value);
      capabilities.set(id, value);
    },
    addCapability: async (id) => {
      if (!capabilityDefinition(id)) violation(`Unknown capability ${id}`);
      if (!capabilities.has(id)) capabilities.set(id, null);
    },
    removeCapability: async (id) => { capabilities.delete(id); },
    getCapabilityOptions: (id) => {
      if (!capabilities.has(id)) throw new Error(`Invalid Capability: ${id}`);
      return options.get(id) || {};
    },
    setCapabilityOptions: async (id, value) => {
      if (!capabilities.has(id)) violation(`setCapabilityOptions on missing capability ${id}`);
      options.set(id, value);
    },
    registerCapabilityListener: (id, fn) => { listeners[id] = fn; },
    registerMultipleCapabilityListener: (ids, fn, debounce) => {
      for (const id of ids) listeners[id] = { fn, debounce };
    },
    getStoreValue: (key) => values[key],
    setStoreValue: async (key, value) => {
      if (typeof key !== 'string') violation(`Cannot set store value, key must be of type string (key: ${key})`);
      values[key] = value;
    },
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
  expectViolation,
};
