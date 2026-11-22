'use strict';

const { ALARM_HISTORY_DAYS, ALARM_HISTORY_MAX } = require('./constants');
const { toNumber, dateTimeInZone } = require('./helpers');

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Alarms: the daily alarm history, its triggers and notifications, and acknowledging.
 * Part of HeatPumpDevice (drivers/heatpump/device.js), which adds these methods to itself.
 */
class HeatPumpAlarms {

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
    await this.rememberAlarms(alarms);

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
   * Keeps today's alarms in the app's own history, since MelPump's list only covers today:
   * new alarms are added and known ones updated (e.g. acknowledged). Also counts the last 7 days.
   * @param {Array<object>} alarms AlarmHistoryDTO
   */
  async rememberAlarms(alarms) {
    const history = new Map(this.alarmHistory.map((entry) => [entry.id, entry]));
    let changed = false;
    for (const alarm of alarms) {
      const id = toNumber(alarm.id);
      if (!id) continue;
      const known = history.get(id);
      const triggered = Date.parse(alarm.triggeredAt);
      const entry = {
        id,
        type: String(alarm.type || ''),
        label: alarm.typeLabel || String(alarm.type || ''),
        message: alarm.message || '',
        value: toNumber(alarm.actualValue),
        // Without a time from MelPump: when the app first saw it.
        at: Number.isNaN(triggered) ? (known ? known.at : Date.now()) : triggered,
        acknowledged: alarm.acknowledged === true,
      };
      if (!known || JSON.stringify(known) !== JSON.stringify(entry)) {
        history.set(id, entry);
        changed = true;
      }
    }
    await this.saveAlarmHistory([...history.values()], changed);
  }

  /**
   * Keeps ALARM_HISTORY_DAYS and at most ALARM_HISTORY_MAX alarms, oldest first, and
   * updates the 7-day count.
   * @param {Array<object>} entries
   * @param {boolean} changed whether entries differ from what is stored
   */
  async saveAlarmHistory(entries, changed) {
    const since = Date.now() - ALARM_HISTORY_DAYS * DAY_MS;
    const kept = entries
      .filter((entry) => entry.at >= since)
      .sort((a, b) => a.at - b.at || a.id - b.id)
      .slice(-ALARM_HISTORY_MAX);
    if (changed || kept.length !== this.alarmHistory.length) {
      await this.setStoreValue('alarmHistory', kept).catch(this.error);
    }
    this.alarmHistory = kept;
    const weekAgo = Date.now() - 7 * DAY_MS;
    await this.updateCapabilities({ melpump_alarms_7d: kept.filter((entry) => entry.at >= weekAgo).length });
  }

  /**
   * Marks alarms in the app's history as acknowledged.
   * @param {number|null} id one alarm, or null for all
   */
  async markAcknowledged(id) {
    const entries = this.alarmHistory.map((entry) => (
      id === null || entry.id === id ? { ...entry, acknowledged: true } : entry
    ));
    const changed = entries.some((entry, i) => entry.acknowledged !== this.alarmHistory[i].acknowledged);
    await this.saveAlarmHistory(entries, changed);
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

  async acknowledgeAlarms() {
    await this.write(() => this.api.acknowledgeAllAlarms(this.deviceId));
    this.unacknowledgedAlarms = 0;
    await this.updateCapabilities({ melpump_alarms_unacknowledged: 0 });
    await this.markAcknowledged(null);
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
    await this.markAcknowledged(Math.round(id));
  }

  /**
   * Used by the "There are unacknowledged alarms" Flow condition.
   */
  hasUnacknowledgedAlarms() {
    return (this.getCapabilityValue('melpump_alarms_unacknowledged') || 0) > 0;
  }

}

module.exports = HeatPumpAlarms;
