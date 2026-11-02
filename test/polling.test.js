'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createDevice } = require('./helpers');

const active = (device) => device.timers.filter((timer) => !timer.cleared);

test('only one poll runs at a time; calls meanwhile queue one more', async () => {
  const device = await createDevice();
  let runs = 0;
  let release;
  device.pollOnce = () => {
    runs += 1;
    return new Promise((resolve) => { release = resolve; });
  };

  const first = device.poll();
  device.poll();
  device.poll();
  assert.strictEqual(runs, 1);
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(runs, 2, 'the queued poll runs once afterwards');
  release();
  await first;
  assert.strictEqual(runs, 2);
  assert.strictEqual(device.polling, false);
  assert.strictEqual(active(device).length, 1, 'one next poll scheduled');
});

test('no poll is scheduled after the device is removed during a poll', async () => {
  const device = await createDevice();
  let release;
  let runs = 0;
  device.pollOnce = () => {
    runs += 1;
    return new Promise((resolve) => { release = resolve; });
  };

  const start = device.startPolling();
  device.poll();
  await device.onDeleted();
  release();
  await start;
  assert.strictEqual(runs, 1, 'the queued poll is dropped');
  assert.strictEqual(active(device).length, 0);
  await device.startPolling();
  await device.poll();
  assert.strictEqual(runs, 1, 'stays stopped');
});

test('the next poll waits longer after failures, and for a rate limit pause', async () => {
  const device = await createDevice();
  device.pollStartedAt = Date.now();
  const minutes = [0, 1, 2, 3, 4, 9].map((failed) => {
    device.failedPolls = failed;
    return Math.round(device.pollDelay() / 60000);
  });
  assert.deepStrictEqual(minutes, [1, 1, 2, 5, 10, 10]);

  device.pausedUntil = Date.now() + 7 * 60000;
  assert.strictEqual(Math.round(device.pollDelay() / 60000), 7);
});

test('a change from Homey brings the next poll forward to 20 seconds', async () => {
  const device = await createDevice();
  device.failedPolls = 0;
  device.pollOnce = async () => {};
  await device.poll();
  assert.ok(active(device)[0].delay > 50000);

  device.pollSoon();
  assert.strictEqual(active(device).length, 1);
  assert.strictEqual(active(device)[0].delay, 20000);

  // Asked for during a poll: the poll after it comes in 20 seconds, then back to normal.
  device.pollOnce = async () => device.pollSoon();
  await device.poll();
  assert.strictEqual(active(device)[0].delay, 20000);
  device.pollOnce = async () => {};
  await device.poll();
  assert.ok(active(device)[0].delay > 50000);
});

test('a successful write moves the next poll forward', async () => {
  const device = await createDevice();
  device.store.writeAccess = true;
  device.pollSoon = () => { device.soon = true; };
  await device.write(async () => ({ success: true }));
  assert.strictEqual(device.soon, true);
});

test('a write without write access is refused', async () => {
  const device = await createDevice();
  device.store.writeAccess = false;
  await assert.rejects(device.write(async () => {}), /device\.no_write_access/);
});

test('the same error is logged once, then every 10th time', async () => {
  const device = await createDevice();
  device.logs.length = 0;
  device.failedPolls = 1;
  for (let i = 0; i < 25; i += 1) device.logPollError('down');
  device.logPollError('other');
  const errors = device.logs.filter((line) => line.startsWith('ERROR'));
  assert.strictEqual(errors.length, 4);
  assert.match(errors[1], /same error 10 times/);
});

test('3 failed polls make the device unavailable; an auth error does at once', async () => {
  const device = await createDevice();
  await device.setAvailable();
  device.unavailableMessage = null;
  const fail = (message, extra = {}) => device.handlePollError(Object.assign(new Error(message), extra));

  await fail('timeout');
  await fail('timeout');
  assert.strictEqual(device.getAvailable(), true);
  await fail('timeout');
  assert.strictEqual(device.getAvailable(), false);

  const other = await createDevice();
  await other.setAvailable();
  other.unavailableMessage = null;
  await other.handlePollError(Object.assign(new Error('401'), { isAuthError: true, status: 401 }));
  assert.strictEqual(other.getAvailable(), false);
  assert.strictEqual(other.unavailableMessage, 'device.auth_failed');
});

test('a rate limit pauses polling for 10 minutes without counting as a failure', async () => {
  const device = await createDevice();
  await device.handlePollError(Object.assign(new Error('429'), { isRateLimited: true }));
  assert.strictEqual(device.failedPolls, 0);
  assert.ok(Math.abs(device.pausedUntil - Date.now() - 10 * 60000) < 1000);
});

test('the request budget stops reads above 90 requests an hour', async () => {
  const device = await createDevice();
  const now = Date.now();
  device.requestTimes = Array(89).fill(now);
  assert.strictEqual(device.hasBudget(), true);
  assert.strictEqual(device.hasBudget(2), false);
  device.requestTimes = Array(95).fill(now - 61 * 60000);
  assert.strictEqual(device.hasBudget(), true, 'requests older than an hour are forgotten');
  assert.strictEqual(device.requestTimes.length, 0);
});
