'use strict';
// v1.8 add-on module. Existing features stay in index.js; everything new lives here:
//  - registry of /start users and groups
//  - Force Join + Verify (server-side membership check on every use)
//  - Owner-only /All global broadcast (users + groups, rate-limited, cancellable)
//  - per-group settings (/settings, per-group /welcome) for the real Group Creator
//  - destination verification so a Group Creator can /send and /baton only to their own group
const { InlineKeyboard } = require('grammy');

const ANON_ADMIN_BOT_ID = '1087968824'; // Telegram "GroupAnonymousBot"
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const logErr = label => error => console.error(`${label}:`, error && error.message ? error.message : error);

module.exports = function createFeatures(deps) {
  const { bot, db, saveDb, pending, keyOf, isOwner, isPrivate, isGroup, canManageGroup, permissionFailure, getBotInfo, permissions } = deps;
  const hooks = deps.hooks || {}; // v1.9: panels.js plugs in here (ban guard, private /settings, extra menu rows)

  // ---------- database sections (old data files are kept; missing sections are created) ----------
  db.users = db.users && typeof db.users === 'object' ? db.users : {};
  db.groups = db.groups && typeof db.groups === 'object' ? db.groups : {};
  db.groupSettings = db.groupSettings && typeof db.groupSettings === 'object' ? db.groupSettings : {};
  db.forceJoin = db.forceJoin && typeof db.forceJoin === 'object' ? db.forceJoin : {};
  if (typeof db.forceJoin.enabled !== 'boolean') db.forceJoin.enabled = true;
  if (!Array.isArray(db.forceJoin.channels)) db.forceJoin.channels = [];
  db.globalSettings = db.globalSettings && typeof db.globalSettings === 'object' ? db.globalSettings : {};
  // Owner-controlled global switches (v1.9). Missing key = ON, so old behaviour is unchanged.
  const globalEnabled = key => !(db.globalSettings && db.globalSettings[key] === false);

  const persist = label => saveDb().then(() => true, e => { logErr(`${label} save failed`)(e); return false; });

  // ---------- registry: users who started the bot, groups the bot is used in ----------
  function track(ctx) {
    const chat = ctx.chat;
    if (!chat) return;
    let changed = false;
    const now = Date.now();
    if (chat.type === 'private') {
      const u = ctx.from;
      if (!u || u.is_bot) return;
      const id = String(u.id);
      if (ctx.myChatMember) {
        const st = ctx.myChatMember.new_chat_member.status;
        if (st === 'kicked' || st === 'left') {
          if (db.users[id] && !db.users[id].blocked) { db.users[id].blocked = true; changed = true; }
          if (changed) persist('Registry');
          return;
        }
      }
      const name = [u.first_name, u.last_name].filter(Boolean).join(' ');
      const rec = db.users[id];
      if (!rec) { db.users[id] = { name, username: u.username || '', firstSeen: now, lastSeen: now, blocked: false }; changed = true; }
      else {
        if (rec.blocked) { rec.blocked = false; changed = true; }
        if (rec.name !== name || (rec.username || '') !== (u.username || '')) { rec.name = name; rec.username = u.username || ''; changed = true; }
        rec.lastSeen = now;
      }
    } else if (chat.type === 'group' || chat.type === 'supergroup') {
      const id = String(chat.id);
      let active = true;
      if (ctx.myChatMember) {
        const st = ctx.myChatMember.new_chat_member.status;
        if (st === 'left' || st === 'kicked') active = false;
      }
      const rec = db.groups[id];
      if (!rec) { db.groups[id] = { title: chat.title || '', type: chat.type, active, firstSeen: now }; changed = true; }
      else {
        if (rec.active !== active) { rec.active = active; changed = true; }
        if (chat.title && rec.title !== chat.title) { rec.title = chat.title; changed = true; }
        if (rec.type !== chat.type) { rec.type = chat.type; changed = true; }
      }
    }
    if (changed) persist('Registry');
  }

  // ---------- helpers ----------
  function commandTarget(text) {
    const m = /^\/([A-Za-z0-9_]+)(?:@([A-Za-z0-9_]+))?(?:\s|$)/.exec(text || '');
    return m ? { cmd: m[1].toLowerCase(), bot: m[2] ? m[2].toLowerCase() : null } : null;
  }
  function mentionedOrReplied(ctx) {
    const msg = ctx.msg;
    const bi = getBotInfo();
    if (!msg || !bi) return false;
    const text = msg.text || msg.caption || '';
    if (!text) return false;
    const u = bi.username.toLowerCase();
    const entities = msg.entities || msg.caption_entities || [];
    const mentioned = entities.some(e =>
      (e.type === 'mention' && text.slice(e.offset, e.offset + e.length).toLowerCase() === `@${u}`) ||
      (e.type === 'text_mention' && e.user?.id === bi.id)
    ) || new RegExp(`(^|[^A-Za-z0-9_])@${u}(?![A-Za-z0-9_])`, 'i').test(text);
    return mentioned || msg.reply_to_message?.from?.id === bi.id;
  }
  function parseChatRef(input) {
    const s = String(input || '').trim();
    const m = s.match(/(?:https?:\/\/)?t\.me\/([A-Za-z0-9_]{5,})\/?$/i);
    if (m) return '@' + m[1];
    if (/^@[A-Za-z0-9_]{5,}$/.test(s)) return s;
    if (/^-?\d+$/.test(s)) return Number(s);
    if (/^[A-Za-z0-9_]{5,}$/.test(s)) return '@' + s;
    return null;
  }
  async function isCreatorOf(api, chatId, userId) {
    const result = await permissions.verifyGroupCreator(api, chatId, userId);
    if (result.error) throw result.error;
    return Boolean(result.allowed);
  }
  async function canManageChat(ctx, chatId) {
    const result = await permissions.canManageChat(ctx, chatId);
    if (result.error) console.error(`Central permission verification failed for chat ${chatId}, user ${ctx.from?.id}:`, result.error.message);
    return { ...result, error: Boolean(result.error), verified: Boolean(result.verified) };
  }
  const denyText = r => r.error
    ? 'Telegram থেকে Creator পরিচয় যাচাই করা যায়নি। বটটি ওই গ্রুপে Admin আছে কি না দেখো, তারপর আবার চেষ্টা করো।'
    : 'এটি শুধু ওই গ্রুপের Creator অথবা বটের Owner করতে পারবেন।';
  const noop = () => {};
  async function notifyOwner(text, key, cooldownMs = 6 * 3600 * 1000) {
    notifyOwner.last = notifyOwner.last || new Map();
    const last = notifyOwner.last.get(key) || 0;
    if (Date.now() - last < cooldownMs) return;
    notifyOwner.last.set(key, Date.now());
    await bot.api.sendMessage(Number(deps.ownerId), text).catch(logErr('Owner notify failed'));
  }
  function urlKb(buttons, withStyle = true) {
    const kb = new InlineKeyboard();
    for (const b of buttons) {
      kb.url(b.label, b.url);
      if (withStyle && b.style) { const row = kb.inline_keyboard[kb.inline_keyboard.length - 1]; row[row.length - 1].style = b.style; }
      kb.row();
    }
    return kb;
  }
  const COLOR_NAME = { primary: '🔵 নীল', success: '🟢 সবুজ', danger: '🔴 লাল' };
  const colorKb = prefix => new InlineKeyboard()
    .text('🔵 নীল', `${prefix}:primary`).text('🟢 সবুজ', `${prefix}:success`).row()
    .text('🔴 লাল', `${prefix}:danger`).text('⚪ ডিফল্ট', `${prefix}:default`);
  const validUrl = t => /^https?:\/\//i.test(t) || /^t\.me\//i.test(t);
  const normUrl = t => (/^t\.me\//i.test(t) ? `https://${t}` : t);
  const editQuiet = (ctx, text, extra) => ctx.editMessageText(text, extra).catch(e => {
    if (!/message is not modified/i.test(String(e.description || e.message))) console.error('Edit failed:', e.message);
  });

  // ---------- FORCE JOIN ----------
  const OK_STATUS = new Set(['creator', 'administrator', 'member']);
  const lastOk = new Map(); // userId -> last time all channels were confirmed
  const FRESH_MS = 20 * 1000;       // re-check membership at most every 20s per user
  const GRACE_MS = 10 * 60 * 1000;  // tolerate Telegram API errors for 10 min after a good check
  const mentionPromptAt = new Map();

  async function inChannel(api, ch, userId) {
    const m = await api.getChatMember(ch.id, userId);
    return OK_STATUS.has(m.status) || (m.status === 'restricted' && m.is_member === true);
  }
  async function checkMembership(api, userId, force = false) {
    const chans = db.forceJoin.channels;
    const uid = String(userId);
    const last = lastOk.get(uid);
    if (!force && last && Date.now() - last < FRESH_MS) return { ok: true, missing: [], errors: [] };
    const results = await Promise.allSettled(chans.map(ch => inChannel(api, ch, userId)));
    const missing = [], errors = [];
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') { if (!r.value) missing.push(chans[i]); }
      else {
        errors.push(chans[i]);
        console.error(`Force-join check failed for channel ${chans[i].id} (${chans[i].title}), user ${uid}:`, r.reason && r.reason.message);
        notifyOwner(`⚠️ Force Join সমস্যা: "${chans[i].title}" (${chans[i].id}) Channel-এ Membership যাচাই করা যাচ্ছে না। বটটি ওই Channel-এ Admin আছে কি না দেখো।`, `fjerr:${chans[i].id}`);
      }
    });
    if (!missing.length && !errors.length) { lastOk.set(uid, Date.now()); return { ok: true, missing, errors }; }
    if (!missing.length && errors.length && last && Date.now() - last < GRACE_MS) return { ok: true, missing, errors, graced: true };
    lastOk.delete(uid);
    return { ok: false, missing, errors };
  }
  function joinKeyboard(res) {
    const list = res.missing.length ? res.missing : (res.errors.length ? res.errors : db.forceJoin.channels);
    const kb = new InlineKeyboard();
    for (const ch of list) if (ch.link) kb.url(`📢 ${ch.title}`.slice(0, 60), ch.link).row();
    return kb.text('✅ Verify', 'fj:verify');
  }
  function joinText(res) {
    const lines = ['🔒 বটের ফিচার ব্যবহার করতে আগে নিচের সব Channel-এ Join করতে হবে।'];
    if (res.missing.length) lines.push('', 'Join বাকি:', ...res.missing.map(c => `• ${c.title}`));
    if (res.errors.length) lines.push('', '⚠️ এই Channel-এর Membership এখন যাচাই করা যায়নি (একটু পরে আবার চেষ্টা করো):', ...res.errors.map(c => `• ${c.title}`));
    lines.push('', 'Join করার পর ✅ Verify চাপো।');
    return lines.join('\n');
  }

  async function gate(ctx, next) {
    const cfg = db.forceJoin;
    if (!cfg.enabled || !cfg.channels.length) return next();
    const from = ctx.from;
    if (!from || from.is_bot || isOwner(ctx)) return next(); // Bot Creator is exempt
    // Anonymous admins / channel-sender messages cannot be tied to a user, so membership cannot be checked.
    if (String(from.id) === ANON_ADMIN_BOT_ID || ctx.msg?.sender_chat) return next();
    let mode;
    if (ctx.callbackQuery) {
      if (String(ctx.callbackQuery.data || '').startsWith('fj:')) return next();
      mode = 'callback';
    } else if (ctx.message) {
      const m = ctx.message;
      if (m.new_chat_members || m.left_chat_member) return next();
      if (isPrivate(ctx)) mode = 'private';
      else if (isGroup(ctx)) {
        const c = commandTarget(m.text || m.caption || '');
        const bi = getBotInfo();
        if (c && (!c.bot || (bi && c.bot === bi.username.toLowerCase()))) mode = 'group-command';
        else if (!c && mentionedOrReplied(ctx)) mode = 'group-mention';
        else return next(); // passive auto replies/reactions are not "using" the bot
      } else return next();
    } else return next();

    const res = await checkMembership(ctx.api, from.id);
    if (res.ok) return next();
    if (mode === 'group-mention') {
      const k = `${ctx.chat.id}:${from.id}`;
      if (Date.now() - (mentionPromptAt.get(k) || 0) < 2 * 60 * 1000) return;
      mentionPromptAt.set(k, Date.now());
    }
    const text = joinText(res), kb = joinKeyboard(res);
    if (mode === 'callback') {
      await ctx.answerCallbackQuery({ text: '🔒 আগে সব Channel-এ Join করে Verify করো।', show_alert: true }).catch(noop);
      if (isPrivate(ctx)) await ctx.reply(text, { reply_markup: kb }).catch(logErr('Join prompt failed'));
      return;
    }
    const opts = { reply_markup: kb };
    if (!isPrivate(ctx)) opts.reply_parameters = { message_id: ctx.msg.message_id, allow_sending_without_reply: true };
    await ctx.reply(text, opts).catch(logErr('Join prompt failed'));
  }

  // ---------- GROUP SETTINGS ----------
  const GS_LABEL = { ai: '🤖 AI Reply', auto: '💬 Auto Reply (Greeting/Custom)', react: '❤️ Reactions' };
  function groupSettingRaw(chatId, key) {
    const s = db.groupSettings[String(chatId)];
    return s && typeof s[key] === 'boolean' ? s[key] : true; // default ON = old behaviour
  }
  // Effective value used by the bot: the Owner's global switch overrides every group.
  function groupSetting(chatId, key) { return globalEnabled(key) && groupSettingRaw(chatId, key); }
  function setGroupSetting(chatId, key, value) {
    const id = String(chatId);
    db.groupSettings[id] = db.groupSettings[id] || {};
    db.groupSettings[id][key] = value;
  }
  function welcomeRaw(chatId) {
    const w = (db.groupSettings[String(chatId)] || {}).welcome || {};
    return {
      enabled: typeof w.enabled === 'boolean' ? w.enabled : db.welcome.enabled,
      text: typeof w.text === 'string' && w.text ? w.text : db.welcome.text,
      custom: typeof w.text === 'string' && Boolean(w.text)
    };
  }
  // Effective welcome used when a member joins (Owner's global Welcome switch can turn it off everywhere).
  function effectiveWelcome(chatId) { const w = welcomeRaw(chatId); return { ...w, enabled: w.enabled && globalEnabled('welcome') }; }
  const groupTitle = chatId => (db.groups[String(chatId)] || {}).title || String(chatId);
  function renderSettings(chatId, priv = false) {
    const w = welcomeRaw(chatId);
    const onoff = v => (v ? 'ON ✅' : 'OFF ⛔');
    const text = [`⚙️ গ্রুপ সেটিংস — ${groupTitle(chatId)}`, '',
      ...Object.keys(GS_LABEL).map(k => `${GS_LABEL[k]}: ${onoff(groupSettingRaw(chatId, k))}${globalEnabled(k) ? '' : ' (Bot Owner সবার জন্য বন্ধ রেখেছেন)'}`),
      `🌸 Welcome: ${onoff(w.enabled)} (${w.custom ? 'এই গ্রুপের নিজস্ব মেসেজ' : 'ডিফল্ট মেসেজ'})${globalEnabled('welcome') ? '' : ' (Bot Owner সবার জন্য বন্ধ রেখেছেন)'}`, '',
      'এই সেটিংস শুধু এই গ্রুপে কার্যকর হবে।'].join('\n');
    const kb = new InlineKeyboard();
    for (const k of Object.keys(GS_LABEL)) kb.text(`${GS_LABEL[k]}: ${groupSettingRaw(chatId, k) ? 'বন্ধ করো' : 'চালু করো'}`, `gs:t:${k}:${chatId}`).row();
    kb.text(`🌸 Welcome ${w.enabled ? 'বন্ধ করো' : 'চালু করো'}`, `gs:t:welcome:${chatId}`).row()
      .text('✏️ Welcome Edit', `gs:we:${chatId}`).text('👁 Preview', `gs:wp:${chatId}`);
    if (priv && hooks.settingsRows) hooks.settingsRows(kb, chatId);
    return { text, kb };
  }
  function renderWelcome(chatId, priv = false) {
    const w = welcomeRaw(chatId);
    const text = `🌸 Welcome Message — ${groupTitle(chatId)}\nStatus: ${w.enabled ? 'ON' : 'OFF'} (${w.custom ? 'এই গ্রুপের নিজস্ব মেসেজ' : 'ডিফল্ট মেসেজ'})\n\nবর্তমান মেসেজ:\n\n${w.text}`;
    const kb = new InlineKeyboard().text('✏️ Edit Welcome', `gs:we:${chatId}`).row()
      .text(w.enabled ? '🔴 OFF' : '🟢 ON', `gs:wt:${chatId}`).text('👁 Preview', `gs:wp:${chatId}`).row()
      .text('♻️ ডিফল্টে ফেরাও', `gs:wr:${chatId}`);
    if (priv) kb.row().text('⬅️ সেটিংস মেনু', `gp:s:${chatId}`);
    return { text, kb };
  }
  const gwDrafts = new Map();

  async function welcomeCommand(ctx) {
    if (isGroup(ctx)) {
      const permission = await canManageGroup(ctx);
      if (!permission.allowed) return permissionFailure(ctx, permission);
      const v = renderWelcome(ctx.chat.id);
      return ctx.reply(v.text, { reply_markup: v.kb });
    }
    if (isPrivate(ctx)) {
      pending.set(keyOf(ctx), { type: 'gwgroup', userId: ctx.from.id });
      return ctx.reply('কোন গ্রুপের Welcome Message বদলাতে চাও? গ্রুপের @username অথবা numeric Chat ID পাঠাও। (শুধু তোমার নিজের তৈরি গ্রুপ)\nবাতিল: /cancel');
    }
    return ctx.reply('এই সেটিংস গ্রুপে বা Private Chat-এ ব্যবহার করো।');
  }

  // Resolve a destination for /send and /baton. Owner is unrestricted (old behaviour); anyone else may only
  // target a group/supergroup where Telegram reports them as the real creator.
  async function resolveDestination(api, input, userId) {
    const ref = parseChatRef(input);
    if (ref === null) return { ok: false, message: 'Destination হিসেবে @username অথবা numeric Chat ID দাও।' };
    let chat;
    try { chat = await api.getChat(ref); }
    catch (error) { console.error('Destination lookup failed:', error.message); return { ok: false, message: 'এই গ্রুপটি খুঁজে পাওয়া যায়নি। বটটি গ্রুপে আছে কি না দেখো।' }; }
    if (!['group', 'supergroup'].includes(chat.type)) return { ok: false, message: 'শুধু গ্রুপে পাঠানো যাবে।' };
    try {
      if (!(await isCreatorOf(api, chat.id, userId))) return { ok: false, message: 'তুমি এই গ্রুপের Creator নও, তাই এখানে পাঠাতে পারবে না।' };
    } catch (error) {
      console.error('Destination creator check failed:', error.message);
      return { ok: false, message: 'Creator পরিচয় যাচাই করা যায়নি। বটটি গ্রুপে Admin আছে কি না দেখো।' };
    }
    return { ok: true, chat };
  }
  async function canSendTo(api, destination, userId) {
    const r = await resolveDestination(api, String(destination), userId);
    return r.ok;
  }

  // ---------- BROADCAST (/All) ----------
  const bcJobs = new Map();
  let activeBroadcast = null;

  async function sendOne(api, job, chatId) {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const opts = job.buttons.length ? { reply_markup: urlKb(job.buttons, job.useStyle) } : {};
        await api.copyMessage(chatId, job.fromChatId, job.messageId, opts);
        return { ok: true };
      } catch (e) {
        const code = e.error_code;
        const desc = String(e.description || e.message || '');
        if (code === 429) { await sleep(((e.parameters && e.parameters.retry_after) || 5) * 1000 + 500); continue; }
        if (job.useStyle && job.buttons.some(b => b.style) && code === 400 && /button|markup|style/i.test(desc)) { job.useStyle = false; continue; }
        if (e.name === 'HttpError' || (code && code >= 500)) { await sleep(1500 * (attempt + 1)); continue; }
        return { ok: false, code, desc };
      }
    }
    return { ok: false, code: 0, desc: 'retry limit reached' };
  }
  const bcStatusText = (s, done, total, head) =>
    `${head}\n${done}/${total}\n\n👥 Users — ✅ ${s.users.sent} | ❌ ${s.users.failed} | 🚫 ${s.users.blocked}\n🏠 Groups — ✅ ${s.groups.sent} | ❌ ${s.groups.failed}`;
  function bcReport(s, cancelled, remaining) {
    return ['📊 Broadcast Report', cancelled ? `⛔ বাতিল করা হয়েছে (বাকি ছিল: ${remaining})` : '✅ সম্পন্ন', '',
      '👥 Users',
      `• Total Users: ${s.users.total}`, `• Successfully Sent: ${s.users.sent}`, `• Failed: ${s.users.failed}`, `• Blocked / Unreachable: ${s.users.blocked}`, '',
      '🏠 Groups',
      `• Total Groups: ${s.groups.total}`, `• Successfully Sent: ${s.groups.sent}`, `• Failed / Unreachable: ${s.groups.failed}`].join('\n');
  }

  async function runBroadcast(api, job) {
    activeBroadcast = job;
    const targets = [
      ...Object.keys(db.users).map(id => ({ kind: 'user', id })),
      ...Object.keys(db.groups).filter(id => db.groups[id].active !== false).map(id => ({ kind: 'group', id }))
    ];
    const s = {
      users: { total: Object.keys(db.users).length, sent: 0, failed: 0, blocked: 0 },
      groups: { total: targets.filter(t => t.kind === 'group').length, sent: 0, failed: 0 }
    };
    const stopKb = new InlineKeyboard().text('⛔ Cancel Broadcast', `bc:stop:${job.id}`);
    let statusMsg = null;
    try {
      statusMsg = await api.sendMessage(job.ownerChatId, bcStatusText(s, 0, targets.length, '📢 Broadcast চলছে...'), { reply_markup: stopKb });
    } catch (e) { console.error('Broadcast status message failed:', e.message); }
    let lastEdit = Date.now();
    let done = 0;
    let dirty = false;
    try {
      for (const t of targets) {
        if (job.cancelled) break;
        const r = await sendOne(api, job, t.id);
        if (t.kind === 'user') {
          const rec = db.users[t.id];
          if (r.ok) { s.users.sent++; if (rec && rec.blocked) { rec.blocked = false; dirty = true; } }
          else if (r.code === 403 || /chat not found|user is deactivated|PEER_ID_INVALID|bot was blocked/i.test(r.desc || '')) {
            s.users.blocked++; if (rec && !rec.blocked) { rec.blocked = true; dirty = true; }
          } else { s.users.failed++; console.error(`Broadcast to user ${t.id} failed:`, r.desc); }
        } else if (r.ok) s.groups.sent++;
        else {
          s.groups.failed++;
          console.error(`Broadcast to group ${t.id} failed:`, r.desc);
          if (r.code === 403 || /chat not found|bot was kicked|group chat was deleted|PEER_ID_INVALID/i.test(r.desc || '')) {
            if (db.groups[t.id]) { db.groups[t.id].active = false; dirty = true; }
          }
        }
        done++;
        if (statusMsg && (done % 25 === 0 || Date.now() - lastEdit > 4000)) {
          lastEdit = Date.now();
          api.editMessageText(job.ownerChatId, statusMsg.message_id, bcStatusText(s, done, targets.length, '📢 Broadcast চলছে...'), { reply_markup: stopKb }).catch(noop);
        }
        await sleep(55); // ~18 msg/s, below Telegram's ~30 msg/s limit
      }
    } finally {
      activeBroadcast = null;
      if (dirty) await persist('Broadcast registry');
      const report = bcReport(s, Boolean(job.cancelled), targets.length - done);
      if (statusMsg) api.editMessageText(job.ownerChatId, statusMsg.message_id, report).catch(noop);
      api.sendMessage(job.ownerChatId, report).catch(logErr('Broadcast report failed'));
    }
  }

  let startBroadcastRef = async () => {};
  let fjPanelRef = () => ({ text: 'Force Join', kb: new InlineKeyboard() });
  // ---------- install: middleware, commands, callbacks ----------
  function installEarly() {
    bot.use(async (ctx, next) => {
      try { track(ctx); } catch (e) { console.error('Registry tracking error:', e); }
      return next();
    });
    bot.use((ctx, next) => (hooks.pre ? hooks.pre(ctx, next) : next())); // v1.9: ban / maintenance guard (before Force Join)
    bot.use((ctx, next) => (hooks.moderate ? hooks.moderate(ctx, next) : next())); // Premium moderation runs before Force Join so no message can skip it
    bot.use(gate);

    // --- /All ---
    async function startBroadcast(ctx) {
      if (!isOwner(ctx)) return ctx.reply('এই কমান্ডটি শুধু Bot Creator (Master Owner) ব্যবহার করতে পারবেন।');
      if (!isPrivate(ctx)) return ctx.reply('/All শুধু Owner-এর Private Chat-এ ব্যবহার করা যাবে।');
      if (activeBroadcast) return ctx.reply('একটি Broadcast এখনো চলছে। শেষ হওয়া পর্যন্ত অপেক্ষা করো অথবা সেটির নিচের Cancel বাটন চাপো।');
      pending.set(keyOf(ctx), { type: 'broadcast', step: 'content', userId: ctx.from.id });
      return ctx.reply('📢 সবাইকে যে মেসেজ পাঠাতে চাও সেটি পাঠাও। (Text, Photo, Video, Voice, Document ইত্যাদি)\nবাতিল: /cancel');
    }
    startBroadcastRef = startBroadcast;
    bot.command(['All', 'all', 'ALL'], startBroadcast);
    bot.callbackQuery(/^bc:(btn|c|more):(.+)$/, async ctx => {
      if (!isOwner(ctx) || !isPrivate(ctx)) return ctx.answerCallbackQuery({ text: 'শুধু Owner পারবেন।', show_alert: true });
      const flow = pending.get(keyOf(ctx));
      const [, kind, val] = ctx.match;
      const expectStep = { btn: 'askbtn', c: 'color', more: 'more' }[kind];
      if (!flow || flow.type !== 'broadcast' || flow.step !== expectStep) return ctx.answerCallbackQuery({ text: 'এই ধাপের মেয়াদ শেষ। /All দিয়ে আবার শুরু করো।', show_alert: true });
      await ctx.answerCallbackQuery();
      await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }).catch(noop);
      if (kind === 'btn' || kind === 'more') {
        if (val === 'yes') { flow.step = 'label'; pending.set(keyOf(ctx), flow); return ctx.reply('Button-এর নাম কী হবে? নাম লিখে পাঠাও।'); }
        return bcPreview(ctx, flow);
      }
      const style = val === 'default' ? undefined : val;
      flow.buttons = flow.buttons || [];
      flow.buttons.push({ label: flow.label, url: flow.url, style });
      flow.step = 'more'; pending.set(keyOf(ctx), flow);
      return ctx.reply(`✅ Button যোগ হয়েছে (মোট ${flow.buttons.length}টি, রঙ: ${style ? COLOR_NAME[style] : '⚪ ডিফল্ট'})।\n\nআরেকটি Button যোগ করতে চাও?`,
        { reply_markup: new InlineKeyboard().text('➕ হ্যাঁ, আরেকটি', 'bc:more:yes').text('➡️ না, Preview দেখাও', 'bc:more:no') });
    });
    async function bcPreview(ctx, flow) {
      const buttons = flow.buttons || [];
      const id = `bc_${Date.now()}`;
      const job = { id, fromChatId: flow.fromChatId, messageId: flow.messageId, buttons, useStyle: true, ownerChatId: ctx.chat.id, userId: ctx.from.id, started: false };
      const activeGroups = Object.values(db.groups).filter(g => g.active !== false).length;
      const kb = urlKb(buttons).text('✅ Send All', `bc:send:${id}`).text('❌ Cancel', `bc:cancel:${id}`);
      await ctx.reply(`🔎 Broadcast Preview\nRegistered Users: ${Object.keys(db.users).length}\nGroups: ${activeGroups}\nনিচের মেসেজটি সবার কাছে যাবে। Button: ${buttons.length}টি।`);
      let copied = await ctx.api.copyMessage(ctx.chat.id, flow.fromChatId, flow.messageId, { reply_markup: kb }).catch(e => { console.error('Broadcast preview failed:', e.message); return null; });
      if (!copied && buttons.some(b => b.style)) {
        job.useStyle = false;
        copied = await ctx.api.copyMessage(ctx.chat.id, flow.fromChatId, flow.messageId, { reply_markup: urlKb(buttons, false).text('✅ Send All', `bc:send:${id}`).text('❌ Cancel', `bc:cancel:${id}`) }).catch(() => null);
      }
      pending.delete(keyOf(ctx));
      if (!copied) return ctx.reply('Preview তৈরি করা যায়নি। /All দিয়ে আবার চেষ্টা করো।');
      job.previewMessageId = copied.message_id;
      bcJobs.set(id, job);
    }
    bot.callbackQuery(/^bc:send:(.+)$/, async ctx => {
      if (!isOwner(ctx)) return ctx.answerCallbackQuery({ text: 'শুধু Owner পারবেন।', show_alert: true });
      const job = bcJobs.get(ctx.match[1]);
      if (!job || job.started) return ctx.answerCallbackQuery({ text: 'এই Preview আর বৈধ নয়। /All দিয়ে আবার শুরু করো।', show_alert: true });
      if (activeBroadcast) return ctx.answerCallbackQuery({ text: 'আরেকটি Broadcast চলছে।', show_alert: true });
      job.started = true;
      await ctx.answerCallbackQuery({ text: 'Broadcast শুরু হচ্ছে...' });
      await ctx.editMessageReplyMarkup({ reply_markup: urlKb(job.buttons, job.useStyle) }).catch(noop);
      // Detached on purpose: the bot keeps serving other chats while the broadcast runs.
      runBroadcast(ctx.api, job).catch(e => console.error('Broadcast crashed:', e)).finally(() => bcJobs.delete(job.id));
    });
    bot.callbackQuery(/^bc:cancel:(.+)$/, async ctx => {
      if (!isOwner(ctx)) return ctx.answerCallbackQuery({ text: 'শুধু Owner পারবেন।', show_alert: true });
      const job = bcJobs.get(ctx.match[1]);
      if (job && !job.started) bcJobs.delete(job.id);
      await ctx.answerCallbackQuery({ text: 'বাতিল করা হয়েছে।' });
      await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }).catch(noop);
      return ctx.reply('❌ Broadcast বাতিল হয়েছে।');
    });
    bot.callbackQuery(/^bc:stop:(.+)$/, async ctx => {
      if (!isOwner(ctx)) return ctx.answerCallbackQuery({ text: 'শুধু Owner পারবেন।', show_alert: true });
      if (activeBroadcast && activeBroadcast.id === ctx.match[1]) { activeBroadcast.cancelled = true; return ctx.answerCallbackQuery({ text: 'Broadcast বন্ধ করা হচ্ছে...' }); }
      return ctx.answerCallbackQuery({ text: 'এই Broadcast আর চলছে না।' });
    });

    // --- Force Join: verify + owner channel manager ---
    bot.callbackQuery('fj:verify', async ctx => {
      if (!db.forceJoin.channels.length || !db.forceJoin.enabled) return ctx.answerCallbackQuery({ text: 'এখন কোনো Channel Join করা বাধ্যতামূলক নয়।' });
      const res = await checkMembership(ctx.api, ctx.from.id, true);
      if (res.ok) {
        await ctx.answerCallbackQuery({ text: '✅ Verify সফল!' });
        if (isPrivate(ctx)) await editQuiet(ctx, '✅ Verify সফল! এখন বটের সব ফিচার ব্যবহার করতে পারবে। /help দিয়ে শুরু করো। 🌸');
        return;
      }
      const names = (res.missing.length ? res.missing : res.errors).map(c => c.title).join(', ');
      await ctx.answerCallbackQuery({
        text: (res.missing.length ? `❌ Join বাকি: ${names}` : `⚠️ যাচাই করা যায়নি: ${names}। একটু পরে আবার চেষ্টা করো।`).slice(0, 190),
        show_alert: true
      });
      if (isPrivate(ctx)) await editQuiet(ctx, joinText(res), { reply_markup: joinKeyboard(res) });
    });

    const fjPanel = fjPanelRef = () => {
      const cfg = db.forceJoin;
      const list = cfg.channels.length ? cfg.channels.map((c, i) => `${i + 1}. ${c.title} (${c.id})`).join('\n') : 'এখনো কোনো Channel যোগ করা হয়নি।';
      const kb = new InlineKeyboard().text('➕ Channel / Group যোগ করো', 'fjadd').row();
      for (const c of cfg.channels) kb.text(`🗑 ${c.title}`.slice(0, 40), `fjdel:${c.id}`).row();
      kb.text(cfg.enabled ? '🔴 Force Join বন্ধ করো' : '🟢 Force Join চালু করো', 'fjtoggle');
      return { text: `🔒 Force Join Settings\nStatus: ${cfg.enabled ? 'ON' : 'OFF'}\n\nChannels:\n${list}\n\nChannel/Group যোগ করার আগে বটকে ওই Channel/Group-এ Admin করো।`, kb };
    };
    bot.command('channels', async ctx => {
      if (!isOwner(ctx) || !isPrivate(ctx)) return ctx.reply('এই সেটিংস শুধু Owner-এর Private Chat-এ ব্যবহার করা যাবে।');
      const v = fjPanel();
      return ctx.reply(v.text, { reply_markup: v.kb });
    });
    bot.callbackQuery(/^(fjadd|fjtoggle|fjdel:.+)$/, async ctx => {
      if (!isOwner(ctx) || !isPrivate(ctx)) return ctx.answerCallbackQuery({ text: 'শুধু Owner পারবেন।', show_alert: true });
      const data = ctx.match[1];
      await ctx.answerCallbackQuery();
      if (data === 'fjadd') {
        pending.set(keyOf(ctx), { type: 'fjadd', step: 'chan', userId: ctx.from.id });
        return ctx.reply('Channel বা Group-এর @username, t.me লিংক বা numeric ID (যেমন -100123...) পাঠাও। বটকে আগে ওই Channel/Group-এ Admin করা থাকতে হবে। Private Channel হলে ওই Channel থেকে যেকোনো একটি পোস্ট এখানে Forward করলেও চলবে।\nবাতিল: /cancel');
      }
      if (data === 'fjtoggle') db.forceJoin.enabled = !db.forceJoin.enabled;
      else db.forceJoin.channels = db.forceJoin.channels.filter(c => String(c.id) !== data.slice(6));
      await persist('Force join');
      const v = fjPanel();
      return editQuiet(ctx, v.text, { reply_markup: v.kb });
    });

    // --- Group settings (Creator for own group, Owner for any) ---
    bot.command('settings', async ctx => {
      if (isPrivate(ctx) && hooks.privateSettings) return hooks.privateSettings(ctx); // v1.9: pick a group from the private chat
      if (!isGroup(ctx)) return ctx.reply('এই কমান্ডটি গ্রুপে ব্যবহার করো।');
      const permission = await canManageGroup(ctx);
      if (!permission.allowed) return permissionFailure(ctx, permission);
      const v = renderSettings(ctx.chat.id);
      return ctx.reply(v.text, { reply_markup: v.kb });
    });
    bot.callbackQuery(/^gs:(t|we|wp|wt|wr):(?:(ai|auto|react|welcome):)?(-?\d+)$/, async ctx => {
      const [, action, key, chatIdStr] = ctx.match;
      const chatId = Number(chatIdStr);
      const perm = await canManageChat(ctx, chatId);
      if (!perm.allowed) return ctx.answerCallbackQuery({ text: denyText(perm), show_alert: true });
      await ctx.answerCallbackQuery();
      if (action === 't') {
        if (key === 'welcome') {
          const id = String(chatId);
          db.groupSettings[id] = db.groupSettings[id] || {};
          db.groupSettings[id].welcome = { ...(db.groupSettings[id].welcome || {}), enabled: !welcomeRaw(chatId).enabled };
        } else if (key) setGroupSetting(chatId, key, !groupSettingRaw(chatId, key));
        await persist('Group settings');
        const v = renderSettings(chatId, isPrivate(ctx));
        return editQuiet(ctx, v.text, { reply_markup: v.kb });
      }
      if (action === 'wt') {
        const id = String(chatId);
        db.groupSettings[id] = db.groupSettings[id] || {};
        db.groupSettings[id].welcome = { ...(db.groupSettings[id].welcome || {}), enabled: !welcomeRaw(chatId).enabled };
        await persist('Group welcome');
        const v = renderWelcome(chatId, isPrivate(ctx));
        return editQuiet(ctx, v.text, { reply_markup: v.kb });
      }
      if (action === 'wr') {
        const w = (db.groupSettings[String(chatId)] || {}).welcome;
        if (w) { delete w.text; delete w.enabled; }
        await persist('Group welcome');
        const v = renderWelcome(chatId, isPrivate(ctx));
        return editQuiet(ctx, v.text, { reply_markup: v.kb });
      }
      if (action === 'wp') return ctx.reply(welcomeRaw(chatId).text.replaceAll('{name}', 'নতুন সদস্য'));
      pending.set(keyOf(ctx), { type: 'gwtext', chatId, userId: ctx.from.id });
      return ctx.reply('এই গ্রুপের নতুন Welcome Message লিখে পাঠাও। নতুন সদস্যের নাম বসাতে {name} লিখো। এরপর Preview ও Confirm দেখানো হবে।\nবাতিল: /cancel');
    });
    bot.callbackQuery(/^gs:(wc|wx):(.+)$/, async ctx => {
      const [, action, id] = ctx.match;
      const draft = gwDrafts.get(id);
      if (!draft || String(draft.userId) !== String(ctx.from.id)) return ctx.answerCallbackQuery({ text: 'Preview-এর মেয়াদ শেষ। আবার চেষ্টা করো।', show_alert: true });
      if (action === 'wx') { gwDrafts.delete(id); await ctx.answerCallbackQuery({ text: 'বাতিল করা হয়েছে।' }); return editQuiet(ctx, '❌ Welcome Message পরিবর্তন বাতিল।'); }
      const perm = await canManageChat(ctx, draft.chatId);
      if (!perm.allowed) return ctx.answerCallbackQuery({ text: denyText(perm), show_alert: true });
      const cid = String(draft.chatId);
      db.groupSettings[cid] = db.groupSettings[cid] || {};
      db.groupSettings[cid].welcome = { ...(db.groupSettings[cid].welcome || {}), text: draft.text, enabled: true };
      gwDrafts.delete(id);
      try { await saveDb(); } catch (e) { console.error('Group welcome save failed:', e.message); return ctx.answerCallbackQuery({ text: 'সংরক্ষণ করা যায়নি। Render Logs দেখো।', show_alert: true }); }
      await ctx.answerCallbackQuery({ text: 'সংরক্ষিত হয়েছে।' });
      return editQuiet(ctx, `✅ ${groupTitle(draft.chatId)} গ্রুপের Welcome Message সংরক্ষিত হয়েছে এবং ON করা হয়েছে।`);
    });
  }

  // Message flows for the new features. Runs before the old catch-all message handler and passes
  // everything it does not own to it with next(), so old flows (/set, /send, /baton, /welcome) are untouched.
  function installFlows() {
    bot.on('message', async (ctx, next) => {
      const msg = ctx.msg;
      const text = msg.text || msg.caption || '';
      const flow = pending.get(keyOf(ctx));
      if (!flow || !['broadcast', 'fjadd', 'gwgroup', 'gwtext'].includes(flow.type) || (text && text.startsWith('/'))) return next();
      const k = keyOf(ctx);

      if (flow.type === 'broadcast') {
        if (!isOwner(ctx) || !isPrivate(ctx)) return;
        if (flow.step === 'content') {
          flow.fromChatId = ctx.chat.id; flow.messageId = msg.message_id; flow.step = 'askbtn'; pending.set(k, flow);
          return ctx.reply('এই মেসেজে Button যোগ করতে চাও?', { reply_markup: new InlineKeyboard().text('✅ Yes', 'bc:btn:yes').text('❌ No', 'bc:btn:no') });
        }
        if (flow.step === 'label') {
          if (!text.trim()) return ctx.reply('Button-এর নাম লিখে পাঠাও।');
          flow.label = text.trim(); flow.step = 'url'; pending.set(k, flow);
          return ctx.reply('এখন Button-এ ক্লিক করলে যে URL খুলবে সেটি পাঠাও (https:// অথবা t.me/ লিংক)।');
        }
        if (flow.step === 'url') {
          if (!validUrl(text.trim())) return ctx.reply('সঠিক URL দাও। https:// অথবা t.me/ দিয়ে শুরু করো।');
          flow.url = normUrl(text.trim()); flow.step = 'color'; pending.set(k, flow);
          return ctx.reply(`এই Button-এর রঙ কী হবে? (Button: ${flow.label})`, { reply_markup: colorKb('bc:c') });
        }
        return; // waiting for a button press
      }

      if (flow.type === 'fjadd') {
        if (!isOwner(ctx) || !isPrivate(ctx)) return;
        if (flow.step === 'chan') {
          const origin = msg.forward_origin;
          const ref = origin && origin.type === 'channel' ? origin.chat.id : parseChatRef(text);
          if (ref === null || ref === undefined) return ctx.reply('সঠিক @username, t.me লিংক বা numeric ID দাও।');
          let chat;
          try { chat = await ctx.api.getChat(ref); }
          catch (e) { console.error('Force-join channel lookup failed:', e.message); return ctx.reply('Channel খুঁজে পাওয়া যায়নি। বটকে ওই Channel-এ Admin করেছো কি না দেখো।'); }
          if (chat.type === 'private') return ctx.reply('এটি Channel/Group নয়।');
          if (db.forceJoin.channels.some(c => String(c.id) === String(chat.id))) { pending.delete(k); return ctx.reply('এই Channel আগেই যোগ করা আছে।'); }
          try {
            const me = await ctx.api.getChatMember(chat.id, getBotInfo().id);
            if (!['administrator', 'creator'].includes(me.status)) throw new Error(`bot status is ${me.status}`);
          } catch (e) { console.error('Force-join bot admin check failed:', e.message); return ctx.reply('বট ওই Channel-এর Admin নয়, তাই Membership যাচাই করতে পারবে না। আগে বটকে Admin করো, তারপর আবার পাঠাও।'); }
          flow.chat = { id: chat.id, title: chat.title || chat.username || String(chat.id), username: chat.username || '' };
          if (chat.username) { db.forceJoin.channels.push({ ...flow.chat, link: `https://t.me/${chat.username}` }); pending.delete(k); if (!await persist('Force join')) return ctx.reply('⚠️ যোগ হয়েছে কিন্তু ডিস্কে সংরক্ষণ করা যায়নি — Render Logs দেখুন। রিস্টার্টে মুছে যেতে পারে।'); return ctx.reply(`✅ যোগ হয়েছে: ${flow.chat.title}\n/channels দিয়ে তালিকা দেখো।`); }
          flow.step = 'link'; pending.set(k, flow);
          return ctx.reply('এটি Private Channel। ব্যবহারকারীরা যে Invite Link দিয়ে Join করবে সেই https://t.me/+... লিংক পাঠাও।');
        }
        if (flow.step === 'link') {
          if (!/^https:\/\/t\.me\/\S+$/i.test(text.trim())) return ctx.reply('সঠিক Invite Link দাও (https://t.me/... )।');
          db.forceJoin.channels.push({ ...flow.chat, link: text.trim() }); pending.delete(k);
          if (!await persist('Force join')) return ctx.reply('⚠️ যোগ হয়েছে কিন্তু ডিস্কে সংরক্ষণ করা যায়নি — Render Logs দেখুন।');
          return ctx.reply(`✅ যোগ হয়েছে: ${flow.chat.title}\n/channels দিয়ে তালিকা দেখো।`);
        }
        return;
      }

      if (flow.type === 'gwgroup') {
        if (!isPrivate(ctx)) return;
        const r = await resolveDestination(ctx.api, text, ctx.from.id);
        if (!r.ok) return ctx.reply(r.message);
        pending.delete(k);
        if (!db.groups[String(r.chat.id)]) { db.groups[String(r.chat.id)] = { title: r.chat.title || '', type: r.chat.type, active: true, firstSeen: Date.now() }; persist('Registry'); }
        const v = renderWelcome(r.chat.id, true);
        return ctx.reply(v.text, { reply_markup: v.kb });
      }

      if (flow.type === 'gwtext') {
        if (!text.trim()) return ctx.reply('Welcome Message হিসেবে লেখা পাঠাও।');
        const perm = await canManageChat(ctx, flow.chatId);
        if (!perm.allowed) { pending.delete(k); return ctx.reply(denyText(perm)); }
        const id = `gw_${Date.now()}_${ctx.from.id}`;
        gwDrafts.set(id, { chatId: flow.chatId, text: text.trim(), userId: ctx.from.id });
        pending.delete(k);
        return ctx.reply(`🌸 Welcome Message Preview — ${groupTitle(flow.chatId)}\n\n${text.trim()}\n\nএটাই কি এই গ্রুপের নতুন Welcome Message হবে?`,
          { reply_markup: new InlineKeyboard().text('✅ Confirm & Save', `gs:wc:${id}`).text('❌ Cancel', `gs:wx:${id}`) });
      }
      return next();
    });
  }

  function onShutdown() { if (activeBroadcast) activeBroadcast.cancelled = true; }

  return { installEarly, installFlows, groupSetting, groupSettingRaw, effectiveWelcome, resolveDestination, canSendTo, welcomeCommand, onShutdown,
    globalEnabled, canManageChat, renderSettings, renderWelcome, groupTitle, startBroadcast: ctx => startBroadcastRef(ctx), fjPanel: () => fjPanelRef(), isCreatorOf };
};
