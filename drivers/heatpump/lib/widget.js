'use strict';

const { MIN_KWH_FOR_COP, WIDGET_MODES, WIDGET_ACTIONS } = require('./constants');
const { toBoolean, round, ratio, dateInZone } = require('./helpers');

/**
 * The dashboard widget: its status and its buttons.
 * Part of HeatPumpDevice (drivers/heatpump/device.js), which adds these methods to itself.
 */
class HeatPumpWidget {

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

}

module.exports = HeatPumpWidget;
