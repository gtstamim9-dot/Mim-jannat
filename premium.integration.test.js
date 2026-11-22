'use strict';
// Offline integration tests: the real premium.js / premium-extra.js handlers run against a mock bot and a fake Telegram API.

// grammy is a normal dependency (npm install). If it is not installed (offline sandbox), a minimal InlineKeyboard stand-in is used
// so the permission/moderation logic can still be exercised. With dependencies installed the real library is used.
try { require.resolve('grammy'); } catch (e) {
  const Module = require('module');
  const origResolve = Module._resolveFilename;
  const fake = require.resolve('./_grammy-stub.js');
  Module._resolveFilename = function (request, ...rest) { return request === 'grammy' ? fake : origResolve.call(this, request, ...rest); };
}
const test = require('node:test');
const assert = require('node:assert/strict');
const createPermissionService = require('../permissions');
const createPremium = require('../premium');
const createPremiumExtra = require('../premium-extra');

const OWNER = '7926785649', CREATOR = 111, ADMIN = 222, MEMBER = 333, OTHER = 444, GROUP = -100500;

function setup() {
  const h = { commands: {}, callbacks: [], on: [], use: [] };
  const bot = {
    command(n, f) { for (const x of [].concat(n)) h.commands[x] = f; },
    callbackQuery(re, f) { h.callbacks.push([re, f]); },
    on(ev, f) { h.on.push([ev, f]); },
    use(f) { h.use.push(f); }
  };
  const db = { groups: { [GROUP]: { title: 'Test Group', active: true } } };
  const pending = new Map();
  const permissions = createPermissionService({ ownerId: OWNER });
  const keyOf = ctx => `${ctx.chat.id}:${ctx.from.id}`;
  const deps = { bot, db, saveDb: async () => {}, pending, keyOf, isOwner: ctx => String(ctx.from.id) === OWNER, isPrivate: ctx => ctx.chat.type === 'private', isGroup: ctx => ctx.chat.type === 'supergroup', extra: {}, permissions, getBotInfo: () => ({ id: 999, username: 'testbot' }) };
  const premium = createPremium(deps);
  createPremiumExtra({ ...deps, premium, startedAt: Date.now(), dbFile: '/tmp/none.json' });
  const calls = [];
  const api = {
    async getChatAdministrators() { return [{ status: 'creator', user: { id: CREATOR } }, { status: 'administrator', user: { id: ADMIN } }]; },
    async getChatMember(_c, id) { return { status: id === CREATOR ? 'creator' : id === ADMIN ? 'administrator' : 'member' }; },
    async restrictChatMember(...a) { calls.push(['restrict', ...a]); return true; },
    async banChatMember(...a) { calls.push(['ban', ...a]); return true; },
    async deleteMessage(...a) { calls.push(['delete', ...a]); return true; }
  };
  const mkCtx = (fromId, extra = {}) => {
    const replies = [];
    return { replies, ctx: { chat: { id: GROUP, type: 'supergroup', title: 'Test Group' }, from: { id: fromId, first_name: 'X' }, api, match: '', msg: { text: '/x', message_id: 1 }, reply: async t => { replies.push(String(t)); return { message_id: 2 }; }, answerCallbackQuery: async o => { replies.push('cb:' + JSON.stringify(o || {})); }, editMessageReplyMarkup: async () => { replies.push('markup'); }, editMessageText: async t => { replies.push('edit:' + t); }, ...extra } };
  };
  return { h, db, premium, calls, mkCtx, api };
}

test('/warn: normal member and outsider cannot use it', async () => {
  const { h, mkCtx } = setup();
  const { ctx, replies } = mkCtx(MEMBER); ctx.msg.reply_to_message = { from: { id: OTHER } };
  await h.commands.warn(ctx);
  assert.ok(replies[0].includes('শুধু Bot Creator'));
});

test('/warn: Group Creator cannot punish an admin; can warn a member and auto-mutes at the limit', async () => {
  const { h, db, calls, mkCtx } = setup();
  let r = mkCtx(CREATOR); r.ctx.msg.reply_to_message = { from: { id: ADMIN } };
  await h.commands.warn(r.ctx);
  assert.ok(r.replies[0].includes('Admin'));
  assert.equal(calls.length, 0);
  for (let i = 0; i < 3; i++) { r = mkCtx(CREATOR); r.ctx.msg.reply_to_message = { from: { id: MEMBER } }; await h.commands.warn(r.ctx); }
  assert.equal(db.premium.groups[GROUP].warnings[MEMBER], undefined, 'counter is reset after the punishment is applied');
  assert.ok(calls.some(c => c[0] === 'restrict' && c[2] === MEMBER));
});

test('/unmute restores only the group\'s own default permissions (never extra change-info/pin/topics rights)', async () => {
  const { h, calls, mkCtx, api } = setup();
  const defaults = { can_send_messages: true, can_send_photos: false, can_invite_users: true };
  api.getChat = async () => ({ permissions: defaults });
  let r = mkCtx(CREATOR); r.ctx.msg.reply_to_message = { from: { id: MEMBER } };
  await h.commands.unmute(r.ctx);
  let c = calls.find(x => x[0] === 'restrict');
  assert.ok(c, 'restrictChatMember was called');
  assert.ok(JSON.stringify(c).includes('"can_photos":') === false);
  assert.ok(JSON.stringify(c).includes('"can_send_photos":false'));
  // Fallback when the defaults cannot be read: still no administrative rights are granted.
  calls.length = 0;
  api.getChat = async () => { throw new Error('network'); };
  r = mkCtx(CREATOR); r.ctx.msg.reply_to_message = { from: { id: MEMBER } };
  await h.commands.unmute(r.ctx);
  c = calls.find(x => x[0] === 'restrict');
  assert.ok(c && JSON.stringify(c).includes('can_send_messages'));
  assert.equal(/can_change_info|can_pin_messages|can_manage_topics/.test(JSON.stringify(c)), false);
});

test('/ban refuses the Bot Creator as target and bans a normal member', async () => {
  const { h, calls, mkCtx } = setup();
  let r = mkCtx(CREATOR); r.ctx.msg.reply_to_message = { from: { id: Number(OWNER) } };
  await h.commands.ban(r.ctx);
  assert.equal(calls.length, 0);
  r = mkCtx(CREATOR); r.ctx.msg.reply_to_message = { from: { id: MEMBER } };
  await h.commands.ban(r.ctx);
  assert.ok(calls.some(c => c[0] === 'ban' && c[2] === MEMBER));
});

test('permission is fail-closed when Telegram cannot verify the creator', async () => {
  const { h, mkCtx, api } = setup();
  api.getChatAdministrators = async () => { throw new Error('network'); };
  const r = mkCtx(CREATOR); r.ctx.msg.reply_to_message = { from: { id: MEMBER } };
  await h.commands.warn(r.ctx);
  assert.ok(r.replies[0].includes('শুধু Bot Creator'));
});

test('moderation: link from member is deleted, same link from admin is kept', async () => {
  const { h, db, premium, calls, mkCtx } = setup();
  premium.cfgFor(GROUP).moderation.links = true;
  const mw = h.use[0];
  const msg = { message_id: 7, text: 'visit https://x.com', entities: [{ type: 'url', offset: 6, length: 13 }] };
  let r = mkCtx(MEMBER, { message: msg }); await mw(r.ctx, async () => {});
  assert.ok(calls.some(c => c[0] === 'delete'));
  calls.length = 0;
  r = mkCtx(ADMIN, { message: msg }); await mw(r.ctx, async () => {});
  assert.equal(calls.length, 0);
  assert.equal(db.premium.groups[GROUP].stats.links, 1);
});

test('moderation: edited messages are checked too', async () => {
  const { h, premium, calls, mkCtx } = setup();
  premium.cfgFor(GROUP).moderation.links = true;
  const r = mkCtx(MEMBER, { editedMessage: { message_id: 8, text: 'x', entities: [{ type: 'text_link', offset: 0, length: 1, url: 'https://evil.com' }] } });
  await h.use[0](r.ctx, async () => {});
  assert.ok(calls.some(c => c[0] === 'delete'));
});

test('custom filter: whole-word match, per-filter action (mute) deletes the message and restricts the author', async () => {
  const { h, premium, calls, mkCtx } = setup();
  const c = premium.cfgFor(GROUP); c.moderation.badWords = true; c.filters.push({ value: 'ass', enabled: true, action: 'mute' });
  let r = mkCtx(MEMBER, { message: { message_id: 9, text: 'a nice class' } }); await h.use[0](r.ctx, async () => {});
  assert.equal(calls.length, 0);
  r = mkCtx(MEMBER, { message: { message_id: 10, text: 'you ass' } }); await h.use[0](r.ctx, async () => {});
  assert.ok(calls.some(x => x[0] === 'delete'));
  assert.ok(calls.some(x => x[0] === 'restrict'));
});

test('px callbacks: normal member is denied, Group Creator can cycle a filter action', async () => {
  const { h, premium, mkCtx } = setup();
  premium.cfgFor(GROUP).filters.push({ value: 'bad', enabled: true, action: 'delete' });
  const [re, fn] = h.callbacks.find(([r]) => r instanceof RegExp && r.test('px:fa:-100500:0'));
  let r = mkCtx(MEMBER); r.ctx.match = re.exec('px:fa:-100500:0'); await fn(r.ctx);
  assert.ok(r.replies[0].includes('অনুমতি নেই'));
  assert.equal(premium.cfgFor(GROUP).filters[0].action, 'delete');
  r = mkCtx(CREATOR); r.ctx.match = re.exec('px:fa:-100500:0'); await fn(r.ctx);
  assert.equal(premium.cfgFor(GROUP).filters[0].action, 'warn');
});

test('px: Group Creator of another group cannot change this group (Telegram says they are not its creator)', async () => {
  const { h, mkCtx } = setup();
  const [re, fn] = h.callbacks.find(([r]) => r instanceof RegExp && r.test('px:wl:-100500:inc'));
  const r = mkCtx(OTHER); r.ctx.match = re.exec('px:wl:-100500:inc'); await fn(r.ctx);
  assert.ok(r.replies[0].includes('অনুমতি নেই'));
});

test('px: warning limit is configurable by the Group Creator and the Bot Creator', async () => {
  const { h, premium, mkCtx } = setup();
  const [re, fn] = h.callbacks.find(([r]) => r instanceof RegExp && r.test('px:wl:-100500:inc'));
  let r = mkCtx(CREATOR); r.ctx.match = re.exec('px:wl:-100500:inc'); await fn(r.ctx);
  assert.equal(premium.cfgFor(GROUP).warningLimit, 4);
  r = mkCtx(Number(OWNER)); r.ctx.match = re.exec('px:wl:-100500:dec'); await fn(r.ctx);
  assert.equal(premium.cfgFor(GROUP).warningLimit, 3);
});

test('/health is Bot Creator only', async () => {
  const { h, mkCtx } = setup();
  const r = mkCtx(CREATOR, { chat: { id: 5, type: 'private' } }); await h.commands.health(r.ctx);
  assert.ok(r.replies[0].includes('শুধু Bot Creator'));
});

test('Admin Moderation: OFF by default (admin denied); ON lets an admin with Restrict right warn a member but never an admin', async () => {
  const { h, db, premium, api, mkCtx } = setup();
  const pc = premium.cfgFor(GROUP);
  assert.equal(pc.adminMod, false);
  let r = mkCtx(ADMIN); r.ctx.msg.reply_to_message = { from: { id: MEMBER } };
  await h.commands.warn(r.ctx);
  assert.equal(db.premium.groups[GROUP].warnings[MEMBER], undefined);
  pc.adminMod = true;
  api.getChatMember = async (_c, id) => ({ status: id === CREATOR ? 'creator' : id === ADMIN ? 'administrator' : 'member', can_restrict_members: id === ADMIN });
  r = mkCtx(ADMIN); r.ctx.msg.reply_to_message = { from: { id: MEMBER } };
  await h.commands.warn(r.ctx);
  assert.equal(db.premium.groups[GROUP].warnings[MEMBER], 1);
  r = mkCtx(ADMIN); r.ctx.msg.reply_to_message = { from: { id: CREATOR } };
  await h.commands.warn(r.ctx);
  assert.equal(db.premium.groups[GROUP].warnings[CREATOR], undefined);
  r = mkCtx(MEMBER); r.ctx.msg.reply_to_message = { from: { id: OTHER } };
  await h.commands.warn(r.ctx);
  assert.equal(db.premium.groups[GROUP].warnings[OTHER], undefined);
});
