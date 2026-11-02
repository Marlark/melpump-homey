'use strict';

const Homey = require('homey');

// melpump.com allows 100 requests per hour per device. Every minute the live
// state is fetched; device details every 5th, alarms every 15th and energy
// (daily totals + today's state history) every 60th minute. That is ~78
// requests/hour, leaving room for changes. While the heat pump is offline only
// the device details are checked (12/hour). Device details are also fetched once
// just after each full hour, when Smart Energy usually starts or stops (at most
// 1 extra request/hour), and on the next poll after a Flow changes a function.
const POLL_INTERVAL_MS = 60 * 1000;
// Time to the next poll by number of consecutive failed polls: one quick retry,
// then slower while melpump.com can't be reached. Back to every minute on success.
const POLL_BACKOFF_MS = [1, 1, 2, 5, 10].map((minutes) => minutes * POLL_INTERVAL_MS);
// After a change from Homey, the next poll comes this soon to show the result.
const REFRESH_AFTER_WRITE_MS = 20 * 1000;
// Debounce for the temperature sliders: only the last value of a quick series is sent.
const TEMPERATURE_DEBOUNCE_MS = 1500;
// A failed poll repeating the previous error is logged only every this many times.
const REPEATED_ERROR_LOG_EVERY = 10;
const DEVICE_POLL_EVERY = 5;
const ALARM_POLL_EVERY = 15;
const ENERGY_POLL_EVERY = 60;
// Subscription status and write access rarely change: every 6 hours (and on a 403).
const ACCESS_POLL_EVERY = 6 * 60;
// After a Homey restart every heat pump would make its first, largest poll at once;
// each starts within this time instead.
const STARTUP_SPREAD_MS = 20 * 1000;
// How long the argument values of a trigger's Flows are kept (see flowArgs).
const FLOW_ARGS_TTL_MS = 5 * 60 * 1000;
// Changes smaller than this aren't written: the value hardly moves, but every write
// is a call to Homey and an Insights entry. Going to or from 0 is always written.
const DEADBANDS = {
  measure_power: 10,
  melpump_heat_output: 10,
  measure_cop: 0.05,
  melpump_flow_rate: 0.1,
  melpump_delta_t: 0.2,
};
const RATE_LIMIT_PAUSE_MS = 10 * 60 * 1000;
// The app counts its own requests over the last hour. Reads are skipped above
// REQUEST_BUDGET, keeping the rest of the 100/hour for changes made from Homey.
const REQUEST_WINDOW_MS = 60 * 60 * 1000;
const REQUEST_BUDGET = 90;
// Mark the device unavailable only after this many consecutive failed polls,
// so a single network hiccup doesn't flip it to "unavailable" in the UI.
const MAX_FAILED_POLLS = 3;
// Daily energy is only published for completed days. Days are fetched one per
// request (responses carry no date), capped per poll to protect the rate limit.
const MAX_ENERGY_DAYS_PER_POLL = 5;
// Power samples further apart than this are not integrated (e.g. after a restart).
const MAX_INTEGRATION_GAP_MS = 5 * 60 * 1000;
// The state history has a sample every 5 minutes; tolerate a couple of missing ones.
const MAX_HISTORY_GAP_MS = 15 * 60 * 1000;
const PERSIST_ESTIMATE_EVERY = 10;
const SCOP_DAYS = 30;
// Below this, a COP for saving / solar / normal mode is too uncertain to show.
const MIN_KWH_FOR_COP = 0.1;
// A forced solar mode that ended longer ago than this (e.g. while the app wasn't
// running) is cleared without firing the "has ended" trigger.
const FORCED_SOLAR_LATE_MS = 10 * 60 * 1000;
// Hot water counts as ready within this many °C of its target, and is "used" again
// (so the next "ready" can fire) once it is this far below the target.
const HOT_WATER_READY_MARGIN = 1;
const HOT_WATER_REARM = 5;
// "Hot water boost" from a Flow: minutes allowed.
const BOOST_MINUTES = { min: 5, max: 240 };
// Room temperature readings kept for "Room temperature deviates" (its longest wait).
const ROOM_HISTORY_MS = 3 * 60 * 60 * 1000;
// Immersion heater / booster heater -> how the live state reports it.
const HEATERS = {
  immersion: (state) => toBoolean(state.ImmersionHeaterStatus),
  booster: (state) => {
    const values = [state.BoosterHeater1Status, state.BoosterHeater2Status, state.BoosterHeater2PlusStatus]
      .map(toBoolean)
      .filter((v) => v !== null);
    return values.length ? values.some(Boolean) : null;
  },
};

// Modes the app keeps hours / energy / COP statistics for (per day, today and yesterday).
const MODE_STATS = {
  saving: {
    capability: 'melpump_saving_mode',
    time: 'melpump_saving_time',
    energy: 'melpump_saving_energy',
    share: 'melpump_saving_share_yesterday',
    cop: 'melpump_cop_saving_yesterday',
  },
  solar: {
    capability: 'melpump_solar_mode',
    time: 'melpump_solar_time',
    energy: 'melpump_solar_energy',
    share: 'melpump_solar_share_yesterday',
    cop: 'melpump_cop_solar_yesterday',
  },
};

// Flow trigger "Solar function switched on/off" -> DeviceSettings field.
const SOLAR_FUNCTIONS = {
  solar_hot_water: 'solarTankActive',
  solar_zone1: 'solarZone1Active',
  solar_zone2: 'solarZone2Active',
};
// Bump when new values are derived from yesterday's energy, so they're fetched again.
const ENERGY_STATS_VERSION = 4;
// Completed months for "this year" / "last month" are fetched once and cached; this
// many per hourly energy check, so filling the cache after pairing is spread out.
const MAX_MONTH_FETCHES_PER_POLL = 3;

// EstInputPower / EstOutputPower are reported in kW (confirmed: input x COP = output).
const POWER_FACTOR_TO_WATT = 1000;

// TemperatureDTO.operationMode: 2=Heating, 3=Cooling, 10=Auto. "off" uses change-state power.
const MODE_TO_OPERATION_MODE = { heating: 2, cooling: 3, auto: 10 };
const VALID_MODES = [...Object.keys(MODE_TO_OPERATION_MODE), 'off'];

// DeviceState.OperationMode: what the heat pump is doing right now.
const OPERATION_STATES = ['off', 'tank_water', 'heating', 'cooling', 'defrost', 'standby', 'legionella'];

// Flow "Turn function on/off" -> ToggleStateDTO field.
const FUNCTION_TOGGLES = {
  holiday: 'HolidayMode',
  quiet: 'QuietMode',
  force_hot_water: 'forceHotWater',
  smart_energy: 'smartEnergy',
  night_mode: 'nightMode',
  summer_eco: 'summerEco',
  eco_hot_water: 'EcoHotWater',
  solar_hot_water: 'solarHw',
  solar_zone1: 'solarZ1',
  solar_zone2: 'solarZ2',
};

// Functions whose on/off state is reported in DeviceSettings (*Active = switched on).
const FUNCTION_SETTINGS = {
  smart_energy: 'smartEnergyActive',
  night_mode: 'nightModeActive',
  summer_eco: 'summerEcoActive',
  solar_hot_water: 'solarTankActive',
  solar_zone1: 'solarZone1Active',
  solar_zone2: 'solarZone2Active',
};

// Toggles on the device page -> FUNCTION_TOGGLES key. Smart Energy, night mode and
// summer eco follow DeviceSettings (*Active); the API doesn't report holiday or
// quiet mode, so those toggles show what was last set from Homey.
const FUNCTION_SWITCHES = {
  melpump_smart_energy_switch: 'smart_energy',
  melpump_night_mode_switch: 'night_mode',
  melpump_summer_eco_switch: 'summer_eco',
  melpump_holiday_switch: 'holiday',
  melpump_quiet_switch: 'quiet',
};

// Device setting (checkbox) -> capabilities it shows. Unchecked = removed from the device.
const CAPABILITY_GROUPS = {
  show_switches: [...Object.keys(FUNCTION_SWITCHES), 'melpump_holiday_until'],
  show_mode_stats: [
    'melpump_saving_time_today', 'melpump_saving_time_yesterday',
    'melpump_saving_energy_today', 'melpump_saving_energy_yesterday',
    'melpump_saving_share_yesterday', 'melpump_cop_saving_yesterday',
    'melpump_solar_time_today', 'melpump_solar_time_yesterday',
    'melpump_solar_energy_today', 'melpump_solar_energy_yesterday',
    'melpump_solar_share_yesterday', 'melpump_cop_solar_yesterday',
    'melpump_cop_normal_yesterday',
  ],
  show_run_stats: [
    'melpump_compressor_starts_today', 'melpump_compressor_starts_yesterday',
    'melpump_compressor_hours_today', 'melpump_compressor_hours_yesterday', 'melpump_avg_run_minutes_today',
    'melpump_defrosts_today', 'melpump_defrost_minutes_today',
    'melpump_immersion_minutes_today', 'melpump_booster_minutes_today',
  ],
  show_breakdown: [
    'melpump_cop_heating_yesterday', 'melpump_cop_hot_water_yesterday',
    'melpump_energy_heating_yesterday', 'melpump_energy_hot_water_yesterday',
    'melpump_heat_heating_yesterday', 'melpump_heat_hot_water_yesterday',
    'melpump_energy_cooling_yesterday', 'melpump_heat_cooling_yesterday', 'melpump_cop_cooling_yesterday',
  ],
  show_period_stats: [
    'melpump_energy_this_month', 'melpump_heat_this_month', 'melpump_cop_this_month',
    'melpump_energy_last_month', 'melpump_heat_last_month', 'melpump_cop_last_month',
    'melpump_energy_this_year', 'melpump_heat_this_year', 'melpump_cop_this_year',
  ],
  show_alarm_info: ['melpump_last_alarm', 'melpump_alarms_today', 'melpump_alarms_unacknowledged'],
};

// What the heat pump has (from Device) -> capabilities that only make sense with it.
// Unknown (not reported yet) counts as present.
const FEATURE_CAPABILITIES = {
  canCool: ['melpump_energy_cooling_yesterday', 'melpump_heat_cooling_yesterday', 'melpump_cop_cooling_yesterday'],
  thermostatZone1: ['measure_temperature', 'target_temperature'],
  thermostatZone2: ['measure_temperature.zone2', 'target_temperature.zone2'],
};

// Flow choices that need cooling; refused with a clear message when the heat pump can't cool.
const COOLING_CHOICES = {
  mode: ['cooling'],
  block: ['cooling_zone1', 'cooling_zone2'],
  flow: ['cooling'],
  zoneMode: ['cooling_room_control', 'cooling_flow', 'cooling_dry_up', 'cooling_curve'],
};

// Dashboard widget: power over the last 24 hours, as 5-minute averages.
const WIDGET_DAY_MS = 24 * 60 * 60 * 1000;
const WIDGET_DAY_BUCKET_MS = 5 * 60 * 1000;
// Capability -> mode chip shown in the widget.
const WIDGET_MODES = {
  melpump_saving_mode: 'saving',
  melpump_solar_mode: 'solar',
  melpump_night_mode: 'night',
  melpump_summer_eco: 'summer_eco',
  melpump_defrost: 'defrost',
};
// The widget's quick buttons. Each goes through write(), so it needs write access.
const WIDGET_ACTIONS = {
  hot_water_hot: (device) => device.applyHotWaterPreset('hot'),
  hot_water_comfort: (device) => device.applyHotWaterPreset('comfort'),
  solar_1h: (device) => device.forceSolarMode(60),
  saving_on: (device) => device.setSavingMode(true),
  saving_off: (device) => device.setSavingMode(false),
  acknowledge_alarms: (device) => device.acknowledgeAlarms(),
};

// Flow "Apply hot water preset" -> DeviceSettings field holding the tank temperature.
const HOT_WATER_PRESETS = {
  eco: 'quickTankEcoTemperature',
  comfort: 'quickTankComfortTemperature',
  hot: 'quickTankHotTemperature',
};

// Flow "Block/allow" -> ToggleStateDTO field (true = prohibited).
const BLOCK_TOGGLES = {
  heating_zone1: 'prohibitZ1',
  heating_zone2: 'prohibitZ2',
  hot_water: 'prohibitHotWater',
  cooling_zone1: 'prohibitCoolingZ1',
  cooling_zone2: 'prohibitCoolingZ2',
};

// Flow "Set zone control mode" -> TemperatureDTO.operationModeZone1/2.
const ZONE_MODES = {
  room_control: 0,
  constant_flow: 1,
  heat_curve: 2,
  cooling_room_control: 3,
  cooling_flow: 4,
  cooling_dry_up: 5,
  online_curve: 10,
  pool: 11,
  cooling_curve: 12,
};

// Flow "Set flow temperature" -> TemperatureDTO field prefix and allowed range.
const FLOW_TEMPERATURES = {
  heating: { field: 'heatFlowTemperatureZone', min: 10, max: 80 },
  cooling: { field: 'coolFlowTemperatureZone', min: 5, max: 25 },
};

// DeviceState.OperationModeZone1/2 -> ZONE_MODES id, for reading the zone mode back.
const ZONE_MODE_IDS = Object.fromEntries(Object.entries(ZONE_MODES).map(([id, value]) => [value, id]));
// The zone mode of zone 1 and zone 2, in that order.
const ZONE_MODE_CAPABILITIES = ['melpump_zone_mode', 'melpump_zone_mode.zone2'];

const ZONES = ['1', '2'];

// Flow "Apply preset" -> DeviceSettings field holding the preset temperature.
const PRESET_FIELDS = {
  away: 'quickIndoorAwayTemperature',
  home: 'quickIndoorHomeTemperature',
  boost: 'quickIndoorBoostTemperature',
};

// Added only when the heat pump reports an active zone 2.
const ZONE2_CAPABILITIES = {
  'measure_temperature.zone2': {
    title: {
      en: 'Room temperature zone 2', nl: 'Kamertemperatuur zone 2', sv: 'Rumstemperatur zon 2',
      de: 'Raumtemperatur Zone 2', da: 'Rumtemperatur zone 2', no: 'Romtemperatur sone 2',
    },
  },
  'target_temperature.zone2': {
    title: {
      en: 'Target temperature zone 2', nl: 'Doeltemperatuur zone 2', sv: 'Önskad temperatur zon 2',
      de: 'Solltemperatur Zone 2', da: 'Ønsket temperatur zone 2', no: 'Ønsket temperatur sone 2',
    },
    min: 10,
    max: 30,
    step: 0.5,
  },
  'measure_temperature.flow_zone2': {
    title: {
      en: 'Flow temperature zone 2', nl: 'Aanvoertemperatuur zone 2', sv: 'Framledningstemperatur zon 2',
      de: 'Vorlauftemperatur Zone 2', da: 'Fremløbstemperatur zone 2', no: 'Turtemperatur sone 2',
    },
  },
  'melpump_target_flow_temperature.zone2': {
    title: {
      en: 'Target flow temperature zone 2', nl: 'Doelaanvoertemperatuur zone 2', sv: 'Önskad framledning zon 2',
      de: 'Soll-Vorlauftemperatur Zone 2', da: 'Ønsket fremløb zone 2', no: 'Ønsket turtemperatur sone 2',
    },
  },
  'melpump_zone_active.zone2': {
    title: {
      en: 'Zone 2 heating/cooling', nl: 'Zone 2 verwarmt/koelt', sv: 'Zon 2 värmer/kyler',
      de: 'Zone 2 heizt/kühlt', da: 'Zone 2 varmer/køler', no: 'Sone 2 varmer/kjøler',
    },
  },
  'melpump_zone_mode.zone2': {
    title: {
      en: 'Zone 2 mode', nl: 'Modus zone 2', sv: 'Läge zon 2',
      de: 'Modus Zone 2', da: 'Tilstand zone 2', no: 'Modus sone 2',
    },
  },
};

// Reads a temperature that some adapters report as 0 when the sensor doesn't exist.
const sensor = (field) => (state) => {
  const value = toNumber(state[field]);
  return value === 0 ? null : value;
};

// Flow minus return: how much heat the water gives off in the circuit.
const difference = (flow, back) => (flow === null || back === null ? null : round(flow - back, 1));

// Sensors not every heat pump has. Each is added the first time the heat pump
// reports a value for it and then kept (no flapping when a value is briefly missing).
// read(state): the value, or null when the heat pump doesn't report it (default:
// the number in `field`). zeroMeansMissing: some adapters report 0 instead of null
// for unsupported fields. groundSourceOnly: only for ground source heat pumps.
const OPTIONAL_CAPABILITIES = [
  { capability: 'melpump_condensing_temperature', field: 'CondensingTemperature', zeroMeansMissing: true },
  { capability: 'melpump_mixing_tank_temperature', field: 'MixingTankWaterTemperature', zeroMeansMissing: true },
  { capability: 'melpump_fan_speed', field: 'Fan1RPM', zeroMeansMissing: true },
  {
    capability: 'melpump_fan_speed.fan2',
    field: 'Fan2RPM',
    zeroMeansMissing: true,
    options: {
      title: {
        en: 'Fan speed 2', nl: 'Ventilatortoerental 2', sv: 'Fläktvarvtal 2',
        de: 'Lüfterdrehzahl 2', da: 'Blæserhastighed 2', no: 'Viftehastighet 2',
      },
    },
  },
  { capability: 'melpump_brine_in_temperature', field: 'BrineInletTemp', groundSourceOnly: true },
  { capability: 'melpump_brine_out_temperature', field: 'BrineOutletTemp', groundSourceOnly: true },
  {
    capability: 'melpump_zone_mode',
    read: (state) => ZONE_MODE_IDS[toNumber(state.OperationModeZone1)] || null,
  },
  {
    capability: 'measure_temperature.flow_zone1',
    read: sensor('FlowTemperatureZone1'),
    options: {
      title: {
        en: 'Flow temperature zone 1', nl: 'Aanvoertemperatuur zone 1', sv: 'Framledningstemperatur zon 1',
        de: 'Vorlauftemperatur Zone 1', da: 'Fremløbstemperatur zone 1', no: 'Turtemperatur sone 1',
      },
    },
  },
  {
    capability: 'measure_temperature.return_zone1',
    read: sensor('ReturnTemperatureZone1'),
    options: {
      title: {
        en: 'Return temperature zone 1', nl: 'Retourtemperatuur zone 1', sv: 'Returtemperatur zon 1',
        de: 'Rücklauftemperatur Zone 1', da: 'Returtemperatur zone 1', no: 'Returtemperatur sone 1',
      },
    },
  },
  {
    capability: 'measure_temperature.return_zone2',
    read: sensor('ReturnTemperatureZone2'),
    options: {
      title: {
        en: 'Return temperature zone 2', nl: 'Retourtemperatuur zone 2', sv: 'Returtemperatur zon 2',
        de: 'Rücklauftemperatur Zone 2', da: 'Returtemperatur zone 2', no: 'Returtemperatur sone 2',
      },
    },
  },
  {
    capability: 'measure_temperature.flow_boiler',
    read: sensor('FlowTemperatureBoiler'),
    options: {
      title: {
        en: 'Boiler flow temperature', nl: 'Aanvoertemperatuur ketel', sv: 'Framledningstemperatur panna',
        de: 'Vorlauftemperatur Kessel', da: 'Fremløbstemperatur kedel', no: 'Turtemperatur kjel',
      },
    },
  },
  {
    capability: 'measure_temperature.return_boiler',
    read: sensor('ReturnTemperatureBoiler'),
    options: {
      title: {
        en: 'Boiler return temperature', nl: 'Retourtemperatuur ketel', sv: 'Returtemperatur panna',
        de: 'Rücklauftemperatur Kessel', da: 'Returtemperatur kedel', no: 'Returtemperatur kjel',
      },
    },
  },
  {
    capability: 'melpump_delta_t.zone1',
    read: (state) => difference(sensor('FlowTemperatureZone1')(state), sensor('ReturnTemperatureZone1')(state)),
    options: {
      title: {
        en: 'Flow/return difference zone 1', nl: 'Verschil aanvoer/retour zone 1', sv: 'Skillnad fram/retur zon 1',
        de: 'Differenz Vor-/Rücklauf Zone 1', da: 'Forskel frem/retur zone 1', no: 'Forskjell tur/retur sone 1',
      },
    },
  },
  {
    capability: 'melpump_delta_t.zone2',
    read: (state) => difference(sensor('FlowTemperatureZone2')(state), sensor('ReturnTemperatureZone2')(state)),
    options: {
      title: {
        en: 'Flow/return difference zone 2', nl: 'Verschil aanvoer/retour zone 2', sv: 'Skillnad fram/retur zon 2',
        de: 'Differenz Vor-/Rücklauf Zone 2', da: 'Forskel frem/retur zone 2', no: 'Forskjell tur/retur sone 2',
      },
    },
  },
];

// Read-only "Installation" fields on the device settings page.
const INSTALLATION_TYPES = ['radiators', 'underfloor', 'mixed', 'other'];

// measure_temperature.tank was replaced by melpump_tank_temperature (custom icon).
// Custom capabilities listed here must stay defined in app.json (not on the driver):
// Homey can't remove a capability it no longer knows, and then rejects every
// addCapability on the device as well.
const REMOVED_CAPABILITIES = [
  'measure_temperature.tank',
];

function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toBoolean(value) {
  return typeof value === 'boolean' ? value : null;
}

function toWatt(value) {
  const n = toNumber(value);
  return n === null ? null : Math.round(n * POWER_FACTOR_TO_WATT);
}

function round(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function sum(items, field) {
  return items.reduce((total, item) => total + (toNumber(item[field]) || 0), 0);
}

function ratio(produced, used) {
  return used > 0 ? round(produced / used, 2) : null;
}

/**
 * Whether a change is too small to write (see DEADBANDS). Sub-capabilities such as
 * melpump_delta_t.zone1 use the deadband of their capability.
 */
function withinDeadband(capability, previous, value) {
  const deadband = DEADBANDS[capability.split('.')[0]];
  if (!deadband || typeof previous !== 'number' || typeof value !== 'number') return false;
  if (previous === 0 || value === 0) return false;
  return Math.abs(value - previous) < deadband;
}

/**
 * Average compressor run in minutes today: running time per start.
 * @param {{ starts: number, hours: number }} stats
 */
function averageRunMinutes(stats) {
  return stats.starts > 0 ? Math.round((stats.hours * 60) / stats.starts) : null;
}

/**
 * "HH:mm" from a time in DeviceSettings ("22", "22:00", "22:00:00" or an ISO date-time).
 * @returns {string|null}
 */
function clockTime(value) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).includes('T') ? String(value).split('T')[1] : String(value);
  const match = /^(\d{1,2})(?::(\d{2}))?/.exec(text.trim());
  if (!match || Number(match[1]) > 23 || Number(match[2] || 0) > 59) return null;
  return `${match[1].padStart(2, '0')}:${match[2] || '00'}`;
}

// Creating an Intl.DateTimeFormat is slow and dates are formatted many times a minute,
// so one formatter per time zone and format is kept.
const FORMATTERS = new Map();

function zonedParts(date, timeZone, options) {
  const key = `${timeZone}|${JSON.stringify(options)}`;
  let formatter = FORMATTERS.get(key);
  if (!formatter) {
    // Throws for an unknown time zone; the callers fall back to UTC.
    formatter = new Intl.DateTimeFormat('en-US', { timeZone, ...options });
    FORMATTERS.set(key, formatter);
  }
  const parts = formatter.formatToParts(date);
  return (type) => parts.find((p) => p.type === type).value;
}

// YYYY-MM-DD for a moment in the given IANA time zone.
function dateInZone(date, timeZone) {
  try {
    const get = zonedParts(date, timeZone, { year: 'numeric', month: '2-digit', day: '2-digit' });
    return `${get('year')}-${get('month')}-${get('day')}`;
  } catch (err) {
    return date.toISOString().slice(0, 10);
  }
}

/**
 * The moment a wall-clock time occurs in an IANA time zone.
 * @param {string} day YYYY-MM-DD
 * @param {string} time HH:mm
 * @param {string} timeZone
 * @returns {number} timestamp
 */
function zonedTime(day, time, timeZone) {
  const wall = Date.parse(`${day}T${time}:00Z`);
  let moment = wall;
  // Two corrections cover the zone offset and a daylight saving change in between.
  for (let i = 0; i < 2; i += 1) {
    const shown = Date.parse(`${dateTimeInZone(new Date(moment), timeZone).replace(' ', 'T')}:00Z`);
    moment += wall - shown;
  }
  return moment;
}

// "YYYY-MM-DD HH:mm" for a moment in the given IANA time zone.
function dateTimeInZone(date, timeZone) {
  try {
    const get = zonedParts(date, timeZone, {
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    });
    return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
  } catch (err) {
    return date.toISOString().slice(0, 16).replace('T', ' ');
  }
}

// Shifts a YYYY-MM string by a number of months.
function shiftMonth(isoMonth, months) {
  const d = new Date(`${isoMonth}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 7);
}

// Daily energy items MelPump marks as an estimate (final figures may follow).
function isEstimated(items) {
  return items.some((item) => item && item.isEstimation === true);
}

// Shifts a YYYY-MM-DD string by a number of days.
function shiftDate(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

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
    // Compressor start times of the last hour, for "Compressor started often".
    this.startTimes = [];
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
      await this.startPolling({ spread: Date.now() - (this.homey.app.startedAt || 0) < 60000 });
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

  requestsLastHour() {
    const since = Date.now() - REQUEST_WINDOW_MS;
    this.requestTimes = this.requestTimes.filter((time) => time > since);
    return this.requestTimes.length;
  }

  /**
   * @param {number} [count] requests the next step may make
   */
  hasBudget(count = 1) {
    const ok = this.requestsLastHour() + count <= REQUEST_BUDGET;
    if (ok === this.overBudget) {
      this.overBudget = !ok;
      this.log(ok ? 'Request budget available again' : `Close to the rate limit (${this.requestsLastHour()} requests in the last hour), skipping reads`);
    }
    return ok;
  }

  get deviceId() {
    return this.getData().id;
  }

  /**
   * @param {object} [options]
   * @param {boolean} [options.spread] start within STARTUP_SPREAD_MS instead of now (app start)
   */
  async startPolling({ spread = false } = {}) {
    this.homey.clearTimeout(this.pollTimer);
    if (this.stopped) return;
    this.failedPolls = 0;
    this.pollCount = 0;
    this.pausedUntil = 0;

    // Each poll schedules the next one when it ends (see scheduleNextPoll).
    if (spread) {
      this.scheduleNextPoll(Math.round(Math.random() * STARTUP_SPREAD_MS));
      return;
    }
    await this.poll();
  }

  stopPolling() {
    this.stopped = true;
    this.homey.clearTimeout(this.pollTimer);
  }

  /**
   * Every minute while melpump.com answers. After failed polls the next one waits
   * longer (POLL_BACKOFF_MS), and after "Too Many Requests" until the pause ends.
   * Counted from the start of the poll, so slow responses don't shift the schedule.
   */
  pollDelay() {
    const now = Date.now();
    if (this.pausedUntil > now) return this.pausedUntil - now;
    if (this.pollSoonRequested) return REFRESH_AFTER_WRITE_MS;
    const delay = POLL_BACKOFF_MS[Math.min(this.failedPolls, POLL_BACKOFF_MS.length - 1)];
    return Math.max(1000, this.pollStartedAt + delay - now);
  }

  scheduleNextPoll(delay) {
    this.homey.clearTimeout(this.pollTimer);
    // Checked here, so a poll that was running during onUninit / onDeleted doesn't
    // schedule another one.
    if (this.stopped) return;
    this.nextPollAt = Date.now() + delay;
    this.pollTimer = this.homey.setTimeout(() => this.poll().catch(this.error), delay);
  }

  /**
   * Moves the next poll forward after a change from Homey, so the device shows
   * what the heat pump did with it (or that MelPump didn't accept it) within
   * REFRESH_AFTER_WRITE_MS instead of up to a minute (or longer after failures).
   */
  pollSoon() {
    if (this.stopped) return;
    this.pollSoonRequested = true;
    if (!this.polling && this.nextPollAt - Date.now() > REFRESH_AFTER_WRITE_MS) {
      this.scheduleNextPoll(REFRESH_AFTER_WRITE_MS);
    }
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
    await this.startPolling();
    this.log('API token updated via repair');
  }

  /**
   * Runs one poll at a time: when melpump.com is slow a poll can take longer than
   * POLL_INTERVAL_MS, and overlapping polls would double the requests and pile up.
   * A poll asked for meanwhile (e.g. right after a repair) runs once the current one ends.
   */
  async poll() {
    if (this.stopped) return;
    if (this.polling) {
      this.pollQueued = true;
      return;
    }
    this.polling = true;
    this.homey.clearTimeout(this.pollTimer);
    try {
      do {
        this.pollQueued = false;
        this.pollSoonRequested = false;
        this.pollStartedAt = Date.now();
        await this.pollOnce();
      } while (this.pollQueued && !this.stopped);
    } finally {
      this.polling = false;
      const delay = this.pollDelay();
      if (this.homey.app.debugMode) {
        this.debug(`Poll #${this.pollCount - 1} done in ${Date.now() - this.pollStartedAt} ms`
          + ` (${this.requestsLastHour()} requests in the last hour, ${this.failedPolls} failed in a row),`
          + ` next in ${Math.round(delay / 1000)} s`);
      }
      this.scheduleNextPoll(delay);
      // Push the new values to open dashboard widgets right away.
      if (!this.stopped) this.homey.app.emitWidgetStatus(this);
    }
  }

  async pollOnce() {
    await this.updateForcedSolar();
    await this.endTimedFunctions();
    if (Date.now() < this.pausedUntil) return;

    // The first poll fetches everything; after that each part has its own interval.
    const tick = this.pollCount;
    this.pollCount += 1;

    try {
      // Device first: it says whether the heat pump is online, and energy needs its time zone.
      if (this.hasBudget() && this.shouldFetchDevice(tick)) {
        this.refreshDevice = false;
        const device = await this.api.getDevice(this.deviceId);
        if (device) await this.applyDevice(device);
      }
      // Subscription status and write access, every 6 hours (and after a 403, see handlePollError).
      if (tick % ACCESS_POLL_EVERY === 0 && this.hasBudget()) await this.checkAccess();

      // While offline the live state would be stale, so only the device is checked.
      if (!this.offlineReason && this.hasBudget()) {
        const current = await this.api.getDeviceStatus(this.deviceId);
        await this.applyCurrentState(current);
        // The live statistics, saved together every few polls instead of separately.
        if ((tick + 1) % PERSIST_ESTIMATE_EVERY === 0) await this.persistStats();

        const catchUp = this.catchUp;
        this.catchUp = false;
        // Skipped alarm / energy checks run on their next interval.
        if ((tick % ALARM_POLL_EVERY === 0 || catchUp) && this.hasBudget()) await this.pollAlarms();
        if ((tick % ENERGY_POLL_EVERY === 0 || catchUp) && this.hasBudget(MAX_ENERGY_DAYS_PER_POLL + MAX_MONTH_FETCHES_PER_POLL + 4)) {
          await this.pollEnergy();
        }
      }
    } catch (err) {
      await this.handlePollError(err);
      return;
    }

    if (this.failedPolls > 0) this.log(`Polling works again after ${this.failedPolls} failed poll(s)`);
    this.failedPolls = 0;
    this.repeatedError = null;
    this.lastSuccess = Date.now();
    await this.updateAvailability();
    if (tick % DEVICE_POLL_EVERY === 0) await this.updateDiagnostics();
  }

  /**
   * Read-only "Diagnostics" settings. Updated every few polls and on errors,
   * not every minute, to avoid writing the settings that often.
   */
  async updateDiagnostics() {
    const format = (time) => dateTimeInZone(new Date(time), this.deviceTimezone);
    const info = {
      info_last_seen: this.lastSeenAt ? format(this.lastSeenAt) : '-',
      info_last_update: this.lastSuccess ? format(this.lastSuccess) : '-',
      info_requests_hour: String(this.requestsLastHour()),
      info_last_error: this.lastError ? `${format(this.lastError.time)}: ${this.lastError.message}`.slice(0, 200) : '-',
    };
    const current = this.getSettings();
    const changed = Object.fromEntries(Object.entries(info).filter(([key, value]) => current[key] !== value));
    if (Object.keys(changed).length) await this.setSettings(changed).catch(this.error);
  }

  /**
   * Device details: every DEVICE_POLL_EVERY polls, after a Flow changed a function,
   * and once in the first minutes of every hour (any fetch then counts).
   * @param {number} tick
   */
  shouldFetchDevice(tick) {
    const stamp = dateTimeInZone(new Date(), this.deviceTimezone);
    const hour = stamp.slice(0, 13);
    const pastHour = Number(stamp.slice(14, 16)) >= 1;

    const fetch = tick % DEVICE_POLL_EVERY === 0 || this.refreshDevice
      || (pastHour && hour !== this.deviceFetchedHour);
    if (fetch && pastHour) this.deviceFetchedHour = hour;
    return fetch;
  }

  async handlePollError(err) {
    this.lastError = { time: Date.now(), message: err.message };
    await this.updateDiagnostics();

    if (err.isRateLimited) {
      this.pausedUntil = Date.now() + RATE_LIMIT_PAUSE_MS;
      this.error('Rate limited by melpump.com, pausing polling for 10 minutes');
      return;
    }

    this.failedPolls += 1;
    this.logPollError(err.message);
    if (err.isAuthError) {
      // 403 can also mean the subscription ended; say so instead of blaming the token.
      if (err.status === 403) await this.checkAccess().catch(() => {});
      await this.markUnavailable(this.subscriptionWarning || this.homey.__('device.auth_failed'));
    } else if (this.failedPolls >= MAX_FAILED_POLLS) {
      await this.markUnavailable(err.message);
    }
  }

  /**
   * Logs a failed poll. The same error repeated (e.g. melpump.com down for hours)
   * is logged the first time and then every REPEATED_ERROR_LOG_EVERY times.
   * @param {string} message
   */
  logPollError(message) {
    if (this.repeatedError && this.repeatedError.message === message) {
      this.repeatedError.count += 1;
    } else {
      this.repeatedError = { message, count: 1 };
    }
    const { count } = this.repeatedError;
    if (count === 1) {
      this.error(`Polling failed (${this.failedPolls}/${MAX_FAILED_POLLS}):`, message);
    } else if (count % REPEATED_ERROR_LOG_EVERY === 0) {
      this.error(`Polling still failing (same error ${count} times in a row):`, message);
    }
  }

  async markUnavailable(message) {
    if (this.unavailableMessage === message) return;
    await this.setUnavailable(message).catch(this.error);
    this.unavailableMessage = message;
  }

  async updateAvailability() {
    // MelPump answered, so the device stays available. A heat pump that is offline
    // according to MelPump is shown as a warning, keeping its last values and Flows usable.
    if (this.unavailableMessage !== null || !this.getAvailable()) {
      await this.setAvailable().catch(this.error);
      this.unavailableMessage = null;
    }
    await this.refreshWarning();
  }

  /**
   * Shows the most important warning: offline, then subscription, then missing data.
   */
  async refreshWarning() {
    await this.showWarning(this.offlineReason || this.subscriptionWarning || this.dataWarning || null);
  }

  /**
   * Subscription status and write access for this heat pump's token.
   */
  async checkAccess() {
    const access = await this.api.getDeviceAccess(this.deviceId);
    if (!access) return;
    this.subscriptionWarning = access.subscriptionActive === false
      ? this.homey.__('device.subscription_inactive')
      : null;
    if (typeof access.writeAccess === 'boolean' && access.writeAccess !== this.getStoreValue('writeAccess')) {
      await this.setStoreValue('writeAccess', access.writeAccess).catch(this.error);
      this.log(`Write access is now ${access.writeAccess}`);
    }
  }

  /**
   * @param {{ state: object|null, dataQuality: number|null }} current
   */
  async applyCurrentState(current) {
    // dataQuality 2 = no data: keep the last values rather than storing blanks or zeros.
    if (!current || !current.state || current.dataQuality === 2) {
      this.lastPowerSample = null;
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
   * @param {string|null} message Warning to show, or null to clear it.
   */
  async showWarning(message) {
    if (this.warningMessage === message) return;
    if (message) {
      await this.setWarning(message).catch(this.error);
    } else {
      await this.unsetWarning().catch(this.error);
    }
    this.warningMessage = message;
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
        this.log(`Added ${capability}: the heat pump reports ${field}`);
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
      if (!offlineReason) this.catchUp = true;
      this.log(offlineReason ? `Heat pump offline: ${offlineReason}` : 'Heat pump back online');
    }
    this.offlineReason = offlineReason;

    await this.updateZone2(device.zoneTwoActive === true);
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

  hasZone2() {
    return this.hasCapability('melpump_zone_active.zone2');
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
   * @param {string} key locale key taking __name__
   */
  async notify(key) {
    await this.homey.notifications
      .createNotification({ excerpt: this.homey.__(key, { name: this.getName() }) })
      .catch(this.error);
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

  async updateZone2(active) {
    // Also adds zone 2 capabilities introduced by app updates to devices that already have zone 2.
    const noThermostat = this.features.thermostatZone2 === false ? FEATURE_CAPABILITIES.thermostatZone2 : [];
    for (const [capability, options] of Object.entries(ZONE2_CAPABILITIES)) {
      const wanted = active && !noThermostat.includes(capability);
      if (wanted && !this.hasCapability(capability)) {
        await this.addCapability(capability);
        await this.setCapabilityOptions(capability, options);
      } else if (!wanted && this.hasCapability(capability)) {
        await this.removeCapability(capability);
      }
    }
    this.registerListeners();
  }

  /**
   * What the heat pump has, from Device. Removes values and choices it can't use.
   * @param {object} device Device
   */
  async updateFeatures(device) {
    const features = {
      canCool: device.canCool !== false,
      thermostatZone1: device.hasThermostatZone1 !== false,
      thermostatZone2: device.hasThermostatZone2 !== false,
    };
    if (Object.keys(features).every((key) => features[key] === this.features[key])) return;
    this.features = features;
    await this.setStoreValue('features', features).catch(this.error);
    await this.syncCapabilities(this.getSettings());
  }

  /**
   * "HH:mm" for today, otherwise "YYYY-MM-DD HH:mm", in the heat pump's time zone.
   * @param {number} time
   */
  formatMoment(time) {
    const text = dateTimeInZone(new Date(time), this.deviceTimezone);
    return text.startsWith(dateInZone(new Date(), this.deviceTimezone)) ? text.slice(11) : text;
  }

  async pollAlarms() {
    // The alarm history only covers today (device local time).
    const alarms = await this.api.getAlarmHistory(this.deviceId);
    const lastAlarmId = this.getStoreValue('lastAlarmId');
    const maxId = alarms.reduce((max, alarm) => Math.max(max, toNumber(alarm.id) || 0), 0);

    // Today's count, and the newest alarm (kept after midnight until a new one comes in).
    // Also kept on the device for the widget, since the capabilities can be hidden.
    this.unacknowledgedAlarms = alarms.filter((alarm) => alarm.acknowledged === false).length;
    await this.updateCapabilities({
      melpump_alarms_today: alarms.length,
      melpump_alarms_unacknowledged: this.unacknowledgedAlarms,
    });
    const newest = alarms.find((alarm) => (toNumber(alarm.id) || 0) === maxId);
    if (newest) {
      this.lastAlarmText = this.describeAlarm(newest);
      await this.updateCapabilities({ melpump_last_alarm: this.lastAlarmText });
    }

    // First check after pairing: remember what's there without firing for old alarms.
    if (typeof lastAlarmId !== 'number') {
      await this.setStoreValue('lastAlarmId', maxId);
      return;
    }

    const newAlarms = alarms
      .filter((alarm) => (toNumber(alarm.id) || 0) > lastAlarmId)
      .sort((a, b) => a.id - b.id);

    for (const alarm of newAlarms) {
      const message = alarm.message || alarm.typeLabel || String(alarm.type);
      await this.driver.alarmTriggeredTrigger
        .trigger(this, {
          id: toNumber(alarm.id) || 0,
          type: String(alarm.type || ''),
          label: alarm.typeLabel || String(alarm.type || ''),
          message,
          value: toNumber(alarm.actualValue) ?? 0,
        })
        .catch(this.error);
      await this.driver.alarmTypeTriggeredTrigger
        .trigger(this, {
          id: toNumber(alarm.id) || 0,
          message,
          value: toNumber(alarm.actualValue) ?? 0,
        }, { type: String(alarm.type || '') })
        .catch(this.error);

      if (this.getSetting('alarm_notifications') !== false) {
        await this.homey.notifications
          .createNotification({
            excerpt: this.homey.__('device.alarm_notification', { name: this.getName(), message }),
          })
          .catch(this.error);
      }
    }

    if (maxId > lastAlarmId) await this.setStoreValue('lastAlarmId', maxId);
  }

  /**
   * "HH:mm Name: message" for the "Last MelPump alarm" value.
   * @param {object} alarm AlarmHistoryDTO
   */
  describeAlarm(alarm) {
    const label = alarm.typeLabel || String(alarm.type || '');
    const text = alarm.message && alarm.message !== label ? `${label}: ${alarm.message}` : label;
    const date = new Date(alarm.triggeredAt || NaN);
    const time = Number.isNaN(date.getTime()) ? '' : `${dateTimeInZone(date, this.deviceTimezone).slice(11)} `;
    return `${time}${text}`.slice(0, 120);
  }

  /**
   * Adds the estimated consumption since the previous sample (trapezoid rule) to
   * today's estimate, so meter_power moves during the day. After a gap in the
   * readings the estimate is recalculated from MelPump's state history, and it is
   * replaced by the real figure once that day has been reported.
   * @param {number|null} watt
   * @param {number|null} heatWatt estimated heat output
   */
  async integratePower(watt, heatWatt) {
    const now = Date.now();
    const previous = this.lastPowerSample;
    this.lastPowerSample = watt === null ? null : {
      time: now,
      watt,
      heatWatt,
      modes: Object.keys(MODE_STATS).filter((mode) => this.getCapabilityValue(MODE_STATS[mode].capability) === true),
    };
    if (watt === null) return;

    const elapsed = previous ? now - previous.time : 0;
    if (!previous || elapsed > MAX_INTEGRATION_GAP_MS) {
      // A gap in the live readings (app start, no data, failed polls): today's
      // estimate misses part of the day until it is recalculated from history.
      this.historyNeeded = true;
      return;
    }
    if (elapsed <= 0) return;

    const day = dateInZone(new Date(now), this.deviceTimezone);
    const hours = elapsed / 3600000;
    const kWh = (((previous.watt + watt) / 2) * hours) / 1000;
    const heat = previous.heatWatt !== null && heatWatt !== null
      ? (((previous.heatWatt + heatWatt) / 2) * hours) / 1000
      : 0;
    this.energyEstimates[day] = (this.energyEstimates[day] || 0) + kWh;
    this.heatEstimates = { [day]: (this.heatEstimates[day] || 0) + heat };

    // Modes as they were at the start of the interval.
    const stats = this.modeStats[day] || { kWh: 0, heat: 0 };
    stats.kWh += kWh;
    stats.heat += heat;
    for (const mode of Object.keys(MODE_STATS)) {
      const modeStats = stats[mode] || { hours: 0, kWh: 0, heat: 0 };
      if (previous.modes.includes(mode)) {
        modeStats.hours += hours;
        modeStats.kWh += kWh;
        modeStats.heat += heat;
      }
      stats[mode] = modeStats;
    }
    // Normal = neither saving nor solar mode (they can run at the same time).
    const normal = stats.normal || { kWh: 0, heat: 0 };
    if (previous.modes.length === 0) {
      normal.kWh += kWh;
      normal.heat += heat;
    }
    stats.normal = normal;
    this.modeStats[day] = stats;

    await this.updateMeter();
    await this.updateModeStats(day);
  }

  /**
   * @param {number|null} kW estimated input power
   */
  recordPower(kW) {
    const now = Date.now();
    if (kW !== null) {
      this.powerHistory.push([now, kW]);
      // The last 24 hours as 5-minute averages: [bucket start, average kW, samples].
      const bucket = Math.floor(now / WIDGET_DAY_BUCKET_MS) * WIDGET_DAY_BUCKET_MS;
      const last = this.powerDay[this.powerDay.length - 1];
      if (last && last[0] === bucket) {
        last[2] += 1;
        last[1] += (kW - last[1]) / last[2];
      } else {
        this.powerDay.push([bucket, kW, 1]);
      }
    }
    this.powerHistory = this.powerHistory.filter(([time]) => time > now - REQUEST_WINDOW_MS);
    this.powerDay = this.powerDay.filter(([time]) => time > now - WIDGET_DAY_MS);
  }

  /**
   * Everything the dashboard widget shows for this heat pump.
   */
  getWidgetStatus() {
    const value = (capability) => (this.hasCapability(capability) ? this.getCapabilityValue(capability) : null);
    const operation = value('melpump_operation_state');
    const today = dateInZone(new Date(), this.deviceTimezone);
    const energy = this.energyEstimates[today];
    const heat = this.heatEstimates[today];
    const run = this.runStats[today];

    return {
      deviceId: this.deviceId,
      name: this.getName(),
      available: this.getAvailable(),
      unavailableMessage: this.unavailableMessage || null,
      // Same order as the device warning: offline, subscription, missing data.
      warning: this.offlineReason || this.subscriptionWarning || this.dataWarning || null,
      operation: operation ? this.enumTitle('melpump_operation_state', operation) : null,
      // Raw state id, so the widget can pick a color; the title is in `operation`.
      operationState: operation,
      cop: value('measure_cop'),
      copYesterday: value('melpump_cop_yesterday'),
      power: value('measure_power'),
      heatOutput: value('melpump_heat_output'),
      outdoor: value('measure_temperature.outdoor'),
      room: value('measure_temperature'),
      tank: value('melpump_tank_temperature'),
      tankTarget: value('target_temperature.tank'),
      flow: value('measure_temperature.flow'),
      powerHistory: this.powerHistory,
      powerDay: this.powerDay.map(([time, kW]) => [time, round(kW, 3)]),
      modes: Object.entries(WIDGET_MODES)
        .filter(([capability]) => value(capability) === true)
        .map(([, id]) => id),
      // Live estimates, recalculated from MelPump's history after a restart or gap.
      today: {
        energy: energy !== undefined ? round(energy, 1) : null,
        heat: heat !== undefined ? round(heat, 1) : null,
        cop: energy >= MIN_KWH_FOR_COP && heat !== undefined ? ratio(heat, energy) : null,
        starts: run ? run.starts : null,
      },
      alarms: {
        unacknowledged: this.unacknowledgedAlarms ?? null,
        last: this.lastAlarmText || null,
      },
      updatedAt: this.lastStateAt || null,
      // Homey's clock, so the widget can show the data age right on a phone whose clock differs.
      serverTime: Date.now(),
      canWrite: this.getStoreValue('writeAccess') !== false,
      savingOn: this.deviceSettings ? toBoolean(this.deviceSettings.smartEnergyActive) : null,
    };
  }

  /**
   * A quick button in the dashboard widget. Only the actions in WIDGET_ACTIONS.
   * @param {string} action
   */
  async runWidgetAction(action) {
    const run = Object.prototype.hasOwnProperty.call(WIDGET_ACTIONS, action) ? WIDGET_ACTIONS[action] : null;
    if (!run) throw new Error(`Unknown widget action: ${action}`);
    this.debug(`Widget action ${action}`);
    await run(this);
  }

  /**
   * Compressor starts / running hours, defrosts / defrost minutes and minutes with
   * the immersion / booster heater on, per day, measured from the live readings
   * (one per minute).
   * @param {number|null} frequency compressor frequency; > 0 = running
   * @param {boolean|null} defrost
   * @param {object} [heaters] HEATERS key -> on/off/null
   */
  async trackRuns(frequency, defrost, heaters = {}) {
    const now = Date.now();
    const day = dateInZone(new Date(now), this.deviceTimezone);
    const yesterday = shiftDate(day, -1);
    const stats = {
      starts: 0, hours: 0, defrosts: 0, defrostMinutes: 0, immersionMinutes: 0, boosterMinutes: 0,
      ...this.runStats[day],
    };

    const previous = this.lastRunSample;
    const running = frequency === null ? null : frequency > 0;
    this.lastRunSample = running === null ? null : {
      time: now, running, defrost: defrost === true, immersion: heaters.immersion === true, booster: heaters.booster === true,
    };

    if (previous && running !== null) {
      const elapsed = now - previous.time;
      if (elapsed > 0 && elapsed <= MAX_INTEGRATION_GAP_MS) {
        if (previous.running) stats.hours += elapsed / 3600000;
        if (previous.defrost) stats.defrostMinutes += elapsed / 60000;
        if (previous.immersion) stats.immersionMinutes += elapsed / 60000;
        if (previous.booster) stats.boosterMinutes += elapsed / 60000;
      }
      if (!previous.defrost && defrost === true) stats.defrosts += 1;

      if (!previous.running && running) {
        stats.starts += 1;
        this.runStartedAt = now;
        await this.driver.compressorStartedTrigger
          .trigger(this, { starts_today: stats.starts })
          .catch(this.error);

        // Short cycling: the run listener fires once when a Flow's limit is reached.
        this.startTimes = this.startTimes.filter((time) => time > now - REQUEST_WINDOW_MS).concat(now);
        await this.driver.shortCyclingTrigger
          .trigger(this, {
            starts: this.startTimes.length,
            avg_minutes: averageRunMinutes(stats) ?? 0,
          }, { starts: this.startTimes.length })
          .catch(this.error);
      } else if (previous.running && !running) {
        // Unknown when the run started if it was already running when the app started.
        const minutes = this.runStartedAt ? Math.round((now - this.runStartedAt) / 60000) : 0;
        this.runStartedAt = null;
        await this.driver.compressorStoppedTrigger
          .trigger(this, { run_minutes: minutes })
          .catch(this.error);
      }
    }
    this.runStats[day] = stats;

    for (const key of Object.keys(this.runStats)) {
      if (key !== day && key !== yesterday) delete this.runStats[key];
    }
    await this.updateRunCapabilities(day);
  }

  /**
   * @param {string} day today, YYYY-MM-DD in the device's time zone
   */
  async updateRunCapabilities(day) {
    const stats = this.runStats[day];
    const past = this.runStats[shiftDate(day, -1)];
    const minutes = (key) => (stats && typeof stats[key] === 'number' ? Math.round(stats[key]) : null);
    await this.updateCapabilities({
      melpump_compressor_starts_today: stats ? stats.starts : null,
      melpump_compressor_hours_today: stats ? round(stats.hours, 1) : null,
      melpump_avg_run_minutes_today: stats ? averageRunMinutes(stats) : null,
      melpump_defrosts_today: stats ? stats.defrosts : null,
      melpump_defrost_minutes_today: minutes('defrostMinutes'),
      melpump_immersion_minutes_today: minutes('immersionMinutes'),
      melpump_booster_minutes_today: minutes('boosterMinutes'),
      // Yesterday is only known if the app was running then.
      melpump_compressor_starts_yesterday: past ? past.starts : null,
      melpump_compressor_hours_yesterday: past ? round(past.hours, 1) : null,
    });
  }

  /**
   * "Heater on for a long time": fires every reading while a heater is on, with how
   * long it has been on now and at the previous reading, so each Flow's run listener
   * fires once when its own number of minutes is reached.
   * @param {object} heaters HEATERS key -> on/off/null
   */
  async trackHeaters(heaters) {
    const now = Date.now();
    for (const [heater, on] of Object.entries(heaters)) {
      if (on !== true) {
        // Unknown (null) keeps the time, so a missing reading doesn't restart the count.
        if (on === false) delete this.heaterOnSince[heater];
        continue;
      }
      const since = this.heaterOnSince[heater];
      if (since === undefined) {
        this.heaterOnSince[heater] = { time: now, minutes: 0 };
        continue;
      }
      const minutes = Math.floor((now - since.time) / 60000);
      const previous = since.minutes;
      since.minutes = minutes;
      if (minutes === previous) continue;
      const state = { heater, minutes, previous };
      if (!await this.anyFlowMatches('heaterOnLongTrigger', (args) => this.heaterLimitReached(args, state))) continue;
      await this.driver.heaterOnLongTrigger
        .trigger(this, { minutes }, state)
        .catch(this.error);
    }
  }

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
    const span = Math.min(minutes, ROOM_HISTORY_MS / 60000) * 60000;
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
   * Saving / solar mode statistics for today and yesterday, measured by the app from
   * the live readings (MelPump's history doesn't say when these modes were running).
   * @param {string} today YYYY-MM-DD in the device's time zone
   */
  async updateModeStats(today) {
    const yesterday = shiftDate(today, -1);
    for (const day of Object.keys(this.modeStats)) {
      if (day !== today && day !== yesterday) delete this.modeStats[day];
    }

    const current = this.modeStats[today];
    const past = this.modeStats[yesterday];
    const todayValues = {};
    // null (shown as "-") when a mode barely ran yesterday, so set even when null.
    const yesterdayValues = {};

    for (const [mode, caps] of Object.entries(MODE_STATS)) {
      todayValues[`${caps.time}_today`] = round(current[mode].hours, 1);
      todayValues[`${caps.energy}_today`] = round(current[mode].kWh, 2);

      // Yesterday is only known if the app was running then; otherwise keep the old values.
      if (!past || !past[mode]) continue;
      const m = past[mode];
      yesterdayValues[`${caps.time}_yesterday`] = round(m.hours, 1);
      yesterdayValues[`${caps.energy}_yesterday`] = round(m.kWh, 2);
      yesterdayValues[caps.share] = past.kWh > 0 ? Math.round((m.kWh / past.kWh) * 100) : null;
      yesterdayValues[caps.cop] = m.kWh >= MIN_KWH_FOR_COP ? ratio(m.heat, m.kWh) : null;
    }

    if (past && past.normal) {
      yesterdayValues.melpump_cop_normal_yesterday = past.normal.kWh >= MIN_KWH_FOR_COP
        ? ratio(past.normal.heat, past.normal.kWh)
        : null;
    }

    await this.updateCapabilities(todayValues);
    for (const [capability, value] of Object.entries(yesterdayValues)) {
      if (!this.hasCapability(capability) || this.getCapabilityValue(capability) === value) continue;
      await this.setCapabilityValue(capability, value).catch(this.error);
    }
  }

  /**
   * meter_power = reported totals of all counted days (energyBase)
   *             + estimates for the days MelPump hasn't reported yet.
   * Homey Energy expects a cumulative meter, so it never goes down; if an
   * estimate was too high, the meter pauses until the real totals catch up.
   */
  async updateMeter() {
    const base = this.getStoreValue('energyBase') || 0;
    const estimated = Object.values(this.energyEstimates).reduce((total, kWh) => total + kWh, 0);
    const current = this.getCapabilityValue('meter_power') || 0;
    const value = round(Math.max(current, base + estimated), 3);
    if (value !== current) await this.setCapabilityValue('meter_power', value).catch(this.error);
  }

  /**
   * Recalculates today from MelPump's 5-minute state history: consumption and heat
   * produced, compressor and defrost statistics, and the widget's 24-hour graph.
   * Unlike the live readings this survives app restarts and has no gaps. Fetched
   * only after a gap in the live readings (see pollEnergy), so it costs nothing extra.
   * @param {string} today YYYY-MM-DD in the device's time zone
   * @returns {Promise<boolean>} whether today was recalculated
   */
  async estimateDayFromHistory(today) {
    const samples = (await this.api.getDayStates(this.deviceId, today))
      .map((s) => ({
        time: Date.parse(s.dateCreated),
        watt: toWatt(s.EstInputPower),
        heatWatt: toWatt(s.EstOutputPower),
        frequency: toNumber(s.HeatPumpFrequency),
        defrost: toBoolean(s.DefrostMode),
        immersion: HEATERS.immersion(s),
        booster: HEATERS.booster(s),
      }))
      .filter((s) => Number.isFinite(s.time) && s.watt !== null
        && dateInZone(new Date(s.time), this.deviceTimezone) === today)
      .sort((a, b) => a.time - b.time);
    if (samples.length < 2) return false;

    let kWh = 0;
    let heat = 0;
    const runs = {
      starts: 0, hours: 0, defrosts: 0, defrostMinutes: 0, immersionMinutes: 0, boosterMinutes: 0,
    };
    for (let i = 1; i < samples.length; i += 1) {
      const previous = samples[i - 1];
      const sample = samples[i];
      const elapsed = sample.time - previous.time;
      if (elapsed <= 0 || elapsed > MAX_HISTORY_GAP_MS) continue;
      const hours = elapsed / 3600000;
      kWh += (((previous.watt + sample.watt) / 2) * hours) / 1000;
      if (previous.heatWatt !== null && sample.heatWatt !== null) {
        heat += (((previous.heatWatt + sample.heatWatt) / 2) * hours) / 1000;
      }
      if (previous.frequency !== null && sample.frequency !== null) {
        if (previous.frequency > 0) runs.hours += hours;
        if (previous.frequency === 0 && sample.frequency > 0) runs.starts += 1;
      }
      if (previous.defrost === true) runs.defrostMinutes += elapsed / 60000;
      if (previous.defrost === false && sample.defrost === true) runs.defrosts += 1;
      if (previous.immersion === true) runs.immersionMinutes += elapsed / 60000;
      if (previous.booster === true) runs.boosterMinutes += elapsed / 60000;
    }

    // The live estimates continue from here until the next recalculation.
    this.energyEstimates[today] = kWh;
    this.heatEstimates = { [today]: heat };

    // The history has a reading every 5 minutes and misses shorter runs and defrosts,
    // which the live readings (every minute) catch. Each figure takes the larger of
    // the two: the history covers the gap, the live readings the rest.
    const live = this.runStats[today] || {};
    this.runStats[today] = Object.fromEntries(Object.entries(runs)
      .map(([key, value]) => [key, Math.max(value, live[key] || 0)]));
    await this.updateRunCapabilities(today);

    this.fillPowerDay(samples);
    return true;
  }

  /**
   * Fills the widget's 24-hour graph with today's history, e.g. after an app restart.
   * Buckets with live readings since the last history reading are kept.
   * @param {Array<{ time: number, watt: number }>} samples sorted by time
   */
  fillPowerDay(samples) {
    const buckets = new Map();
    for (const { time, watt } of samples) {
      const bucket = Math.floor(time / WIDGET_DAY_BUCKET_MS) * WIDGET_DAY_BUCKET_MS;
      const entry = buckets.get(bucket) || [bucket, 0, 0];
      entry[2] += 1;
      entry[1] += (watt / 1000 - entry[1]) / entry[2];
      buckets.set(bucket, entry);
    }
    const lastHistory = Math.max(...buckets.keys());
    for (const entry of this.powerDay) {
      if (entry[0] >= lastHistory || !buckets.has(entry[0])) buckets.set(entry[0], entry);
    }
    this.powerDay = [...buckets.values()]
      .filter(([time]) => time > Date.now() - WIDGET_DAY_MS)
      .sort((a, b) => a[0] - b[0]);
  }

  /**
   * MelPump publishes energy per completed day (today is never included). Each
   * day is fetched separately because the response items carry no date.
   */
  async pollEnergy() {
    const today = dateInZone(new Date(), this.deviceTimezone);
    const yesterday = shiftDate(today, -1);
    let base = this.getStoreValue('energyBase') || 0;
    let countedThrough = this.getStoreValue('energyCountedThrough');
    // First run: count from today; earlier consumption isn't added to the meter.
    if (!countedThrough) countedThrough = yesterday;

    let yesterdayItems = null;
    let requests = 0;
    while (countedThrough < yesterday && requests < MAX_ENERGY_DAYS_PER_POLL) {
      const day = shiftDate(countedThrough, 1);
      const items = await this.api.getDailyEnergy(this.deviceId, day, day);
      requests += 1;

      // Yesterday may not be published yet, or only as an estimate; try again next
      // hour (the live estimate covers it meanwhile). Older days are taken as they
      // are, and days without data (e.g. the heat pump was offline) are skipped.
      if (day === yesterday && (items.length === 0 || isEstimated(items))) break;

      base += sum(items, 'Total');
      countedThrough = day;
      delete this.energyEstimates[day];
      if (day === yesterday) yesterdayItems = items;
    }

    // The day's full state history is a large response, so it is only fetched when
    // the live estimate has a gap; otherwise that estimate is already complete.
    if (this.historyNeeded !== false && await this.estimateDayFromHistory(today)) {
      this.historyNeeded = false;
      this.debug(`Today recalculated from MelPump's history: ${round(this.energyEstimates[today], 3)} kWh`);
    }
    if (this.homey.app.debugMode) {
      this.debug(`Energy: counted through ${countedThrough}, base ${round(base, 3)} kWh, estimates ${JSON.stringify(this.energyEstimates)}`);
    }

    for (const day of Object.keys(this.energyEstimates)) {
      if (day <= countedThrough) delete this.energyEstimates[day];
    }

    await this.setStoreValue('energyBase', base);
    await this.setStoreValue('energyCountedThrough', countedThrough);
    await this.persistStats();
    await this.updateMeter();

    await this.updateYesterdayStats(yesterday, yesterdayItems);
    await this.updateScop(yesterday);
    await this.updatePeriodStats(today);
  }

  /**
   * Energy, heat produced and COP for this month, last month and this year
   * (completed days). Completed months are fetched once (per day, with the daily
   * endpoint) and cached; this month is refreshed once a day.
   * @param {string} today YYYY-MM-DD in the device's time zone
   */
  async updatePeriodStats(today) {
    if (!this.hasCapability('melpump_energy_this_month')) return;
    const yesterday = shiftDate(today, -1);
    if (this.getStoreValue('periodStatsDay') === yesterday && !this.forcePeriodStats) return;

    const month = today.slice(0, 7);
    const year = today.slice(0, 4);
    const lastMonth = shiftMonth(month, -1);
    const cache = this.getStoreValue('monthStats') || {};

    // Completed months needed: last month, and every earlier month of this year.
    const needed = [lastMonth];
    for (let m = `${year}-01`; m < month; m = shiftMonth(m, 1)) {
      if (!needed.includes(m)) needed.push(m);
    }
    let fetches = 0;
    for (const m of needed) {
      if (cache[m] || fetches >= MAX_MONTH_FETCHES_PER_POLL) continue;
      const items = await this.api.getDailyEnergy(this.deviceId, `${m}-01`, shiftDate(`${shiftMonth(m, 1)}-01`, -1));
      fetches += 1;
      cache[m] = { kWh: sum(items, 'Total'), heat: sum(items, 'ProducedTotal') };
    }

    // This month so far (nothing on the 1st: no completed day yet).
    let current = { kWh: 0, heat: 0 };
    if (yesterday.startsWith(month)) {
      const items = await this.api.getDailyEnergy(this.deviceId, `${month}-01`, yesterday);
      current = { kWh: sum(items, 'Total'), heat: sum(items, 'ProducedTotal') };
    }

    for (const m of Object.keys(cache)) {
      if (!needed.includes(m)) delete cache[m];
    }
    await this.setStoreValue('monthStats', cache).catch(this.error);

    const values = {
      melpump_energy_this_month: round(current.kWh, 1),
      melpump_heat_this_month: round(current.heat, 1),
      melpump_cop_this_month: ratio(current.heat, current.kWh),
    };
    if (cache[lastMonth]) {
      Object.assign(values, {
        melpump_energy_last_month: round(cache[lastMonth].kWh, 1),
        melpump_heat_last_month: round(cache[lastMonth].heat, 1),
        melpump_cop_last_month: ratio(cache[lastMonth].heat, cache[lastMonth].kWh),
      });
    }
    // The year total waits until every earlier month of the year is cached.
    const yearMonths = needed.filter((m) => m.startsWith(year));
    const complete = yearMonths.every((m) => cache[m]);
    if (complete) {
      const total = yearMonths.reduce((acc, m) => ({ kWh: acc.kWh + cache[m].kWh, heat: acc.heat + cache[m].heat }), current);
      Object.assign(values, {
        melpump_energy_this_year: round(total.kWh, 0),
        melpump_heat_this_year: round(total.heat, 0),
        melpump_cop_this_year: ratio(total.heat, total.kWh),
      });
    }
    await this.updateCapabilities(values);

    if (complete && cache[lastMonth]) {
      this.forcePeriodStats = false;
      await this.setStoreValue('periodStatsDay', yesterday).catch(this.error);
    }
  }

  /**
   * Yesterday's figures, fetched once per day (also right after pairing, after an
   * app update that adds values, and when they're missing from the device).
   * @param {string} yesterday
   * @param {Array<object>|null} items already fetched data for yesterday, if any
   */
  async updateYesterdayStats(yesterday, items) {
    const statsKey = `${yesterday}:v${ENERGY_STATS_VERSION}`;
    const statsMissing = this.hasCapability('melpump_heat_produced_yesterday')
      && this.getCapabilityValue('melpump_heat_produced_yesterday') === null;
    if (this.getStoreValue('energyStatsDay') === statsKey && !statsMissing && !this.forceYesterdayStats) return;
    this.forceYesterdayStats = false;

    const data = items || await this.api.getDailyEnergy(this.deviceId, yesterday, yesterday);
    if (!data.length) return;

    const outdoor = toNumber(data[0].OutdoorTemperature);
    await this.updateCapabilities({
      melpump_energy_cooling_yesterday: round(sum(data, 'Cooling'), 2),
      melpump_heat_cooling_yesterday: round(sum(data, 'ProducedCooling'), 2),
      melpump_cop_cooling_yesterday: ratio(sum(data, 'ProducedCooling'), sum(data, 'Cooling')),
      melpump_heat_produced_yesterday: round(sum(data, 'ProducedTotal'), 2),
      melpump_cop_yesterday: ratio(sum(data, 'ProducedTotal'), sum(data, 'Total')),
      melpump_cop_heating_yesterday: ratio(sum(data, 'ProducedHeating'), sum(data, 'Heating')),
      melpump_cop_hot_water_yesterday: ratio(sum(data, 'ProducedHotWater'), sum(data, 'HotWater')),
      melpump_energy_heating_yesterday: round(sum(data, 'Heating'), 2),
      melpump_energy_hot_water_yesterday: round(sum(data, 'HotWater'), 2),
      melpump_heat_heating_yesterday: round(sum(data, 'ProducedHeating'), 2),
      melpump_heat_hot_water_yesterday: round(sum(data, 'ProducedHotWater'), 2),
      melpump_outdoor_avg_yesterday: outdoor === null ? null : round(outdoor, 1),
    });
    // An estimate is shown, but fetched again every hour until MelPump has the final figures.
    if (!isEstimated(data)) await this.setStoreValue('energyStatsDay', statsKey);
  }

  /**
   * Seasonal COP over the last SCOP_DAYS completed days, once per day.
   * @param {string} yesterday
   */
  async updateScop(yesterday) {
    const scopMissing = this.hasCapability('melpump_scop_30d')
      && this.getCapabilityValue('melpump_scop_30d') === null;
    if (this.getStoreValue('scopDay') === yesterday && !scopMissing) return;

    const days = await this.api.getDailyEnergy(this.deviceId, shiftDate(yesterday, -(SCOP_DAYS - 1)), yesterday);
    if (!days.length) return;

    await this.updateCapabilities({
      melpump_scop_30d: ratio(sum(days, 'ProducedTotal'), sum(days, 'Total')),
    });
    await this.setStoreValue('scopDay', yesterday);
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
      throw new Error(this.homey.__('device.update_failed', { message: err.message }));
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

  // ---- Flow actions ----

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
    await this.updateCapabilities({
      melpump_holiday_until: until ? this.formatMoment(until) : this.homey.__('device.holiday_no_end'),
    });
  }

  /**
   * Runs every poll: switches off a hot water boost whose time is up or whose hot water
   * is ready, and holiday mode at its end time. If MelPump doesn't accept it, the next
   * poll tries again.
   */
  async endTimedFunctions() {
    const now = Date.now();
    if (this.boostUntil && (now >= this.boostUntil || this.isHotWaterReady())) {
      this.log(now >= this.boostUntil ? 'Hot water boost time is up' : 'Hot water boost: hot water is ready');
      await this.setFunction('force_hot_water', false).catch((err) => this.error('Could not end hot water boost:', err.message));
    }
    if (this.holidayUntil && now >= this.holidayUntil) {
      this.log('Holiday mode end time reached');
      await this.setFunction('holiday', false).catch((err) => this.error('Could not end holiday mode:', err.message));
    }
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
    const now = dateTimeInZone(new Date(), this.deviceTimezone);
    const current = Number(now.slice(11, 13)) * 60 + Number(now.slice(14, 16));
    // A time that has passed today (or is now) means tomorrow.
    const minutes = (target - current + 1440) % 1440 || 1440;
    await this.forceSolarMode(minutes);
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

  async acknowledgeAlarms() {
    await this.write(() => this.api.acknowledgeAllAlarms(this.deviceId));
    this.unacknowledgedAlarms = 0;
    await this.updateCapabilities({ melpump_alarms_unacknowledged: 0 });
  }

  /**
   * @param {number} id alarm id, e.g. the "Alarm id" token of the "New MelPump alarm" trigger
   */
  async acknowledgeAlarm(id) {
    await this.write(() => this.api.acknowledgeAlarm(this.deviceId, Math.round(id)));
    // The exact count is confirmed by the next alarm check.
    if (this.unacknowledgedAlarms > 0) this.unacknowledgedAlarms -= 1;
    const open = this.getCapabilityValue('melpump_alarms_unacknowledged');
    if (open > 0) await this.updateCapabilities({ melpump_alarms_unacknowledged: open - 1 });
  }

  /**
   * Used by the "There are unacknowledged alarms" Flow condition.
   */
  hasUnacknowledgedAlarms() {
    return (this.getCapabilityValue('melpump_alarms_unacknowledged') || 0) > 0;
  }

  /**
   * Saves the statistics that are otherwise only stored every PERSIST_ESTIMATE_EVERY
   * polls, so an app restart or update loses nothing.
   */
  async persistStats() {
    // Only what changed since the last save (e.g. little changes at night).
    this.persisted = this.persisted || {};
    const stats = {
      energyEstimates: this.energyEstimates,
      heatEstimates: this.heatEstimates,
      modeStats: this.modeStats,
      runStats: this.runStats,
    };
    for (const [key, value] of Object.entries(stats)) {
      const json = JSON.stringify(value);
      if (this.persisted[key] === json) continue;
      await this.setStoreValue(key, value).catch(this.error);
      this.persisted[key] = json;
    }
  }

  async onUninit() {
    this.stopPolling();
    await this.persistStats();
  }

  async onDeleted() {
    // The store is deleted with the device; only the shared API client is left to clean up.
    this.stopPolling();
    this.homey.app.removeClient(this.getStoreValue('apiKey'), this);
    this.log(`HeatPump device "${this.getName()}" has been deleted`);
  }

}

module.exports = HeatPumpDevice;
