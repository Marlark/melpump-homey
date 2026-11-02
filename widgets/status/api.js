'use strict';

module.exports = {
  async getStatus({ homey, query }) {
    return homey.app.getWidgetStatus(query.device);
  },

  async runAction({ homey, body }) {
    return homey.app.runWidgetAction(body && body.device, body && body.action);
  },
};
