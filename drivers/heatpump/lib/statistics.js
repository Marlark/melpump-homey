'use strict';

const {
  REQUEST_WINDOW_MS, MAX_ENERGY_DAYS_PER_POLL, MAX_INTEGRATION_GAP_MS, MAX_HISTORY_GAP_MS, SCOP_DAYS,
  MIN_KWH_FOR_COP, HEATERS, MODE_STATS, ENERGY_STATS_VERSION, MAX_MONTH_FETCHES_PER_POLL, MONTH_STATS_VERSION,
  WIDGET_DAY_MS, WIDGET_DAY_BUCKET_MS,
} = require('./constants');
const {
  toNumber, toBoolean, toWatt, round, sum, ratio, averageRunMinutes, dateInZone, shiftMonth, isEstimated,
  shiftDate,
} = require('./helpers');

/**
 * Energy and statistics: the meter, live estimates, daily / monthly / yearly figures,
 * compressor runs, heaters and mode statistics.
 * Part of HeatPumpDevice (drivers/heatpump/device.js), which adds these methods to itself.
 */
class HeatPumpStatistics {

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

        // Short cycling: the run listener fires when a Flow's limit is reached. While the
        // compressor keeps starting at that rate, the hour's count is back at the limit at
        // every start, so the same count fires again only after an hour.
        this.startTimes = this.startTimes.filter((time) => time > now - REQUEST_WINDOW_MS).concat(now);
        const starts = this.startTimes.length;
        for (const [count, time] of Object.entries(this.shortCyclingFiredAt)) {
          if (time <= now - REQUEST_WINDOW_MS) delete this.shortCyclingFiredAt[count];
        }
        if (!this.shortCyclingFiredAt[starts]) {
          this.shortCyclingFiredAt[starts] = now;
          await this.driver.shortCyclingTrigger
            .trigger(this, {
              starts,
              avg_minutes: averageRunMinutes(stats) ?? 0,
            }, { starts })
            .catch(this.error);
        }
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
    // Yesterday is final once updateYesterdayStats has stored MelPump's final figures.
    // Until then the 30-day and month figures are shown but checked again next hour,
    // so a month isn't kept without its last day.
    const yesterdayFinal = this.getStoreValue('energyStatsDay') === `${yesterday}:v${ENERGY_STATS_VERSION}`;
    await this.updateScop(yesterday, yesterdayFinal);
    await this.updatePeriodStats(today, yesterdayFinal);
  }

  /**
   * Energy, heat produced and COP for this month, last month and this year
   * (completed days). Completed months are fetched once (per day, with the daily
   * endpoint) and cached; this month is refreshed once a day.
   * A month ending yesterday is only cached when yesterday's figures are final; until
   * then everything is shown and fetched again at the next energy check.
   * @param {string} today YYYY-MM-DD in the device's time zone
   * @param {boolean} [yesterdayFinal] whether MelPump has yesterday's final figures
   */
  async updatePeriodStats(today, yesterdayFinal = true) {
    if (!this.hasCapability('melpump_energy_this_month')) return;
    const yesterday = shiftDate(today, -1);
    if (this.getStoreValue('periodStatsDay') === yesterday && !this.forcePeriodStats) return;

    const month = today.slice(0, 7);
    const year = today.slice(0, 4);
    const lastMonth = shiftMonth(month, -1);
    // Months cached before MONTH_STATS_VERSION may be missing their last day.
    const fresh = this.getStoreValue('monthStatsVersion') === MONTH_STATS_VERSION;
    const cache = (fresh && this.getStoreValue('monthStats')) || {};
    // Figures for months that aren't final yet: used now, not kept.
    const months = { ...cache };

    // Completed months needed: last month, and every earlier month of this year.
    const needed = [lastMonth];
    for (let m = `${year}-01`; m < month; m = shiftMonth(m, 1)) {
      if (!needed.includes(m)) needed.push(m);
    }
    let fetches = 0;
    for (const m of needed) {
      if (cache[m] || fetches >= MAX_MONTH_FETCHES_PER_POLL) continue;
      const lastDay = shiftDate(`${shiftMonth(m, 1)}-01`, -1);
      const items = await this.api.getDailyEnergy(this.deviceId, `${m}-01`, lastDay);
      fetches += 1;
      months[m] = { kWh: sum(items, 'Total'), heat: sum(items, 'ProducedTotal') };
      if (lastDay < yesterday || yesterdayFinal) cache[m] = months[m];
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
    if (!fresh) await this.setStoreValue('monthStatsVersion', MONTH_STATS_VERSION).catch(this.error);

    const values = {
      melpump_energy_this_month: round(current.kWh, 1),
      melpump_heat_this_month: round(current.heat, 1),
      melpump_cop_this_month: ratio(current.heat, current.kWh),
    };
    if (months[lastMonth]) {
      Object.assign(values, {
        melpump_energy_last_month: round(months[lastMonth].kWh, 1),
        melpump_heat_last_month: round(months[lastMonth].heat, 1),
        melpump_cop_last_month: ratio(months[lastMonth].heat, months[lastMonth].kWh),
      });
    }
    // The year total waits until every earlier month of the year is cached.
    const yearMonths = needed.filter((m) => m.startsWith(year));
    const complete = yearMonths.every((m) => months[m]);
    if (complete) {
      const total = yearMonths.reduce((acc, m) => ({ kWh: acc.kWh + months[m].kWh, heat: acc.heat + months[m].heat }), current);
      Object.assign(values, {
        melpump_energy_this_year: round(total.kWh, 0),
        melpump_heat_this_year: round(total.heat, 0),
        melpump_cop_this_year: ratio(total.heat, total.kWh),
      });
    }
    await this.updateCapabilities(values);

    if (yesterdayFinal && yearMonths.every((m) => cache[m]) && cache[lastMonth]) {
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
   * Seasonal COP over the last SCOP_DAYS completed days, once per day when yesterday is
   * final; before that it is shown and fetched again at the next energy check.
   * @param {string} yesterday
   * @param {boolean} [yesterdayFinal] whether MelPump has yesterday's final figures
   */
  async updateScop(yesterday, yesterdayFinal = true) {
    const scopMissing = this.hasCapability('melpump_scop_30d')
      && this.getCapabilityValue('melpump_scop_30d') === null;
    if (this.getStoreValue('scopDay') === yesterday && !scopMissing) return;

    const days = await this.api.getDailyEnergy(this.deviceId, shiftDate(yesterday, -(SCOP_DAYS - 1)), yesterday);
    if (!days.length) return;

    await this.updateCapabilities({
      melpump_scop_30d: ratio(sum(days, 'ProducedTotal'), sum(days, 'Total')),
    });
    if (yesterdayFinal) await this.setStoreValue('scopDay', yesterday);
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

}

module.exports = HeatPumpStatistics;
