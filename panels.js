'use strict';
// v1.9 add-on module: separate panels with server-side permission checks.
//  - Master Admin Panel (/admin): Bot Creator only (fixed Telegram ID)
//  - Group Owner Panel (/panel) and private-chat /settings: only for the real Telegram creator of each group
//  - Ban / Unban, Global Settings, Statistics, group registry with verified creator
// Existing features stay untouched; this file only adds new handlers.
const crypto = require('crypto');
const { InlineKeyboard } = require('grammy');

const ANON_ADMIN_BOT_ID = '1087968824'; // Telegram "GroupAnonymousBot"
const PAGE = 8;
const ACTIVE_MS = 7 * 24 * 3600 * 1000;    // "active group" = a message in the last 7 days
const DAY = 24 * 3600 * 1000;
const noop = () => {};
const logErr = label => e => console.error(`${label}:`, e && e.message ? e.message : e);
const short = (t, n) => { const s = String(t == null ? '' : t); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const fmt = ts => ts ? new Date(ts).toLocaleString('en-GB', { timeZone: 'Asia/Dhaka', hour12: false }).replace(',', '') + ' (BD)' : '—';
const hash6 = t => crypto.createHash('md5').update(String(t)).digest('hex').slice(0, 6);

module.exports = function createPanels(deps) {
  const { bot, db, saveDb, pending, keyOf, isOwner, isPrivate, isGroup, norm, extra, hooks, getBotInfo } = deps;
  const OWNER_ID = String(deps.ownerId);

  // ---------- database sections (old data is kept; missing sections are created) ----------
  db.banned = db.banned && typeof db.banned === 'object' ? db.banned : {};
  db.globalSettings = db.globalSettings && typeof db.globalSettings === 'object' ? db.globalSettings : {};
  const persist = label => saveDb().catch(logErr(`${label} save failed`));
  let touchTimer = null;
  const persistSoon = () => { if (touchTimer) return; touchTimer = setTimeout(() => { touchTimer = null; persist('Group activity'); }, 5 * 60 * 1000); touchTimer.unref && touchTimer.unref(); };

  const isBanned = id => Boolean(db.banned[String(id)]);
  const maintenanceOn = () => db.globalSettings.maintenance === true;

  // ---------- UI helpers ----------
  const edit = async (ctx, text, kb) => {
    try { await ctx.editMessageText(text, kb ? { reply_markup: kb } : undefined); }
    catch (e) {
      if (/message is not modified/i.test(String(e.description || e.message))) return;
      console.error('Panel edit failed, sending new message:', e.message);
      await ctx.reply(text, kb ? { reply_markup: kb } : undefined).catch(logErr('Panel reply failed'));
    }
  };
  const onoff = v => (v ? 'ON ✅' : 'OFF ⛔');
  const userLabel = (rec, id) => (rec && rec.name ? rec.name : String(id)) + (rec && rec.username ? ` (@${rec.username})` : '');

  // ---------- group registry: verified creator cache ----------
  const isGroupRec = g => g && (g.type === 'group' || g.type === 'supergroup');
  async function refreshCreator(api, chatId) {
    const admins = await api.getChatAdministrators(chatId);
    const creator = admins.find(a => a.status === 'creator');
    const rec = db.groups[String(chatId)];
    if (!rec) return null;
    rec.creatorCheckedAt = Date.now();
    delete rec.creatorErrAt;
    if (creator && creator.user && creator.user.id != null) {
      rec.creatorId = String(creator.user.id);
      rec.creatorName = [creator.user.first_name, creator.user.last_name].filter(Boolean).join(' ');
      rec.creatorUsername = creator.user.username || '';
      rec.creatorVerified = true;
    } else {
      // API succeeded but did not return a creator: invalidate stale identity.
      delete rec.creatorId;
      delete rec.creatorName;
      delete rec.creatorUsername;
      rec.creatorVerified = false;
    }
    persistSoon();
    return rec;
  }
  async function pool(items, limit, fn) {
    const out = new Array(items.length);
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
    }));
    return out;
  }
  // Groups where the user is the REAL creator according to Telegram (live-verified every time).
  async function eligibleGroups(api, userId, force = false) {
    const uid = String(userId);
    const now = Date.now();
    const cands = Object.entries(db.groups).filter(([, g]) => isGroupRec(g) && g.active !== false);
    const res = await pool(cands, 2, async ([id, g]) => {
      // Re-query Telegram on every listing so a changed group creator is not hidden by stale cache.
      const recentErr = g.creatorErrAt && now - g.creatorErrAt < 60 * 1000 && !force;
      if (recentErr) return null;
      try {
        const rec = await refreshCreator(api, id);
        await new Promise(r => setTimeout(r, 100)); // stay far below Telegram's request limits
        return rec && rec.creatorId === uid ? { id, title: g.title || id } : null;
      } catch (e) {
        g.creatorErrAt = Date.now();
        g.creatorVerified = false;
        console.error(`Creator lookup failed for group ${id}:`, e.message);
        return null;
      }
    });
    return res.filter(Boolean).sort((a, b) => a.title.localeCompare(b.title));
  }
  async function backfillCreators(api) {
    const ids = Object.entries(db.groups).filter(([, g]) => isGroupRec(g) && g.active !== false && !g.creatorId).map(([id]) => id);
    for (const id of ids) {
      try { await refreshCreator(api, id); }
      catch (e) { console.error(`Creator backfill failed for group ${id}:`, e.message); if (db.groups[id]) db.groups[id].creatorErrAt = Date.now(); }
      await new Promise(r => setTimeout(r, 400));
    }
    if (ids.length) persist('Creator backfill');
  }

  // ---------- guard: group activity, creator refresh on join, ban + maintenance ----------
  const noticeAt = new Map();
  function notice(ctx, text) {
    const k = String(ctx.from.id);
    if (Date.now() - (noticeAt.get(k) || 0) < 60 * 1000) return;
    noticeAt.set(k, Date.now());
    return ctx.reply(text).catch(noop);
  }
  async function guard(ctx, next) {
    try {
      const chat = ctx.chat;
      if (chat && (chat.type === 'group' || chat.type === 'supergroup')) {
        const rec = db.groups[String(chat.id)];
        if (rec && (ctx.message || ctx.callbackQuery)) { rec.lastActive = Date.now(); persistSoon(); }
        if (ctx.myChatMember && rec) {
          const st = ctx.myChatMember.new_chat_member.status;
          if (st === 'member' || st === 'administrator') {
            if (ctx.from) { rec.addedBy = String(ctx.from.id); persistSoon(); }
            refreshCreator(ctx.api, chat.id).catch(logErr(`Creator lookup on join failed (${chat.id})`));
          }
        }
      }
    } catch (e) { console.error('Panel guard bookkeeping error:', e); }

    const from = ctx.from;
    if (!(ctx.message || ctx.callbackQuery) || !from || from.is_bot || isOwner(ctx)) return next(); // Bot Creator is never blocked
    if (String(from.id) === ANON_ADMIN_BOT_ID || ctx.msg?.sender_chat) return next();
    const m = ctx.message;
    if (m && (m.new_chat_members || m.left_chat_member)) return next();
    const priv = isPrivate(ctx);
    if (isBanned(from.id)) {
      if (ctx.callbackQuery) return ctx.answerCallbackQuery({ text: '🚫 তোমাকে এই বট ব্যবহার করা থেকে Ban করা হয়েছে।', show_alert: true }).catch(noop);
      if (priv) await notice(ctx, '🚫 তোমাকে এই বট ব্যবহার করা থেকে Ban করা হয়েছে।');
      return; // groups: silently ignored (no reply, no reaction, no commands)
    }
    if (maintenanceOn()) {
      if (ctx.callbackQuery) return ctx.answerCallbackQuery({ text: '🛠 বট এখন রক্ষণাবেক্ষণে আছে। একটু পরে চেষ্টা করো।', show_alert: true }).catch(noop);
      if (priv) await notice(ctx, '🛠 বট এখন রক্ষণাবেক্ষণে আছে। একটু পরে আবার চেষ্টা করো।');
      return;
    }
    return next();
  }
  hooks.pre = guard;

  // ---------- Master Admin Panel ----------
  const isMaster = ctx => isOwner(ctx) && isPrivate(ctx) && String(ctx.from.id) === OWNER_ID;
  const backRow = kb => kb.row().text('⬅️ মূল মেনু', 'adm:home');

  function adminHome() {
    const kb = new InlineKeyboard()
      .text('📊 Dashboard', 'adm:dash').text('📈 Statistics', 'adm:stat').row()
      .text('👥 User Management', 'adm:ul:0').text('🏠 Group Management', 'adm:gl:0').row()
      .text('🚫 Ban / Unban', 'adm:ban').text('⚙️ Global Settings', 'adm:gset').row()
      .text('📢 Broadcast', 'adm:bc').text('🔒 Force Join', 'adm:fj').row()
      .text('❌ বন্ধ করো', 'adm:close');
    return { text: '🛡 Master Admin Panel\n👑 Official Creator: GTS Tarek\nস্বাগতম, Bot Creator। এখান থেকে বটের সব ইউজার, সব গ্রুপ ও সব সেটিংস নিয়ন্ত্রণ করতে পারবে।\n\nগ্রুপ সেটিংস: /settings • তোমার নিজের Creator গ্রুপ: /panel', kb };
  }
  const counts = () => {
    const now = Date.now();
    const users = Object.values(db.users || {});
    const groups = Object.values(db.groups || {});
    const cur = groups.filter(g => g.active !== false);
    return {
      users: users.length,
      blockedBot: users.filter(u => u.blocked).length,
      banned: Object.keys(db.banned).length,
      groupsAll: groups.length,
      groupsNow: cur.length,
      groupsActive: cur.filter(g => g.lastActive && now - g.lastActive < ACTIVE_MS).length,
      users24: users.filter(u => u.lastSeen && now - u.lastSeen < DAY).length,
      users7: users.filter(u => u.lastSeen && now - u.lastSeen < 7 * DAY).length,
      new24: users.filter(u => u.firstSeen && now - u.firstSeen < DAY).length,
      new7: users.filter(u => u.firstSeen && now - u.firstSeen < 7 * DAY).length,
      new30: users.filter(u => u.firstSeen && now - u.firstSeen < 30 * DAY).length,
      cur
    };
  };
  function dashboardView() {
    const c = counts();
    const text = ['📊 Dashboard', '',
      `👥 মোট ইউজার: ${c.users}  (যারা বটের Private Chat-এ এসেছে)`,
      `   ⛔ বট Block করেছে: ${c.blockedBot} • 🚫 Ban করা: ${c.banned}`, '',
      `🏠 এ পর্যন্ত মোট গ্রুপ: ${c.groupsAll}`,
      `✅ বর্তমানে বট যুক্ত আছে: ${c.groupsNow}`,
      `🔥 সক্রিয় গ্রুপ (গত ৭ দিনে মেসেজ): ${c.groupsActive}`].join('\n');
    return { text, kb: backRow(new InlineKeyboard().text('🔄 Refresh', 'adm:dash')) };
  }
  function statsView() {
    const c = counts();
    const replyGroups = Object.keys(db.customReplies || {}).filter(id => (db.customReplies[id] || []).length && db.groups[id] && db.groups[id].active !== false).length;
    const customWelcome = Object.keys(db.groupSettings || {}).filter(id => db.groupSettings[id] && db.groupSettings[id].welcome && db.groupSettings[id].welcome.text).length;
    const gs = db.globalSettings;
    const text = ['📈 Statistics', '',
      '👥 ইউজার',
      `• মোট: ${c.users} • নতুন (২৪ঘ/৭দিন/৩০দিন): ${c.new24}/${c.new7}/${c.new30}`,
      `• সক্রিয় (২৪ঘ/৭দিন): ${c.users24}/${c.users7}`,
      `• বট Block করেছে: ${c.blockedBot} • 🚫 Ban: ${c.banned}`, '',
      '🏠 গ্রুপ',
      `• এ পর্যন্ত মোট: ${c.groupsAll} • বর্তমানে যুক্ত: ${c.groupsNow} • সক্রিয় (৭ দিন): ${c.groupsActive}`,
      `• বট বাদ পড়েছে/Kick: ${c.groupsAll - c.groupsNow}`,
      `• Custom Reply আছে এমন গ্রুপ: ${replyGroups}`,
      `• নিজস্ব Welcome আছে এমন গ্রুপ: ${customWelcome}`, '',
      '🧠 অন্যান্য',
      `• AI কথোপকথন মেমোরি: ${Object.keys(db.conversations || {}).length}টি`,
      `• Force Join Channel: ${db.forceJoin.channels.length}টি (${onoff(db.forceJoin.enabled)})`,
      `• Global: AI ${onoff(gs.ai !== false)} • Auto ${onoff(gs.auto !== false)} • React ${onoff(gs.react !== false)} • Welcome ${onoff(gs.welcome !== false)} • Maintenance ${onoff(gs.maintenance === true)}`,
      `• Uptime: ${Math.floor(process.uptime() / 3600)} ঘণ্টা ${Math.floor(process.uptime() / 60) % 60} মিনিট`,
      '', 'নোট: "ইউজার" বলতে যারা বটকে Private Chat-এ ব্যবহার করেছে। গ্রুপের সবাই এখানে গোনা হয় না।'].join('\n');
    return { text, kb: backRow(new InlineKeyboard().text('🔄 Refresh', 'adm:stat')) };
  }

  // users
  function usersView(page) {
    const all = Object.entries(db.users || {}).sort((a, b) => (b[1].lastSeen || 0) - (a[1].lastSeen || 0));
    const pages = Math.max(1, Math.ceil(all.length / PAGE));
    page = Math.min(Math.max(0, page), pages - 1);
    const slice = all.slice(page * PAGE, page * PAGE + PAGE);
    const lines = slice.map(([id, u], i) => `${page * PAGE + i + 1}. ${isBanned(id) ? '🚫 ' : u.blocked ? '⛔ ' : ''}${userLabel(u, id)} — ${id}`);
    const text = `👥 User Management — মোট ${all.length}জন (পেজ ${page + 1}/${pages})\n🚫 Ban • ⛔ বট Block করেছে\n\n${lines.join('\n') || 'এখনো কোনো ইউজার নেই।'}`;
    const kb = new InlineKeyboard();
    for (const [id, u] of slice) kb.text(short(userLabel(u, id), 40), `adm:u:${id}`).row();
    if (page > 0) kb.text('⬅️ আগের', `adm:ul:${page - 1}`);
    if (page < pages - 1) kb.text('পরের ➡️', `adm:ul:${page + 1}`);
    kb.row().text('🔎 ID / @username দিয়ে খোঁজো', 'adm:usearch');
    return { text, kb: backRow(kb) };
  }
  function userView(id) {
    id = String(id);
    const u = db.users[id];
    const b = db.banned[id];
    const mem = (db.conversations[`private:${id}`] || []).length;
    const lines = [`👤 ইউজার: ${userLabel(u || b, id)}`, `🆔 ID: ${id}`,
      `📅 প্রথম এসেছে: ${fmt(u && u.firstSeen)}`, `🕒 শেষ সক্রিয়: ${fmt(u && u.lastSeen)}`,
      `📬 বট Block করেছে: ${u && u.blocked ? 'হ্যাঁ ⛔' : 'না'}`,
      `🚫 Ban: ${b ? `হ্যাঁ (${fmt(b.at)})` : 'না'}`, `🧠 AI মেমোরি: ${mem}টি মেসেজ`];
    if (!u) lines.push('', 'এই ইউজার বটের Private Chat-এ আসেননি (শুধু ID দিয়ে Ban/Unban করা যায়)।');
    const kb = new InlineKeyboard();
    if (id === OWNER_ID) lines.push('', '👑 ইনি Bot Creator — Ban করা যায় না।');
    else kb.text(b ? '✅ Unban করো' : '🚫 Ban করো', `adm:${b ? 'unban' : 'ban1'}:${id}`).row();
    if (mem) kb.text('🧹 AI মেমোরি মুছো', `adm:uclr:${id}`).row();
    kb.text('⬅️ ইউজার তালিকা', 'adm:ul:0');
    return { text: lines.join('\n'), kb: backRow(kb) };
  }
  function resolveUser(input) {
    const t = String(input || '').trim();
    if (/^\d{3,15}$/.test(t)) return t;
    const uname = t.replace(/^@/, '').toLowerCase();
    if (/^[a-z0-9_]{4,32}$/.test(uname)) {
      const hit = Object.entries(db.users).find(([, u]) => (u.username || '').toLowerCase() === uname);
      if (hit) return hit[0];
    }
    return null;
  }
  async function doBan(ctx, id) {
    id = String(id);
    if (id === OWNER_ID) return { ok: false, message: '👑 Bot Creator-কে Ban করা যায় না।' };
    if (id === String(getBotInfo() && getBotInfo().id)) return { ok: false, message: 'বট নিজেকে Ban করতে পারে না।' };
    if (isBanned(id)) return { ok: true, already: true };
    const u = db.users[id];
    db.banned[id] = { at: Date.now(), by: String(ctx.from.id), name: u ? u.name : '', username: u ? u.username || '' : '' };
    pending.delete(`${id}:${id}`); // drop any half-finished private flow of that user
    try { await saveDb(); } catch (e) { delete db.banned[id]; console.error('Ban save failed:', e.message); return { ok: false, message: 'Ban সংরক্ষণ করা যায়নি। Render Logs দেখো।' }; }
    return { ok: true };
  }
  async function doUnban(id) {
    id = String(id);
    const old = db.banned[id];
    if (!old) return { ok: true, already: true };
    delete db.banned[id];
    try { await saveDb(); } catch (e) { db.banned[id] = old; console.error('Unban save failed:', e.message); return { ok: false, message: 'Unban সংরক্ষণ করা যায়নি। Render Logs দেখো।' }; }
    return { ok: true };
  }
  function banMenuView() {
    const n = Object.keys(db.banned).length;
    const kb = new InlineKeyboard().text('🚫 Ban করো', 'adm:banask').text('✅ Unban করো', 'adm:unbanask').row().text(`📋 Ban তালিকা (${n})`, 'adm:bl:0');
    return { text: `🚫 Ban / Unban\n\nBan করা ইউজার বটের কোনো ফিচার (Private, Group, Command, Button) ব্যবহার করতে পারে না। Unban করলে আবার পারবে।\nবর্তমানে Ban করা: ${n}জন`, kb: backRow(kb) };
  }
  function bannedListView(page) {
    const all = Object.entries(db.banned).sort((a, b) => (b[1].at || 0) - (a[1].at || 0));
    const pages = Math.max(1, Math.ceil(all.length / PAGE));
    page = Math.min(Math.max(0, page), pages - 1);
    const slice = all.slice(page * PAGE, page * PAGE + PAGE);
    const text = `📋 Ban তালিকা (পেজ ${page + 1}/${pages})\n\n` + (slice.map(([id, b], i) => `${page * PAGE + i + 1}. ${userLabel(db.users[id] || b, id)} — ${id}\n   ${fmt(b.at)}`).join('\n') || 'কেউ Ban নেই।');
    const kb = new InlineKeyboard();
    for (const [id, b] of slice) kb.text(`✅ Unban: ${short(userLabel(db.users[id] || b, id), 28)}`, `adm:unban:${id}`).row();
    if (page > 0) kb.text('⬅️ আগের', `adm:bl:${page - 1}`);
    if (page < pages - 1) kb.text('পরের ➡️', `adm:bl:${page + 1}`);
    return { text, kb: kb.row().text('⬅️ Ban মেনু', 'adm:ban').text('⬅️ মূল মেনু', 'adm:home') };
  }

  // groups
  const groupsSorted = () => Object.entries(db.groups || {}).filter(([, g]) => isGroupRec(g))
    .sort((a, b) => (b[1].active !== false) - (a[1].active !== false) || String(a[1].title).localeCompare(String(b[1].title)));
  function groupsView(page, mode) { // mode 'd' = detail (Group Management), 's' = settings (/settings)
    const all = groupsSorted();
    const pages = Math.max(1, Math.ceil(all.length / PAGE));
    page = Math.min(Math.max(0, page), pages - 1);
    const slice = all.slice(page * PAGE, page * PAGE + PAGE);
    const head = mode === 's' ? '⚙️ কোন গ্রুপের সেটিংস পরিবর্তন করতে চাও? (Owner — সব গ্রুপ)' : '🏠 Group Management';
    const lines = slice.map(([id, g], i) => `${page * PAGE + i + 1}. ${g.active === false ? '⛔' : '✅'} ${g.title || id}\n   ID: ${id} • Creator: ${g.creatorId && g.creatorVerified === true ? userLabel({ name: g.creatorName, username: g.creatorUsername }, g.creatorId) : 'Unverified'}`);
    const text = `${head} — মোট ${all.length}টি (পেজ ${page + 1}/${pages})\n✅ বট যুক্ত আছে • ⛔ বট নেই\n\n${lines.join('\n') || 'এখনো কোনো গ্রুপ নেই।'}`;
    const kb = new InlineKeyboard();
    for (const [id, g] of slice) kb.text(`${g.active === false ? '⛔' : '✅'} ${short(g.title || id, 36)}`, mode === 's' ? `gp:s:${id}` : `adm:g:${id}`).row();
    const pre = mode === 's' ? 'adm:gls' : 'adm:gl';
    if (page > 0) kb.text('⬅️ আগের', `${pre}:${page - 1}`);
    if (page < pages - 1) kb.text('পরের ➡️', `${pre}:${page + 1}`);
    return { text, kb: backRow(kb) };
  }
  function groupDetailView(id) {
    id = String(id);
    const g = db.groups[id];
    if (!g) return { text: 'এই গ্রুপ তালিকায় নেই।', kb: backRow(new InlineKeyboard().text('⬅️ গ্রুপ তালিকা', 'adm:gl:0')) };
    const w = (db.groupSettings[id] || {}).welcome || {};
    const gsr = k => extra.groupSettingRaw(id, k);
    const gl = k => (extra.globalEnabled(k) ? '' : ' (Global বন্ধ)');
    const welcomeOn = typeof w.enabled === 'boolean' ? w.enabled : db.welcome.enabled;
    const text = ['🏠 ' + (g.title || id), '',
      `🆔 Group ID: ${id}`, `📌 ধরন: ${g.type}`, `বট: ${g.active === false ? 'নেই ⛔' : 'যুক্ত আছে ✅'}`,
      `👑 Creator: ${g.creatorId && g.creatorVerified === true ? `${userLabel({ name: g.creatorName, username: g.creatorUsername }, g.creatorId)} — ${g.creatorId}` : 'Unverified (🔄 চাপো)'}`,
      `➕ বট যুক্ত করেছে: ${g.addedBy || '—'}`, `📅 রেজিস্টার: ${fmt(g.firstSeen)}`, `🕒 শেষ সক্রিয়: ${fmt(g.lastActive)}`, '',
      '⚙️ সেটিংস (গ্রুপের নিজস্ব মান)',
      `🤖 AI: ${onoff(gsr('ai'))}${gl('ai')} • 💬 Auto: ${onoff(gsr('auto'))}${gl('auto')}`,
      `❤️ React: ${onoff(gsr('react'))}${gl('react')} • 🌸 Welcome: ${onoff(welcomeOn)}${gl('welcome')} (${w.text ? 'নিজস্ব মেসেজ' : 'ডিফল্ট মেসেজ'})`,
      `💬 Custom Reply: ${(db.customReplies[id] || []).length}টি`].join('\n');
    const kb = new InlineKeyboard().text('⚙️ সেটিংস পরিবর্তন', `gp:s:${id}`).row()
      .text('💬 Custom Replies', `gp:cr:${id}`).text('🔄 Creator Refresh', `adm:gref:${id}`).row()
      .text('⬅️ গ্রুপ তালিকা', 'adm:gl:0');
    return { text, kb: backRow(kb) };
  }

  // global settings
  const GLOBAL = [
    ['ai', '🤖 AI Reply (Private + Group)'],
    ['auto', '💬 Auto Reply (Group)'],
    ['react', '❤️ Reactions'],
    ['welcome', '🌸 Member Welcome']
  ];
  function globalView() {
    const gs = db.globalSettings;
    const lines = GLOBAL.map(([k, l]) => `${l}: ${onoff(gs[k] !== false)}`);
    lines.push(`🛠 Maintenance Mode: ${onoff(gs.maintenance === true)}`);
    const text = ['⚙️ Global Settings', 'এই সেটিংস সব গ্রুপ ও সব ইউজারের জন্য প্রযোজ্য। বন্ধ করলে কোনো গ্রুপ Creator তা চালু করতে পারবে না।', '', ...lines, '',
      'Maintenance ON থাকলে শুধু Bot Creator বট ব্যবহার করতে পারবে।', 'Private Chat-এ AI বন্ধ থাকলেও Bot Creator AI ব্যবহার করতে পারবে।',
      `🔒 Force Join: ${onoff(db.forceJoin.enabled)} (${db.forceJoin.channels.length}টি Channel)`].join('\n');
    const kb = new InlineKeyboard();
    for (const [k, l] of GLOBAL) kb.text(`${l}: ${gs[k] !== false ? 'বন্ধ করো' : 'চালু করো'}`, `adm:gs:${k}`).row();
    kb.text(`🛠 Maintenance: ${gs.maintenance === true ? 'বন্ধ করো' : 'চালু করো'}`, 'adm:gs:maintenance').row().text('🔒 Force Join সেটিংস', 'adm:fj');
    return { text, kb: backRow(kb) };
  }

  bot.command('admin', async ctx => {
    if (!isPrivate(ctx)) { if (isOwner(ctx)) return ctx.reply('Master Admin Panel শুধু আমার Private Chat-এ খোলে। সেখানে /admin দাও।'); return; }
    if (!isMaster(ctx)) return ctx.reply('এই প্যানেল শুধু Bot Creator (Master Owner) ব্যবহার করতে পারবেন।');
    pending.delete(keyOf(ctx));
    const v = adminHome();
    return ctx.reply(v.text, { reply_markup: v.kb });
  });

  bot.callbackQuery(/^adm:(.+)$/, async ctx => {
    // Server-side permission check on EVERY button press (hiding buttons is not security).
    if (!isMaster(ctx)) return ctx.answerCallbackQuery({ text: '🚫 এটি শুধু Bot Creator-এর প্যানেল।', show_alert: true });
    const parts = ctx.match[1].split(':');
    const act = parts[0];
    const arg = parts[1];
    const k = keyOf(ctx);
    const show = async v => { await ctx.answerCallbackQuery().catch(noop); return edit(ctx, v.text, v.kb); };

    if (act === 'home') { pending.delete(k); return show(adminHome()); }
    if (act === 'close') { await ctx.answerCallbackQuery().catch(noop); return ctx.deleteMessage().catch(noop); }
    if (act === 'dash') return show(dashboardView());
    if (act === 'stat') return show(statsView());
    if (act === 'ul') return show(usersView(Number(arg) || 0));
    if (act === 'u') return show(userView(arg));
    if (act === 'usearch') {
      pending.set(k, { type: 'admfind', userId: ctx.from.id });
      await ctx.answerCallbackQuery().catch(noop);
      return ctx.reply('ইউজারের numeric Telegram ID অথবা @username পাঠাও।\nবাতিল: /cancel');
    }
    if (act === 'ban1') {
      const id = String(arg);
      await ctx.answerCallbackQuery().catch(noop);
      const kb = new InlineKeyboard().text('✅ হ্যাঁ, Ban করো', `adm:ban:${id}`).text('❌ না', `adm:u:${id}`);
      return edit(ctx, `⚠️ নিশ্চিত?\n${userLabel(db.users[id], id)} (${id}) বটের কোনো ফিচার আর ব্যবহার করতে পারবে না।`, kb);
    }
    if (act === 'ban' && arg === undefined) return show(banMenuView());
    if (act === 'ban') {
      if (!/^\d+$/.test(String(arg))) return ctx.answerCallbackQuery({ text: 'ID সঠিক নয়।', show_alert: true });
      const r = await doBan(ctx, arg);
      if (!r.ok) return ctx.answerCallbackQuery({ text: r.message, show_alert: true });
      return show(userView(arg));
    }
    if (act === 'unban') {
      const r = await doUnban(arg);
      if (!r.ok) return ctx.answerCallbackQuery({ text: r.message, show_alert: true });
      return show(userView(arg));
    }
    if (act === 'uclr') {
      delete db.conversations[`private:${arg}`]; if (db.convTimes) delete db.convTimes[`private:${arg}`];
      try { await saveDb(); } catch (e) { console.error('Memory clear save failed:', e.message); return ctx.answerCallbackQuery({ text: 'সংরক্ষণ করা যায়নি। Render Logs দেখো।', show_alert: true }); }
      return show(userView(arg));
    }
    if (act === 'banask' || act === 'unbanask') {
      pending.set(k, { type: act === 'banask' ? 'admban' : 'admunban', userId: ctx.from.id });
      await ctx.answerCallbackQuery().catch(noop);
      return ctx.reply(`${act === 'banask' ? '🚫 কাকে Ban করতে চাও?' : '✅ কাকে Unban করতে চাও?'} ইউজারের numeric Telegram ID পাঠাও (বটের ইউজার হলে @username-ও চলবে)।\nবাতিল: /cancel`);
    }
    if (act === 'bl') return show(bannedListView(Number(arg) || 0));
    if (act === 'gl') return show(groupsView(Number(arg) || 0, 'd'));
    if (act === 'gls') return show(groupsView(Number(arg) || 0, 's'));
    if (act === 'g') return show(groupDetailView(arg));
    if (act === 'gref') {
      try { await refreshCreator(ctx.api, arg); } catch (e) { console.error(`Creator refresh failed for ${arg}:`, e.message); return ctx.answerCallbackQuery({ text: 'Creator যাচাই করা যায়নি। বট গ্রুপে আছে কি না দেখো।', show_alert: true }); }
      return show(groupDetailView(arg));
    }
    if (act === 'gset') return show(globalView());
    if (act === 'gs') {
      const key = String(arg);
      if (key === 'maintenance') db.globalSettings.maintenance = !(db.globalSettings.maintenance === true);
      else if (GLOBAL.some(([g]) => g === key)) db.globalSettings[key] = !(db.globalSettings[key] !== false);
      else return ctx.answerCallbackQuery({ text: 'অজানা সেটিং।', show_alert: true });
      try { await saveDb(); } catch (e) { console.error('Global settings save failed:', e.message); }
      return show(globalView());
    }
    if (act === 'bc') { await ctx.answerCallbackQuery().catch(noop); return extra.startBroadcast(ctx); }
    if (act === 'fj') { await ctx.answerCallbackQuery().catch(noop); const v = extra.fjPanel(); return ctx.reply(v.text, { reply_markup: v.kb }); }
    return ctx.answerCallbackQuery({ text: 'অজানা বাটন।' });
  });

  // ---------- Group Owner Panel (real Telegram creator only) ----------
  const cooldown = new Map();
  function groupPickView(groups, mode) {
    const head = mode === 'panel' ? '🧰 Group Owner Panel' : '⚙️ কোন গ্রুপের সেটিংস পরিবর্তন করতে চাও?';
    if (!groups.length) {
      return { text: `${head}\n\nTelegram অনুযায়ী তুমি যে গ্রুপের প্রকৃত Creator এবং যেখানে বট যুক্ত আছে, এমন কোনো গ্রুপ পাওয়া যায়নি।\n\nকী করবে:\n১) বটকে তোমার গ্রুপে Add করে Admin বানাও।\n২) গ্রুপে একবার যেকোনো মেসেজ দাও বা /id লেখো।\n৩) এখানে ফিরে 🔄 চাপো।\n\nনোট: Creator যাচাই Telegram থেকে হয়, নাম বা Username দেখে নয়।`, kb: new InlineKeyboard().text('🔄 আবার যাচাই করো', 'gp:ref') };
    }
    const kb = new InlineKeyboard();
    for (const g of groups) kb.text(`🏠 ${short(g.title, 40)}`, `gp:s:${g.id}`).row();
    kb.text('🔄 তালিকা Refresh', 'gp:ref');
    return { text: `${head}\n\nতুমি যে ${groups.length}টি গ্রুপের প্রকৃত Creator (Telegram দিয়ে যাচাই করা), শুধু সেগুলোই দেখানো হচ্ছে। একটি গ্রুপ বেছে নাও:`, kb };
  }
  async function creatorHome(ctx, mode, force = false) {
    const groups = isOwner(ctx)
      ? Object.entries(db.groups || {}).filter(([, g]) => isGroupRec(g) && g.active !== false).map(([id, g]) => ({ id, title:g.title || id })).sort((a,b)=>a.title.localeCompare(b.title))
      : await eligibleGroups(ctx.api, ctx.from.id, force);
    const v = groupPickView(groups, mode);
    if (mode === 'panel' && isOwner(ctx)) v.text += '\n\n👑 Master Admin Panel: /admin • সব গ্রুপের সেটিংস: /settings';
    return v;
  }
  const privateOnlyReply = (ctx, what) => ctx.reply(`${what} শুধু আমার Private Chat-এ ব্যবহার করা যাবে। বটকে ব্যক্তিগতভাবে মেসেজ দিয়ে সেখানে লেখো।`);

  bot.command('panel', async ctx => {
    if (!isPrivate(ctx)) return privateOnlyReply(ctx, '/panel');
    pending.delete(keyOf(ctx));
    await ctx.api.sendChatAction(ctx.chat.id, 'typing').catch(noop);
    try { const v = await creatorHome(ctx, 'panel'); return ctx.reply(v.text, { reply_markup: v.kb }); }
    catch (e) { console.error('/panel failed:', e); return ctx.reply('প্যানেল খুলতে সমস্যা হয়েছে। একটু পরে আবার চেষ্টা করো।'); }
  });
  // Private-chat /settings (called from features.js): Owner sees all groups, everyone else only own verified groups.
  hooks.privateSettings = async ctx => {
    pending.delete(keyOf(ctx));
    try {
      if (isOwner(ctx)) { const v = groupsView(0, 's'); return ctx.reply(v.text, { reply_markup: v.kb }); }
      await ctx.api.sendChatAction(ctx.chat.id, 'typing').catch(noop);
      const v = await creatorHome(ctx, 'settings');
      return ctx.reply(v.text, { reply_markup: v.kb });
    } catch (e) { console.error('Private /settings failed:', e); return ctx.reply('সেটিংস খুলতে সমস্যা হয়েছে। একটু পরে আবার চেষ্টা করো।'); }
  };
  hooks.settingsRows = (kb, chatId) => {
    kb.row().text('💬 Custom Replies', `gp:cr:${chatId}`).text('ℹ️ Group Info', `gp:info:${chatId}`).row().text('⬅️ গ্রুপ তালিকা', 'gp:back');
  };

  function repliesView(chatId) {
    const list = db.customReplies[String(chatId)] || [];
    const shown = list.slice(0, 15);
    const text = `💬 Custom Replies — ${extra.groupTitle(chatId)}\n\n` + (shown.map((x, i) => `${i + 1}. ${short(x.trigger, 40)} → ${short(x.reply, 80)}`).join('\n') || 'এখনো কোনো Custom Reply নেই।') + (list.length > shown.length ? `\n… আরও ${list.length - shown.length}টি (শুধু প্রথম ${shown.length}টি দেখানো হলো)` : '') + '\n\nএই Reply শুধু এই গ্রুপে কাজ করবে।';
    const kb = new InlineKeyboard().text('➕ নতুন Reply', `gp:cra:${chatId}`).row();
    shown.forEach((x, i) => kb.text(`🗑 ${i + 1}`, `gp:crd:${chatId}:${i}:${hash6(x.trigger)}`));
    kb.row().text('⬅️ সেটিংস মেনু', `gp:s:${chatId}`);
    return { text, kb };
  }
  async function infoView(api, chatId) {
    const g = db.groups[String(chatId)] || {};
    let members = '—', botStatus = '—';
    try { members = await api.getChatMemberCount(chatId); } catch (e) { console.error('Member count failed:', e.message); }
    try { const me = await api.getChatMember(chatId, getBotInfo().id); botStatus = me.status === 'administrator' ? 'Admin ✅' : me.status; } catch (e) { console.error('Bot status failed:', e.message); }
    const text = [`ℹ️ Group Info — ${g.title || chatId}`, '', `🆔 Group ID: ${chatId}`, `👥 সদস্য: ${members}`, `🤖 বটের অবস্থা: ${botStatus}`,
      `💬 Custom Reply: ${(db.customReplies[String(chatId)] || []).length}টি`, `📅 বট যুক্ত (রেজিস্টার): ${fmt(g.firstSeen)}`,
      '', 'বটকে Admin রাখলে Creator যাচাই ও Auto Reply/Reaction সবচেয়ে ভালো কাজ করে।'].join('\n');
    return { text, kb: new InlineKeyboard().text('⬅️ সেটিংস মেনু', `gp:s:${chatId}`) };
  }
  async function creatorBack(ctx) {
    if (isOwner(ctx)) return groupsView(0, 's');
    return creatorHome(ctx, 'settings');
  }

  bot.callbackQuery(/^gp:([a-z]+)(?::(-?\d+))?(?::(\d+):([0-9a-f]{6}))?$/, async ctx => {
    const [, act, chatIdStr, idxStr, h] = ctx.match;
    if (!isPrivate(ctx)) return ctx.answerCallbackQuery({ text: 'এই প্যানেল শুধু Private Chat-এ চলে।', show_alert: true });
    const k = keyOf(ctx);
    if (act === 'back') { await ctx.answerCallbackQuery().catch(noop); const v = await creatorBack(ctx); return edit(ctx, v.text, v.kb); }
    if (act === 'ref') {
      const last = cooldown.get(String(ctx.from.id)) || 0;
      if (Date.now() - last < 20 * 1000) return ctx.answerCallbackQuery({ text: 'একটু পরে আবার চেষ্টা করো (২০ সেকেন্ড)।', show_alert: true });
      cooldown.set(String(ctx.from.id), Date.now());
      await ctx.answerCallbackQuery({ text: 'যাচাই করা হচ্ছে...' }).catch(noop);
      const v = await creatorHome(ctx, 'panel', true); return edit(ctx, v.text, v.kb);
    }
    if (chatIdStr === undefined) return ctx.answerCallbackQuery({ text: 'অজানা বাটন।' });
    const chatId = Number(chatIdStr);
    // Server-side permission check for the chosen group: Owner or the real Telegram creator of THAT group, verified live.
    const perm = await extra.canManageChat(ctx, chatId);
    if (!perm.allowed) {
      return ctx.answerCallbackQuery({ text: perm.error ? 'Telegram থেকে Creator পরিচয় যাচাই করা যায়নি। বটটি গ্রুপে আছে কি না দেখো।' : '🚫 তুমি এই গ্রুপের প্রকৃত Creator নও।', show_alert: true });
    }
    await ctx.answerCallbackQuery().catch(noop);
    if (act === 's') { pending.delete(k); const v = extra.renderSettings(chatId, true); return edit(ctx, v.text, v.kb); }
    if (act === 'info') { const v = await infoView(ctx.api, chatId); return edit(ctx, v.text, v.kb); }
    if (act === 'cr') { const v = repliesView(chatId); return edit(ctx, v.text, v.kb); }
    if (act === 'cra') {
      pending.set(k, { type: 'cradd', step: 'trigger', chatId, userId: ctx.from.id });
      return ctx.reply(`💬 ${extra.groupTitle(chatId)} — কোন শব্দ/মেসেজের জন্য Reply সেট করতে চাও? Trigger পাঠাও।\nবাতিল: /cancel`);
    }
    if (act === 'crd') {
      const list = db.customReplies[String(chatId)] || [];
      const i = Number(idxStr);
      if (!list[i] || hash6(list[i].trigger) !== h) { const v = repliesView(chatId); await edit(ctx, v.text, v.kb); return ctx.reply('তালিকা বদলে গেছে, আবার দেখে নাও।'); }
      list.splice(i, 1); db.customReplies[String(chatId)] = list;
      try { await saveDb(); } catch (e) { console.error('Reply delete save failed:', e.message); return ctx.reply('সংরক্ষণ করা যায়নি। Render Logs দেখো।'); }
      const v = repliesView(chatId); return edit(ctx, v.text, v.kb);
    }
    return undefined;
  });

  // ---------- message flows for the new panels ----------
  function installFlows() {
    bot.on('message', async (ctx, next) => {
      const msg = ctx.msg;
      const text = msg.text || msg.caption || '';
      const flow = pending.get(keyOf(ctx));
      if (!flow || !['admfind', 'admban', 'admunban', 'cradd'].includes(flow.type) || (text && text.startsWith('/'))) return next();
      const k = keyOf(ctx);
      if (!isPrivate(ctx)) return;

      if (flow.type === 'cradd') {
        if (!text.trim()) return ctx.reply('শুধু লেখা পাঠাও।');
        const perm = await extra.canManageChat(ctx, flow.chatId);
        if (!perm.allowed) { pending.delete(k); return ctx.reply('🚫 এই গ্রুপে পরিবর্তনের অনুমতি নেই।'); }
        if (flow.step === 'trigger') { flow.trigger = text.trim(); flow.step = 'reply'; pending.set(k, flow); return ctx.reply('এই Trigger-এর জন্য বট কী উত্তর দেবে? Reply পাঠাও।'); }
        const cid = String(flow.chatId);
        const list = db.customReplies[cid] || [];
        const i = list.findIndex(x => norm(x.trigger) === norm(flow.trigger));
        const item = { trigger: flow.trigger, reply: text.trim() };
        if (i >= 0) list[i] = item; else list.push(item);
        db.customReplies[cid] = list; pending.delete(k);
        try { await saveDb(); } catch (e) { console.error('Custom reply save failed:', e.message); return ctx.reply('সংরক্ষণ করা যায়নি। Render Logs দেখো।'); }
        const v = repliesView(flow.chatId);
        await ctx.reply(`✅ সেট হয়েছে!\nTrigger: ${item.trigger}\nReply: ${item.reply}`);
        return ctx.reply(v.text, { reply_markup: v.kb });
      }

      // everything below is Master-only
      if (!isMaster(ctx)) { pending.delete(k); return; }
      const id = resolveUser(text);
      if (!id) return ctx.reply('সঠিক numeric Telegram ID অথবা (বটের ইউজার হলে) @username দাও।');
      if (flow.type === 'admfind') {
        pending.delete(k);
        if (!db.users[id] && !db.banned[id]) { return ctx.reply(`ID ${id} বটের ইউজার তালিকায় নেই। তবু Ban/Unban করতে চাইলে 🚫 Ban / Unban মেনু ব্যবহার করো।`, { reply_markup: new InlineKeyboard().text('🚫 Ban মেনু', 'adm:ban').text('⬅️ মূল মেনু', 'adm:home') }); }
        const v = userView(id); return ctx.reply(v.text, { reply_markup: v.kb });
      }
      pending.delete(k);
      const r = flow.type === 'admban' ? await doBan(ctx, id) : await doUnban(id);
      if (!r.ok) return ctx.reply(r.message);
      const v = userView(id);
      return ctx.reply(`${flow.type === 'admban' ? (r.already ? 'ইনি আগে থেকেই Ban ছিলেন।' : '🚫 Ban করা হয়েছে।') : (r.already ? 'ইনি Ban ছিলেন না।' : '✅ Unban করা হয়েছে।')}\n\n${v.text}`, { reply_markup: v.kb });
    });
  }

  function start(api) {
    backfillCreators(api).catch(logErr('Creator backfill crashed'));
  }
  return { installFlows, start, isBanned, refreshCreator, eligibleGroups };
};
