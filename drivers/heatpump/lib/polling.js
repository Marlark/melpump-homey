'use strict';

const {
  POLL_BACKOFF_MS, REFRESH_AFTER_WRITE_MS, REPEATED_ERROR_LOG_EVERY, DEVICE_POLL_EVERY, ALARM_POLL_EVERY,
  LATE_ALARM_CHECK_MINUTES, ENERGY_POLL_EVERY, ACCESS_POLL_EVERY, STARTUP_SPREAD_MS, RATE_LIMIT_PAUSE_MS,
  REQUEST_WINDOW_MS, REQUEST_BUDGET, MAX_FAILED_POLLS, MAX_ENERGY_DAYS_PER_POLL, PERSIST_ESTIMATE_EVERY,
  MAX_MONTH_FETCHES_PER_POLL,
} = require('./constants');
const { dateTimeInZone } = require('./helpers');

/**
 * Polling melpump.com: the poll loop and its schedule, the request budget, errors,
 * availability and warnings.
 * Part of HeatPumpDevice (drivers/heatpump/device.js), which adds these methods to itself.
 */
class HeatPumpPolling {

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

  /**
   * Doesn't wait for the poll: the first one makes many requests, and pairing and
   * repair would wait for all of them.
   * @param {object} [options]
   * @param {boolean} [options.spread] start within STARTUP_SPREAD_MS instead of now (app start)
   */
  startPolling({ spread = false } = {}) {
    this.homey.clearTimeout(this.pollTimer);
    if (this.stopped) return;
    this.failedPolls = 0;
    this.pollCount = 0;
    this.pausedUntil = 0;

    // The poll running now would replace a timer when it ends, so it runs again instead.
    if (this.polling) {
      this.pollQueued = true;
      return;
    }
    // Each poll schedules the next one when it ends (see scheduleNextPoll).
    this.scheduleNextPoll(spread ? Math.round(Math.random() * STARTUP_SPREAD_MS) : 0);
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
    if (Date.now() < this.pausedUntil) return;
    // While melpump.com can't be reached this waits, without using up its attempts.
    if (this.failedPolls === 0) await this.endTimedFunctions();

    // The first poll fetches everything; after that each part has its own interval.
    const tick = this.pollCount;
    this.pollCount += 1;
    const recovering = this.failedPolls > 0;

    try {
      // Device first: it says whether the heat pump is online, and energy needs its time zone.
      if (this.hasBudget() && this.shouldFetchDevice(tick)) {
        this.refreshDevice = false;
        const device = await this.api.getDevice(this.deviceId);
        if (device) await this.applyDevice(device);
      }
      // Subscription status and write access, every 6 hours (and after a 403, see handlePollError).
      // While the subscription warning is shown, also when MelPump answers again and every
      // ALARM_POLL_EVERY polls, so it goes soon after the subscription is renewed.
      const accessDue = tick % ACCESS_POLL_EVERY === 0
        || (this.subscriptionWarning && (recovering || tick % ALARM_POLL_EVERY === 0));
      if (accessDue && this.hasBudget()) await this.checkAccess();

      // While offline the live state would be stale, so only the device is checked.
      if (!this.offlineReason && this.hasBudget()) {
        const current = await this.api.getDeviceStatus(this.deviceId);
        await this.applyCurrentState(current);
        // The live statistics, saved together every few polls instead of separately.
        if ((tick + 1) % PERSIST_ESTIMATE_EVERY === 0) await this.persistStats();

        const catchUp = this.catchUp;
        this.catchUp = false;
        // Skipped alarm / energy checks run on their next interval.
        const alarmsDue = tick % ALARM_POLL_EVERY === 0 || catchUp || this.isLastMinutesOfDay();
        if (alarmsDue && this.hasBudget()) await this.pollAlarms();
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
    // The HTTP status tells the settings page whether the token is the problem.
    this.lastError = { time: Date.now(), message: err.message, status: err.status ?? null };
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

  /**
   * Whether it is the last LATE_ALARM_CHECK_MINUTES of the day in the heat pump's time zone.
   * @returns {boolean}
   */
  isLastMinutesOfDay() {
    const [hours, minutes] = dateTimeInZone(new Date(), this.deviceTimezone).slice(11).split(':').map(Number);
    return hours * 60 + minutes >= 24 * 60 - LATE_ALARM_CHECK_MINUTES;
  }

}

module.exports = HeatPumpPolling;
