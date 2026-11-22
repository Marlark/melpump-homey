'use strict';

/*
 * Settings, limits and mappings of the heat pump device.
 */

const { sensor, difference, toNumber, toBoolean } = require('./helpers');

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

// The alarm history only covers today, so an alarm late in the day would be gone at the
// next regular check after midnight. In this many minutes before midnight (heat pump
// time) every poll also checks alarms: at most this many extra requests a day.
const LATE_ALARM_CHECK_MINUTES = 3;

const ENERGY_POLL_EVERY = 60;

// Subscription status and write access rarely change: every 6 hours (and on a 403).
const ACCESS_POLL_EVERY = 6 * 60;

// After a Homey restart every heat pump would make its first, largest poll at once;
// each starts within this time instead.
const STARTUP_SPREAD_MS = 20 * 1000;

// How long the argument values of a trigger's Flows are kept (see flowArgs).
const FLOW_ARGS_TTL_MS = 5 * 60 * 1000;

// The app's own alarm history (MelPump's list only covers today): kept this long, and at
// most this many alarms, so a heat pump with many alarms doesn't fill the device store.
const ALARM_HISTORY_DAYS = 90;
const ALARM_HISTORY_MAX = 300;

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

// Polls that try to switch off a hot water boost or holiday mode at its end time
// before the app gives up and tells the user.
const MAX_END_ATTEMPTS = 5;

// The longest wait of "Room temperature deviates" (the card's maximum).
const ROOM_DEVIATION_MAX_MINUTES = 180;

// Room temperature readings kept for it: the longest wait plus two readings, so that
// "had it already lasted that long at the previous reading?" can be answered too.
const ROOM_HISTORY_MS = ROOM_DEVIATION_MAX_MINUTES * 60000 + 2 * MAX_INTEGRATION_GAP_MS;

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

// Bump to fetch the cached months again, e.g. after a fix to how they're counted.
// 2: a month is only cached once its last day has MelPump's final figures.
const MONTH_STATS_VERSION = 2;

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
  show_alarm_info: ['melpump_last_alarm', 'melpump_alarms_today', 'melpump_alarms_unacknowledged', 'melpump_alarms_7d'],
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

// Values that describe this moment. When there is no current reading (heat pump offline,
// or MelPump has no data) they are cleared instead of showing the last one: otherwise
// Homey Energy would go on counting the last power, and "compressor running" stay true.
// The COP is left as it is: it deliberately keeps the last value while the compressor rests.
const LIVE_CAPABILITIES = [
  'measure_power',
  'melpump_heat_output',
  'melpump_compressor_frequency',
  'melpump_flow_rate',
  'melpump_defrost',
  'melpump_immersion_heater',
  'melpump_booster_heater',
];

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

module.exports = {
  POLL_INTERVAL_MS, POLL_BACKOFF_MS, REFRESH_AFTER_WRITE_MS, TEMPERATURE_DEBOUNCE_MS,
  REPEATED_ERROR_LOG_EVERY, DEVICE_POLL_EVERY, ALARM_POLL_EVERY, LATE_ALARM_CHECK_MINUTES, ENERGY_POLL_EVERY,
  ACCESS_POLL_EVERY, STARTUP_SPREAD_MS, FLOW_ARGS_TTL_MS, ALARM_HISTORY_DAYS, ALARM_HISTORY_MAX, RATE_LIMIT_PAUSE_MS, REQUEST_WINDOW_MS,
  REQUEST_BUDGET, MAX_FAILED_POLLS, MAX_ENERGY_DAYS_PER_POLL, MAX_INTEGRATION_GAP_MS, MAX_HISTORY_GAP_MS,
  PERSIST_ESTIMATE_EVERY, SCOP_DAYS, MIN_KWH_FOR_COP, FORCED_SOLAR_LATE_MS, HOT_WATER_READY_MARGIN,
  HOT_WATER_REARM, BOOST_MINUTES, MAX_END_ATTEMPTS, ROOM_DEVIATION_MAX_MINUTES, ROOM_HISTORY_MS, HEATERS,
  MODE_STATS, SOLAR_FUNCTIONS, ENERGY_STATS_VERSION, MAX_MONTH_FETCHES_PER_POLL, MONTH_STATS_VERSION,
  MODE_TO_OPERATION_MODE, VALID_MODES, OPERATION_STATES, FUNCTION_TOGGLES, FUNCTION_SETTINGS,
  FUNCTION_SWITCHES, CAPABILITY_GROUPS, FEATURE_CAPABILITIES, COOLING_CHOICES, WIDGET_DAY_MS,
  WIDGET_DAY_BUCKET_MS, WIDGET_MODES, WIDGET_ACTIONS, HOT_WATER_PRESETS, BLOCK_TOGGLES, ZONE_MODES,
  FLOW_TEMPERATURES, ZONE_MODE_IDS, ZONE_MODE_CAPABILITIES, ZONES, PRESET_FIELDS, LIVE_CAPABILITIES,
  ZONE2_CAPABILITIES, OPTIONAL_CAPABILITIES, INSTALLATION_TYPES, REMOVED_CAPABILITIES,
};
