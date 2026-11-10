const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeChatText, cannedReply } = require('./index.js');

test('fixed replies work for common Bengali and English messages', () => {
  for (const message of ['হাই', 'হ্যালো', 'Hi', 'Hello', 'কেমন আছো?', 'কি করছো?', 'খেয়েছো?', 'কোথায় আছো?', 'আসসালামু আলাইকুম', 'গুড নাইট', 'মন খারাপ', 'সরি', 'শুভ সকাল']) {
    assert.equal(typeof cannedReply(message), 'string', `missing canned reply for: ${message}`);
  }
});

test('normalization handles punctuation, emoji and bot mention', () => {
  assert.equal(normalizeChatText('  হাই!!! 😊 @MimJannatBot  '), 'হাই');
  assert.equal(typeof cannedReply('হাই!!! 😊 @MimJannatBot'), 'string');
});

test('a greeting prefix does not swallow a longer real question', () => {
  assert.equal(cannedReply('হাই, আজ কী করছো?'), null);
});

test('bot mention is detected even when Telegram entities are absent', () => {
  const { isBotMentioned } = require('./index.js');
  assert.equal(isBotMentioned({ text: 'হাই @MimJannatBot কেমন আছো?' }, 'MimJannatBot'), true);
  assert.equal(isBotMentioned({ text: 'সাধারণ মেসেজ' }, 'MimJannatBot'), false);
});

test('fallback reply exists when AI provider fails', () => {
  const { fallbackReply } = require('./index.js');
  assert.equal(typeof fallbackReply('তোমার কী খবর?'), 'string');
  assert.ok(fallbackReply('তোমার কী খবর?').length > 0);
});
