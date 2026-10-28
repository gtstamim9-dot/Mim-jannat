const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeChatText, cannedReply, chooseReaction, fallbackReply, ensureEmoji, isBotMentioned, FALLBACKS } = require('./index.js');

const hasEmoji = value => /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}]/u.test(value);

test('common Bengali and English phrases have natural direct replies', () => {
  const messages = [
    'হাই','হ্যালো','Hi','Hello','কেমন আছো?','কি করছো?','খেয়েছো?','কোথায় আছো?',
    'আসসালামু আলাইকুম','গুড নাইট','মন খারাপ','সরি','শুভ সকাল','ধন্যবাদ','ভালোবাসি','কী খবর?'
  ];
  for (const message of messages) {
    const reply = cannedReply(message);
    assert.equal(typeof reply, 'string', `missing direct reply for: ${message}`);
    assert.ok(hasEmoji(ensureEmoji(reply)), `reply should have emoji: ${message}`);
  }
});

test('normalization removes punctuation, emoji, and bot mention', () => {
  assert.equal(normalizeChatText('  হাই!!! 😊 @MimJannatBot  '), 'হাই');
  assert.equal(typeof cannedReply('হাই!!! 😊 @MimJannatBot'), 'string');
});

test('a greeting prefix does not swallow a longer real question', () => {
  assert.equal(cannedReply('হাই, আজ কী করছো?'), null);
  assert.equal(cannedReply('Hello, can you help me with homework?'), null);
});

test('bot mention is detected with or without Telegram entities', () => {
  assert.equal(isBotMentioned({ text: 'হাই @MimJannatBot কেমন আছো?' }, 'MimJannatBot'), true);
  assert.equal(isBotMentioned({ text: 'সাধারণ মেসেজ' }, 'MimJannatBot'), false);
  assert.equal(isBotMentioned({ text: 'caption @MimJannatBot', caption_entities: [{type:'mention',offset:8,length:14}] }, 'MimJannatBot'), true);
});

test('fallbacks are contextual, cute, and always include emoji', () => {
  const samples = [
    ['হাই','greeting'], ['মন খারাপ','sad'], ['কীভাবে করব?','question'],
    ['ধন্যবাদ','thanks'], ['আজকে একটা গল্প বলো','generic']
  ];
  for (const [message] of samples) {
    const reply = fallbackReply(message);
    assert.ok(reply.length > 10);
    assert.ok(hasEmoji(reply), `fallback missing emoji: ${message}`);
    assert.ok(!reply.includes('আপনার মেসেজটা পেলাম'), 'must not use the repeated generic fallback');
  }
});

test('fallback can avoid repeating the previous exact reply', () => {
  for (const category of Object.values(FALLBACKS)) {
    if (category.length > 1) {
      for (const previous of category) {
        const next = fallbackReply('সাধারণ কথা', previous);
        assert.notEqual(next, previous);
      }
    }
  }
});

test('ensureEmoji adds an emoji only when missing', () => {
  assert.ok(hasEmoji(ensureEmoji('ঠিক আছে')));
  assert.equal(ensureEmoji('ঠিক আছে 😊'), 'ঠিক আছে 😊');
});

test('reaction selection returns a supported emoji string', () => {
  for (const message of ['হাই','মন খারাপ','হাহা','ধন্যবাদ','কীভাবে করব?','সাধারণ কথা']) {
    assert.ok(typeof chooseReaction(message, {}, '-100123') === 'string');
    assert.ok(chooseReaction(message, {}, '-100123').length > 0);
  }
});

test('AI reply path adds emoji, keeps context, and avoids an exact repeated reply', async () => {
  const originalFetch = global.fetch;
  const sentRequests = [];
  global.fetch = async (_url, options) => {
    sentRequests.push(JSON.parse(options.body));
    return { ok:true, status:200, json:async()=>({choices:[{message:{content:'আজ আকাশটা বেশ সুন্দর'}}]}) };
  };
  try {
    const { aiReply } = require('./index.js');
    const first = await aiReply('test-ai-context-unique', 'আজকে আবহাওয়া কেমন মনে হয়?', 'টেস্ট');
    const second = await aiReply('test-ai-context-unique', 'আর কী বলবে?', 'টেস্ট');
    assert.ok(hasEmoji(first));
    assert.ok(hasEmoji(second));
    assert.notEqual(second, first, 'same AI text must not be sent verbatim twice in a row');
    assert.ok(sentRequests.length >= 2);
    assert.ok(sentRequests[1].messages.some(m => m.role === 'assistant' && m.content === first), 'previous assistant reply should be sent as context');
  } finally {
    global.fetch = originalFetch;
  }
});
