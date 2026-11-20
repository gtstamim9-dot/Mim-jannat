'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { systemPrompt, ensureEmoji, CREATOR_ANSWER, BOT_DISPLAY_NAME } = require('../personality');

test('system prompt carries identity, creator answer and emoji rules (private and group)', () => {
  for (const inGroup of [false, true]) {
    const p = systemPrompt('রহিম', inGroup);
    assert.ok(p.includes('MIM JANNAT BOT'));
    assert.ok(p.includes(BOT_DISPLAY_NAME));
    assert.ok(p.includes('আমার Bot Creator হলেন GTS Tarek! 🌸🤍'));
    assert.ok(p.includes('আল্লাহ'));
    assert.ok(p.includes('রহিম'));
    assert.equal(p.includes('১৬ বছর'), false);
    assert.equal(p.includes('গোদাগাড়ী'), false);
    assert.equal(p.includes('(এটি একটি গ্রুপ চ্যাট)'), inGroup);
  }
  assert.equal(CREATOR_ANSWER, 'আমার Bot Creator হলেন GTS Tarek! 🌸🤍');
});

test('ensureEmoji adds an emoji to plain replies, keeps existing ones, skips serious messages', () => {
  assert.match(ensureEmoji('ঠিক আছে, বুঝেছি'), /\p{Extended_Pictographic}/u);
  assert.equal(ensureEmoji('আচ্ছা 🌸'), 'আচ্ছা 🌸');
  assert.equal(ensureEmoji('Error: request failed'), 'Error: request failed');
  assert.equal(ensureEmoji(''), '');
});
