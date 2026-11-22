'use strict';

const { REQUEST_BUDGET, ALARM_HISTORY_DAYS } = require('./constants');
const { dateTimeInZone } = require('./helpers');

/**
 * Diagnostics: the state of a heat pump for the app settings page and the text users can
 * copy into a bug report. Never includes the API token.
 * Part of HeatPumpDevice (drivers/heatpump/device.js), which adds these methods to itself.
 */
class HeatPumpDiagnostics {

  /**
   * How the token works for this heat pump, from the last answers of melpump.com.
   * @returns {'missing'|'rejected'|'subscription'|'no_access'|'read_only'|'ok'}
   */
  tokenStatus() {
    const status = this.failedPolls > 0 && this.lastError ? this.lastError.status : null;
    if (!this.getStoreValue('apiKey')) return 'missing';
    if (status === 401) return 'rejected';
    if (this.subscriptionWarning) return 'subscription';
    if (status === 403) return 'no_access';
    if (this.getStoreValue('writeAccess') === false) return 'read_only';
    return 'ok';
  }

  /**
   * @returns {object} plain data, times as "YYYY-MM-DD HH:mm" in the heat pump's time zone
   */
  getDiagnostics() {
    const time = (value) => (value ? dateTimeInZone(new Date(value), this.deviceTimezone) : null);
    const model = this.getSetting('info_model');
    return {
      deviceId: this.deviceId,
      name: this.getName(),
      model: model && model !== '-' ? model : null,
      available: this.getAvailable(),
      unavailableMessage: this.getAvailable() ? null : this.unavailableMessage,
      // Same order as the device warning: offline, subscription, missing data.
      warning: this.offlineReason || this.subscriptionWarning || this.dataWarning || null,
      token: this.tokenStatus(),
      timezone: this.deviceTimezone,
      lastSeen: time(this.lastSeenAt),
      lastUpdate: time(this.lastSuccess),
      lastError: this.lastError ? { time: time(this.lastError.time), message: this.lastError.message } : null,
      failedPolls: this.failedPolls,
      requestsLastHour: this.requestsLastHour(),
      requestBudget: REQUEST_BUDGET,
      pausedUntil: this.pausedUntil > Date.now() ? time(this.pausedUntil) : null,
      zone2: this.hasZone2(),
      canCool: this.features.canCool !== false,
      boostUntil: time(this.boostUntil),
      holidayUntil: time(this.holidayUntil),
      forcedSolarUntil: time(this.forcedSolarUntil),
      // The app's own alarm history (see rememberAlarms), newest first.
      alarms: {
        days: ALARM_HISTORY_DAYS,
        count: this.alarmHistory.length,
        last7Days: this.alarmHistory.filter((entry) => entry.at >= Date.now() - 7 * 24 * 3600000).length,
        recent: this.alarmHistory.slice(-10).reverse().map((entry) => ({
          time: time(entry.at),
          label: entry.label,
          message: entry.message && entry.message !== entry.label ? entry.message : null,
          acknowledged: entry.acknowledged,
        })),
      },
    };
  }

}

module.exports = HeatPumpDiagnostics;
