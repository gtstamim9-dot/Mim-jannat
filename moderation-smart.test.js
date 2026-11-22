'use strict';
// Smart moderation: built-in abuse detection, category filters ("গালি" / "লিংক"), exemptions, hook ordering.
try { require.resolve('grammy'); } catch (e) {
  const Module = require('module');
  const origResolve = Module._resolveFilename;
  const fake = require.resolve('./_grammy-stub.js');
  Module._resolveFilename = function (request, ...rest) { return request === 'grammy' ? fake : origResolve.call(this, request, ...rest); };
}
const test = require('node:test');
const assert = require('node:assert/strict');
const { containsProfanity } = require('../profanity');
const { hasLink, categoryOf } = require('../moderation-utils');
const createPermissionService = require('../permissions');
const createPremium = require('../premium');

const OWNER = '7926785649', CREATOR = 111, ADMIN = 222, MEMBER = 333, GROUP = -100500;

test('profanity: catches Bangla, Banglish and English abuse including disguised spellings', () => {
  const bad = ['you are a fucking idiot', 'FUUUUCK you', 'f.u.c.k', 'f u c k', 'f*ck', 'sh!t', '@ss', 'bitch', 'তুই একটা মাদারচোদ', 'মাদারচুদ', 'তুই হারামি', 'কুত্তার বাচ্চা', 'শুয়োরের বাচ্চা', 'খানকির পোলা', 'মাগী', 'তোর বালের কি', 'bokachoda', 'tui magir pola', 'ওই হারামির বাচ্চা'];
  for (const t of bad) assert.ok(containsProfanity(t), 'should flag: ' + t);
});

test('profanity: ordinary and religious words are not flagged', () => {
  const good = ['hello everyone', 'class is over', 'Assam tea', 'আসসালামু আলাইকুম', 'হারাম খাবেন না', 'চোদ্দ তারিখে', 'বালিশ কিনেছি', 'সালাম', 'assistant manager', '455', 'আমি ভালো আছি', 'শালীনতা', 'bass guitar', 'মাগরিবের নামাজ'];
  for (const t of good) assert.equal(containsProfanity(t), null, 'must not flag: ' + t);
});

test('links: obfuscated links, bare domains and inline-button links are detected; plain talk is not', () => {
  for (const t of ['example.com', 'Example.COM/abc', 'hxxp://spam.xyz', 'spam [dot] com', 't . me / abc', 'tg://resolve?domain=x', 'বাংলা.com', 'example dot com']) assert.equal(hasLink({ text: t }), true, t);
  assert.equal(hasLink({ text: 'x', reply_markup: { inline_keyboard: [[{ text: 'a', url: 'https://a.io' }]] } }), true);
  for (const t of ['hello everyone', 'ok.. fine', 'আমি ভালো আছি', 'file.txt', '3.5 in']) assert.equal(hasLink({ text: t }), false, t);
});

test('categoryOf: "গালি" and "লিংক" words (also inside a sentence) become categories; *word* never does', () => {
  assert.equal(categoryOf('গালি'), 'profanity');
  assert.equal(categoryOf('কেউ গালি দিলে ডিলিট করে দিবে'), 'profanity');
  assert.equal(categoryOf('লিংক ডিলিট'), 'link');
  assert.equal(categoryOf('link'), 'link');
  assert.equal(categoryOf('*link*'), null);
  assert.equal(categoryOf('spam'), null);
  assert.equal(categoryOf('linked'), null);
});

function setup(extraDeps = {}) {
  const h = { use: [] };
  const bot = { command() {}, callbackQuery() {}, on() {}, use(f) { h.use.push(f); } };
  const db = { groups: { [GROUP]: { title: 'T', active: true } } };
  const permissions = createPermissionService({ ownerId: OWNER });
  const deps = { bot, db, saveDb: async () => {}, pending: new Map(), keyOf: ctx => `${ctx.chat.id}:${ctx.from.id}`, isOwner: ctx => String(ctx.from.id) === OWNER, isPrivate: ctx => ctx.chat.type === 'private', isGroup: ctx => ctx.chat.type === 'supergroup', extra: {}, permissions, getBotInfo: () => ({ id: 999, username: 'testbot' }), ...extraDeps };
  const premium = createPremium(deps);
  const calls = [];
  const api = {
    async getChatMember(_c, id) { return { status: id === CREATOR ? 'creator' : id === ADMIN ? 'administrator' : 'member' }; },
    async deleteMessage(...a) { calls.push(['delete', ...a]); return true; },
    async sendMessage(...a) { calls.push(['send', ...a]); return { message_id: 77 }; },
    async restrictChatMember(...a) { calls.push(['restrict', ...a]); return true; }
  };
  const run = async (fromId, message, hook) => {
    const ctx = { chat: { id: GROUP, type: 'supergroup', title: 'T' }, from: { id: fromId, first_name: 'X' }, api, message, reply: async () => ({ message_id: 2 }) };
    let passed = false;
    await (hook || h.use[0])(ctx, async () => { passed = true; });
    return passed;
  };
  return { h, db, premium, calls, run };
}

test('Bad Words ON: any abuse from a member is deleted automatically (no word list needed)', async () => {
  const { premium, calls, run } = setup();
  premium.cfgFor(GROUP).moderation.badWords = true;
  assert.equal(await run(MEMBER, { message_id: 1, text: 'tui ekta madarchod' }), false);
  assert.ok(calls.some(c => c[0] === 'delete'));
});

test('custom filter "গালি" removes every kind of abuse; "লিংক" removes every kind of link', async () => {
  const { premium, db, calls, run } = setup();
  const c = premium.cfgFor(GROUP); c.moderation.badWords = true;
  c.filters.push({ value: 'গালি', enabled: true, action: 'delete' }, { value: 'লিংক ডিলিট', enabled: true, action: 'delete' });
  assert.equal(await run(MEMBER, { message_id: 1, text: 'তুই একটা হারামজাদা' }), false);
  assert.equal(await run(MEMBER, { message_id: 2, text: 'dekho example.com e jao' }), false);
  assert.equal(calls.filter(x => x[0] === 'delete').length, 2);
  assert.equal(db.premium.groups[GROUP].stats.links, 1);
  assert.equal(await run(MEMBER, { message_id: 3, text: 'আসসালামু আলাইকুম, কেমন আছেন?' }), true);
});

test('Bot Creator and Group Creator may post links and abuse-words filters never touch them; admins follow the Admin Exemption switch', async () => {
  const { premium, calls, run } = setup();
  const c = premium.cfgFor(GROUP); c.moderation.badWords = true; c.moderation.links = true;
  const link = { message_id: 1, text: 'https://example.com' };
  assert.equal(await run(Number(OWNER), link), true);
  assert.equal(await run(CREATOR, link), true);
  assert.equal(await run(ADMIN, link), true);          // default: admins exempt (old behaviour kept)
  assert.equal(calls.length, 0);
  c.adminExempt = false;
  premium.cfgFor(GROUP).adminExempt = false;
  // role cache holds the earlier answer for a moment, but the exemption switch is read on every message
  assert.equal(await run(ADMIN, { message_id: 2, text: 'https://example.com' }), false);
  assert.equal(await run(CREATOR, { message_id: 3, text: 'https://example.com' }), true);
});

test('hook mode: with hooks given, the moderation middleware is exposed to be mounted before Force Join', async () => {
  const hooks = {};
  const { h, premium, run } = setup({ hooks });
  assert.equal(typeof hooks.moderate, 'function');
  assert.equal(h.use.length, 0);
  premium.cfgFor(GROUP).moderation.links = true;
  assert.equal(await run(MEMBER, { message_id: 1, text: 'join t.me/spam' }, hooks.moderate), false);
});

test('warn-action filter on the "গালি" category still deletes and warns', async () => {
  const { premium, db, calls, run } = setup();
  const c = premium.cfgFor(GROUP); c.moderation.badWords = true; c.filters.push({ value: 'গালি', enabled: true, action: 'warn' });
  await run(MEMBER, { message_id: 1, text: 'you bitch' });
  assert.ok(calls.some(x => x[0] === 'delete'));
  assert.equal(db.premium.groups[GROUP].warnings[String(MEMBER)], 1);
});
