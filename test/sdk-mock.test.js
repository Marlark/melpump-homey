'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createDevice, expectViolation, manifest } = require('./helpers');

// The test Homey must reject what a real Homey rejects, or the other tests prove less.

test('the mock Homey rejects a trigger token of the wrong type, like the SDK', async () => {
  const device = await createDevice();
  const card = manifest.flow.triggers.find((c) => c.id === 'cop_changed');
  assert.ok(card.tokens.some((token) => token.name === 'cop' && token.type === 'number'));

  const broken = await expectViolation(() => device.driver.copChangedTrigger.trigger(device, { cop: '3.2' }));
  assert.deepStrictEqual(broken, [
    'Could not trigger Flow card with id "cop_changed": Invalid value for token cop. Expected number but got string',
  ]);
  assert.strictEqual(device.fired.length, 0);

  await device.driver.copChangedTrigger.trigger(device, { cop: 3.2 });
  assert.deepStrictEqual(device.fired, [{ trigger: 'copChangedTrigger', tokens: { cop: 3.2 }, state: undefined }]);
});

test('the mock Homey rejects a missing token and a Flow card that is not in app.json', async () => {
  const device = await createDevice();
  const broken = await expectViolation(() => device.driver.copChangedTrigger.trigger(device, {}));
  assert.match(broken[0], /token cop\. Expected number but got undefined/);

  const unknown = await expectViolation(() => device.driver.homey.flow.getDeviceTriggerCard('no_such_card'));
  assert.deepStrictEqual(unknown, ['Invalid Flow Card ID: no_such_card (trigger)']);
});

test('the mock Homey checks capability values against their type in app.json', async () => {
  const device = await createDevice();
  await device.addCapability('measure_temperature.outdoor');
  await device.addCapability('melpump_mode');
  await device.addCapability('melpump_defrost');

  for (const [id, value, expected] of [
    ['measure_temperature.outdoor', '5', 'a finite number'],
    ['measure_temperature.outdoor', NaN, 'a finite number'],
    ['melpump_defrost', 1, 'a boolean'],
    ['melpump_mode', 'turbo', 'one of auto, heating, cooling, off'],
  ]) {
    const broken = await expectViolation(() => device.setCapabilityValue(id, value));
    assert.strictEqual(broken.length, 1, `${id} = ${String(value)}`);
    assert.ok(broken[0].includes(expected), broken[0]);
  }

  // Valid values and null (no value) are accepted.
  await device.setCapabilityValue('measure_temperature.outdoor', -4.5);
  await device.setCapabilityValue('melpump_defrost', false);
  await device.setCapabilityValue('melpump_mode', 'heating');
  await device.setCapabilityValue('melpump_mode', null);
});

test('the mock Homey rejects unknown capabilities and missing translations', async () => {
  const device = await createDevice();
  assert.deepStrictEqual(await expectViolation(() => device.addCapability('melpump_no_such_thing')), [
    'Unknown capability melpump_no_such_thing',
  ]);
  assert.deepStrictEqual(await expectViolation(() => device.homey.__('device.no_such_text')), [
    'Missing translation: device.no_such_text',
  ]);
  assert.throws(() => device.getCapabilityOptions('melpump_no_such_thing'), /Invalid Capability/);
});
