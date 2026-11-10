const test = require('node:test');
const assert = require('node:assert/strict');
const { groupPresetReply, parseTelegramTarget, normalizeChatText } = require('./index');

test('built-in group triggers answer common Bangla and English greetings', () => {
  assert.equal(groupPresetReply('Hi'), 'হ্যালো! 😊');
  assert.equal(groupPresetReply('হাই!'), 'হ্যালো! 😊');
  assert.match(groupPresetReply('আসসালামু আলাইকুম'), /ওয়ালাইকুমুস সালাম/);
  assert.match(groupPresetReply('How are you?'), /I am good/);
});

test('unconfigured ordinary text does not get a group preset reply', () => {
  assert.equal(groupPresetReply('আজকে আবহাওয়া কেমন'), null);
});

test('group trigger normalization ignores punctuation and emoji', () => {
  assert.equal(normalizeChatText('HI!!! 😊'), 'hi');
  assert.equal(normalizeChatText('হাই ভাই'), 'হাই ভাই');
});

test('public Telegram group links and usernames parse', () => {
  assert.deepEqual(parseTelegramTarget('https://t.me/my_public_group'), {kind:'username',value:'@my_public_group'});
  assert.deepEqual(parseTelegramTarget('@my_public_group'), {kind:'username',value:'@my_public_group'});
});

test('private invite links parse for registered-link lookup', () => {
  assert.equal(parseTelegramTarget('https://t.me/+AbCdEf_123').kind, 'invite');
  assert.equal(parseTelegramTarget('https://t.me/joinchat/AbCdEf_123').kind, 'invite');
});

test('invalid target links are rejected', () => {
  assert.equal(parseTelegramTarget('https://example.com/group'), null);
  assert.equal(parseTelegramTarget('t.me/c/123/456'), null);
});
