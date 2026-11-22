'use strict';

/*
 * The app's Web API, used by the app settings page (settings/index.html).
 * Endpoints are declared in the "api" section of .homeycompose/app.json.
 */

module.exports = {
  async getOverview({ homey }) {
    return homey.app.getOverview();
  },
};
