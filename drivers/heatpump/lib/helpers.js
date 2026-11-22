'use strict';

/*
 * Small helpers for numbers, dates in the heat pump's time zone and MelPump's data.
 */

// Changes smaller than this aren't written: the value hardly moves, but every write
// is a call to Homey and an Insights entry. Going to or from 0 is always written.
const DEADBANDS = {
  measure_power: 10,
  melpump_heat_output: 10,
  measure_cop: 0.05,
  melpump_flow_rate: 0.1,
  melpump_delta_t: 0.2,
};

// EstInputPower / EstOutputPower are reported in kW (confirmed: input x COP = output).
const POWER_FACTOR_TO_WATT = 1000;

// Reads a temperature that some adapters report as 0 when the sensor doesn't exist.
const sensor = (field) => (state) => {
  const value = toNumber(state[field]);
  return value === 0 ? null : value;
};

// Flow minus return: how much heat the water gives off in the circuit.
const difference = (flow, back) => (flow === null || back === null ? null : round(flow - back, 1));

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

module.exports = {
  sensor, difference, toNumber, toBoolean, toWatt, round, sum, ratio, withinDeadband, averageRunMinutes,
  clockTime, zonedParts, dateInZone, zonedTime, dateTimeInZone, shiftMonth, isEstimated, shiftDate,
};
