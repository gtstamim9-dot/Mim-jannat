const test = require('node:test');
const assert = require('node:assert/strict');
const { parseDestination, normalizedTrigger } = require('./index.js');

test('destination parser accepts public usernames and links', () => {
  assert.equal(parseDestination('@ExampleGroup'), '@ExampleGroup');
  assert.equal(parseDestination('t.me/ExampleGroup'), '@ExampleGroup');
  assert.equal(parseDestination('https://t.me/ExampleGroup'), '@ExampleGroup');
  assert.equal(parseDestination('https://t.me/ExampleGroup/123'), '@ExampleGroup');
});

test('destination parser accepts private message links and numeric chat IDs', () => {
  assert.equal(parseDestination('https://t.me/c/123456789/42'), '-100123456789');
  assert.equal(parseDestination('-1001234567890'), '-1001234567890');
});

test('destination parser refuses invite links it cannot resolve', () => {
  assert.equal(parseDestination('https://t.me/+abcdefghi'), null);
});

test('custom triggers normalize case, punctuation and emoji', () => {
  assert.equal(normalizedTrigger('  HI!!! 😊 '), 'hi');
  assert.equal(normalizedTrigger('আসসালামু আলাইকুম'), 'আসসালামু আলাইকুম');
});
