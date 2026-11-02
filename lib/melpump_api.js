'use strict';

// API reference: https://melpump.com/api/doc (OpenAPI spec at /api/doc.json).
const BASE_URL = 'https://melpump.com';

const ENDPOINTS = {
  devices: '/api/devices?activeOnly=true',
  device: (deviceId) => `/api/devices/${encodeURIComponent(deviceId)}`,
  deviceAccess: (deviceId) => `/api/devices/${encodeURIComponent(deviceId)}/access`,
  currentState: (deviceId) => `/api/devices/${encodeURIComponent(deviceId)}/current-state`,
  changeState: (deviceId) => `/api/change-state/${encodeURIComponent(deviceId)}`,
  changeTemperature: (deviceId) => `/api/change-temperature/${encodeURIComponent(deviceId)}`,
  forceSolarMode: (deviceId) => `/api/devices/${encodeURIComponent(deviceId)}/force-solar-mode`,
  clearSolarMode: (deviceId) => `/api/devices/${encodeURIComponent(deviceId)}/clear-solar-mode`,
  alarmHistory: (deviceId) => `/api/devices/${encodeURIComponent(deviceId)}/alarm-history`,
  acknowledgeAllAlarms: (deviceId) => `/api/devices/${encodeURIComponent(deviceId)}/alarm-history/acknowledge-all`,
  acknowledgeAlarm: (deviceId, historyId) => `/api/devices/${encodeURIComponent(deviceId)}/alarm-history/${encodeURIComponent(historyId)}/acknowledge`,
  dayStates: (deviceId, date) => `/api/states/device/${encodeURIComponent(deviceId)}/${encodeURIComponent(date)}`,
  dailyEnergy: (deviceId, start, end) => `/api/energy/daily/${encodeURIComponent(deviceId)}/${encodeURIComponent(start)}/${encodeURIComponent(end)}`,
};

const REQUEST_TIMEOUT_MS = 15000;

class MelPumpApiError extends Error {

  constructor(message, { status = null, body = null } = {}) {
    super(message);
    this.name = 'MelPumpApiError';
    this.status = status;
    this.body = body;
  }

  get isAuthError() {
    return this.status === 401 || this.status === 403;
  }

  get isRateLimited() {
    return this.status === 429;
  }

}

class MelPumpApi {

  /**
   * @param {object} options
   * @param {string} options.apiKey API token from melpump.com Account Settings > API Tokens (starts with "api_")
   * @param {string} [options.baseUrl]
   * @param {Function} [options.log]
   * @param {Function|null} [options.debug] logs every request (never the token) when set
   * @param {number} [options.timeout] ms per request, including reading the response
   */
  constructor({
    apiKey, baseUrl = BASE_URL, log = () => {}, debug = null, timeout = REQUEST_TIMEOUT_MS,
  }) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.log = log;
    this.debug = debug;
    this.timeout = timeout;
  }

  static isValidKeyFormat(apiKey) {
    return typeof apiKey === 'string' && apiKey.startsWith('api_') && apiKey.length > 4;
  }

  /**
   * Lists the active devices the token can read.
   * @returns {Promise<Array<{ id: string, name: string, writeAccess: boolean, device: object }>>}
   */
  async getDevices() {
    const list = await this._request('GET', ENDPOINTS.devices);
    if (!Array.isArray(list)) return [];

    return list
      .filter((access) => access && access.device && access.readAccess)
      .map((access) => ({
        id: String(access.device.id),
        name: access.device.name || `MelPump ${access.device.id}`,
        writeAccess: Boolean(access.writeAccess),
        device: access.device,
      }));
  }

  /**
   * Device details, including deviceSettings (Smart Energy and solar status).
   * @param {string} deviceId
   * @returns {Promise<object>} Device
   */
  async getDevice(deviceId) {
    return this._request('GET', ENDPOINTS.device(deviceId));
  }

  /**
   * The token's access to one device, including whether its MelPump subscription is active.
   * @param {string} deviceId
   * @returns {Promise<{ readAccess: boolean, writeAccess: boolean, ownerAccess: boolean, subscriptionActive: boolean|null }>}
   */
  async getDeviceAccess(deviceId) {
    return this._request('GET', ENDPOINTS.deviceAccess(deviceId));
  }

  /**
   * Latest telemetry. The response's fullExternalData is dropped right away: it is
   * large, unused, and would otherwise be kept as long as the result is.
   * @param {string} deviceId
   * @returns {Promise<{ state: object|null, dataQuality: number|null }>}
   */
  async getDeviceStatus(deviceId) {
    const data = await this._request('GET', ENDPOINTS.currentState(deviceId));
    if (!data || typeof data !== 'object') return null;
    return { state: data.state || null, dataQuality: data.dataQuality ?? null };
  }

  /**
   * Changes temperatures / operation mode (TemperatureDTO), e.g.
   * { temperatureZone1: 21.5 } or { operationMode: 2 }.
   * @param {string} deviceId
   * @param {object} settings
   */
  async setDeviceSettings(deviceId, settings) {
    return this._postAction(ENDPOINTS.changeTemperature(deviceId), settings);
  }

  /**
   * Toggles device functions (ToggleStateDTO), e.g. { power: false } or { smartEnergy: true }.
   * @param {string} deviceId
   * @param {object} toggles
   */
  async setDeviceState(deviceId, toggles) {
    return this._postAction(ENDPOINTS.changeState(deviceId), toggles);
  }

  /**
   * Forces solar mode for a number of minutes (1-1440).
   * @param {string} deviceId
   * @param {number} minutes
   * @returns {Promise<{ success: boolean, updated_records: number, end_time: string }>}
   */
  async forceSolarMode(deviceId, minutes) {
    return this._postAction(ENDPOINTS.forceSolarMode(deviceId), { minutes });
  }

  /**
   * @param {string} deviceId
   */
  async clearSolarMode(deviceId) {
    return this._postAction(ENDPOINTS.clearSolarMode(deviceId), null);
  }

  /**
   * Alarms triggered today (device local time).
   * @param {string} deviceId
   * @returns {Promise<Array<object>>} AlarmHistoryDTO[]
   */
  async getAlarmHistory(deviceId) {
    const data = await this._request('GET', ENDPOINTS.alarmHistory(deviceId));
    return Array.isArray(data) ? data : [];
  }

  /**
   * @param {string} deviceId
   */
  async acknowledgeAllAlarms(deviceId) {
    // The spec documents no response body for this endpoint, so any 2xx counts as success.
    await this._request('POST', ENDPOINTS.acknowledgeAllAlarms(deviceId));
  }

  /**
   * @param {string} deviceId
   * @param {number|string} historyId AlarmHistoryDTO.id
   */
  async acknowledgeAlarm(deviceId, historyId) {
    const id = String(historyId);
    if (!/^\d+$/.test(id)) throw new MelPumpApiError(`Invalid alarm id: ${id}`);
    await this._request('POST', ENDPOINTS.acknowledgeAlarm(deviceId, id));
  }

  /**
   * Device states for one day at 5-minute intervals.
   * @param {string} deviceId
   * @param {string} date YYYY-MM-DD
   * @returns {Promise<Array<object>>} DeviceState[]
   */
  async getDayStates(deviceId, date) {
    const data = await this._request('GET', ENDPOINTS.dayStates(deviceId, date));
    return Array.isArray(data) ? data : [];
  }

  /**
   * Energy per day between two dates (max 100 days).
   * @param {string} deviceId
   * @param {string} start YYYY-MM-DD
   * @param {string} end YYYY-MM-DD
   * @returns {Promise<Array<object>>} DeviceEnergySchema[] (kWh)
   */
  async getDailyEnergy(deviceId, start, end) {
    const data = await this._request('GET', ENDPOINTS.dailyEnergy(deviceId, start, end));
    return Array.isArray(data) ? data : [];
  }

  // body === null sends a POST without a body (for endpoints that take none).
  async _postAction(path, body) {
    if (body !== null && (!body || typeof body !== 'object' || Object.keys(body).length === 0)) {
      throw new MelPumpApiError('No settings provided');
    }
    const data = await this._request('POST', path, { body: body === null ? undefined : body });
    if (!data || data.success !== true) {
      throw new MelPumpApiError('melpump.com did not accept the change', { body: data });
    }
    return data;
  }

  async _request(method, path, { body } = {}) {
    if (!this.apiKey) {
      throw new MelPumpApiError('No melpump.com API token configured', { status: 401 });
    }

    const headers = {
      Accept: 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeout);

    // The timeout also covers reading the body, so a response that stalls after the
    // headers can't leave the request (and the poll waiting for it) hanging.
    const started = Date.now();
    const describe = () => `${method} ${path}${body !== undefined ? ` ${JSON.stringify(body)}` : ''}`;
    let res;
    let text;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      text = await res.text();
    } catch (err) {
      if (this.debug) this.debug(`${describe()} failed after ${Date.now() - started} ms: ${err.name} ${err.message}`);
      if (err.name === 'AbortError') {
        throw new MelPumpApiError(`Request to melpump.com timed out (${method} ${path})`);
      }
      throw new MelPumpApiError(`Could not reach melpump.com: ${err.message}`);
    } finally {
      clearTimeout(timeout);
    }
    if (this.debug) this.debug(`${describe()} -> HTTP ${res.status} in ${Date.now() - started} ms, ${text.length} bytes`);

    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch (err) {
        data = text;
      }
    }

    if (!res.ok) {
      const apiMessage = data && typeof data === 'object' ? (data.message || data.error || data.detail) : null;
      let message;
      if (res.status === 401) {
        message = 'melpump.com rejected the API token (missing, invalid or expired)';
      } else if (res.status === 403) {
        message = 'The API token has no permission for this device';
      } else if (res.status === 429) {
        message = 'melpump.com rate limit reached (100 requests per hour per device)';
      } else {
        message = apiMessage || `melpump.com returned HTTP ${res.status}`;
      }
      throw new MelPumpApiError(message, { status: res.status, body: data });
    }

    return data;
  }

}

MelPumpApi.MelPumpApiError = MelPumpApiError;

module.exports = MelPumpApi;
