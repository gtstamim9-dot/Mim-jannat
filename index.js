require('dotenv').config();
const { Bot, InlineKeyboard } = require('grammy');
const { run, sequentialize } = require('@grammyjs/runner');
const express = require('express');
const fs = require('fs');
const path = require('path');
const { OWNER_TELEGRAM_ID, BRAND_NAME, BOT_NAME, BOT_VERSION } = require('./config');
const createPermissionService = require('./permissions');
const { systemPrompt, ensureEmoji, CREATOR_ANSWER } = require('./personality');

const BOT_TOKEN = process.env.BOT_TOKEN;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL = (process.env.OPENROUTER_MODEL || '').trim() || 'openai/gpt-4o-mini'; // optional override; default unchanged
const OPENROUTER_FALLBACK_MODEL = (process.env.OPENROUTER_FALLBACK_MODEL || '').trim(); // optional: second model tried when the main one fails
const AI_MAX_TOKENS = Math.max(200, Math.min(4000, Number(process.env.AI_MAX_TOKENS) || 900)); // reply length limit (was 500)
// Single source of truth: config.js. OWNER_ID is not accepted as an override.
if (process.env.OWNER_ID && String(process.env.OWNER_ID).trim() !== OWNER_TELEGRAM_ID) {
  console.warn('OWNER_ID does not match config.js and is ignored. Update config.js only after verifying the Telegram ID.');
}
const permissions = createPermissionService({ ownerId: OWNER_TELEGRAM_ID });
const PORT = Number(process.env.PORT || 10000);
// Attach a Render Persistent Disk at this path for data that survives deploys.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'bot-data.json');
if (!BOT_TOKEN) throw new Error('BOT_TOKEN is missing. Set it in Render Environment.');
if (!OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY is missing. Set it in Render Environment.');
fs.mkdirSync(DATA_DIR, { recursive: true });

const emptyDb = () => ({
  ownerId: OWNER_TELEGRAM_ID,
  customReplies: {},
  conversations: {},
  welcome: {
    enabled: true,
    text: 'আসসালামু আলাইকুম! 🌸\nআমাদের গ্রুপে তোমাকে স্বাগতম। সবার সঙ্গে সুন্দরভাবে কথা বলো এবং আনন্দে থাকো।'
  }
});

let corruptDbNote = ''; // set when the data file was unreadable: the bot then tries the Telegram backup instead of crashing
let freshDb = false; // true when no data file existed at startup (e.g. a new/temporary disk) -> try the Telegram backup
function loadDb() {
  try {
    const saved = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    return {
      ...emptyDb(),
      ...saved,
      // Owner is intentionally immutable and does not come from the data file.
      ownerId: OWNER_TELEGRAM_ID,
      customReplies: saved.customReplies && typeof saved.customReplies === 'object' ? saved.customReplies : {},
      conversations: saved.conversations && typeof saved.conversations === 'object' ? saved.conversations : {},
      welcome: {
        ...emptyDb().welcome,
        ...(saved.welcome && typeof saved.welcome === 'object' ? saved.welcome : {})
      }
    };
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error('Database load failed; refusing to overwrite unreadable data:', error.message);
      try {
        if (fs.existsSync(DB_FILE)) {
          fs.copyFileSync(DB_FILE, DB_FILE + '.corrupt-' + Date.now() + '.bak');
        }
      } catch (backupError) {
        console.error('Database backup failed:', backupError.message);
      }
    }
    if (error.code !== 'ENOENT') corruptDbNote = `ডেটা ফাইল নষ্ট ছিল (${error.message}); নষ্ট কপি ${path.basename(DB_FILE)}.corrupt-*.bak নামে সংরক্ষিত আছে।`;
    freshDb = true;
    return emptyDb();
  }
}

let db = loadDb();
let backup = null; // created right after the bot object exists
const INSTANCE_ID = Math.random().toString(16).slice(2, 8);
const BOOT_AT = Date.now();

// Writes are coalesced: while one write is running, every further saveDb() call shares ONE follow-up write (latest data),
// so a burst of messages no longer re-serialises and rewrites the whole file for each message.
let saveRunning = null, savePending = null;
async function doSave() {
  const snapshot = JSON.stringify({ ...db, ownerId: OWNER_TELEGRAM_ID }); // compact: smaller file and less CPU
  try {
    await fs.promises.mkdir(DATA_DIR, { recursive: true });
    const tmp = DB_FILE + `.${process.pid}.tmp`;
    await fs.promises.writeFile(tmp, snapshot, 'utf8');
    await fs.promises.rename(tmp, DB_FILE);
    if (backup) backup.markDirty();
  } catch (error) { console.error('Database save FAILED (' + DB_FILE + '):', error.message); throw error; }
}
function saveDb() {
  if (!saveRunning) {
    saveRunning = doSave().finally(() => { saveRunning = null; });
    return saveRunning;
  }
  if (!savePending) {
    savePending = saveRunning.catch(() => {}).then(() => { savePending = null; return saveDb(); });
  }
  return savePending;
}

const SCHEMA_VERSION = 3; // 1 = v1.x, 2 = v2.0 premium, 3 = v2.1 (adds goodbye, warn action/minutes, extra stats) — all additive
async function backupDbBeforeUpgrade() {
  if (!fs.existsSync(DB_FILE)) return null;
  const backup = DB_FILE + `.preupgrade-${new Date().toISOString().replace(/[:.]/g, '-')}.bak`;
  await fs.promises.copyFile(DB_FILE, backup, fs.constants.COPYFILE_EXCL);
  console.log(`Pre-upgrade database backup created: ${backup}`);
  try { // keep only the 10 newest pre-upgrade backups so the disk does not fill up
    const prefix = path.basename(DB_FILE) + '.preupgrade-';
    const old = fs.readdirSync(DATA_DIR).filter(f => f.startsWith(prefix)).sort();
    for (const f of old.slice(0, Math.max(0, old.length - 10))) fs.unlinkSync(path.join(DATA_DIR, f));
  } catch (e) { console.error('Backup pruning skipped:', e.message); }
  return backup;
}

const bot = new Bot(BOT_TOKEN);
// Telegram flood limits (HTTP 429): wait and retry automatically instead of losing the message. Optional dependency, never fatal.
try { const { autoRetry } = require('@grammyjs/auto-retry'); if (bot.api && bot.api.config && bot.api.config.use) bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 15 })); }
catch (e) { console.warn('auto-retry not active:', e.message); }
// Preserve each user's message order while allowing different users to be processed concurrently.
bot.use(sequentialize(ctx => {
  const chatId = ctx.chat?.id?.toString();
  const userId = ctx.from?.id?.toString();
  return chatId && userId ? [`${chatId}:${userId}`] : [];
}));
backup = require('./backup')({ bot, db, ownerId: OWNER_TELEGRAM_ID, token: BOT_TOKEN });
let botInfo;
// Map whose entries expire when not touched: unfinished /set /baton /send flows are dropped after 30 min, previews after 1 h.
class TtlMap extends Map {
  constructor(ttlMs) { super(); this.ttlMs = ttlMs; this.times = new Map(); }
  set(k, v) { this.times.set(k, Date.now()); return super.set(k, v); }
  delete(k) { this.times.delete(k); return super.delete(k); }
  sweep() { const now = Date.now(); for (const [k, t] of this.times) if (now - t > this.ttlMs) this.delete(k); }
}
const stickerReplier = require('./stickers')();
const pending = new TtlMap(30 * 60 * 1000);
const jobs = new TtlMap(60 * 60 * 1000);
const sweepTimer = setInterval(() => { pending.sweep(); jobs.sweep(); }, 5 * 60 * 1000); sweepTimer.unref?.();
const keyOf = ctx => `${ctx.chat.id}:${ctx.from.id}`;
const isPrivate = ctx => ctx.chat?.type === 'private';
const isGroup = ctx => ['group', 'supergroup'].includes(ctx.chat?.type);
const isOwner = ctx => Boolean(ctx.from && permissions.isOwnerId(ctx.from.id));
const isCommand = t => typeof t === 'string' && t.startsWith('/');
const nameOf = ctx => [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(' ') || 'বন্ধু';
const norm = s => String(s || '').toLocaleLowerCase('en-US').normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/[.,!?;:،؛؟…。、]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/([a-z])\1{2,}/g, '$1$1');

const DEFAULTS = [
  { keys: ['hi','hii','hiii','hello','helloo','hey','heyy','হাই','হাইই'], reply: 'হ্যালো! 🌸 কেমন আছেন?' },
  { keys: ['আসসালামু আলাইকুম','আসসালামুয়ালাইকুম','সালাম','সালাম আলাইকুম'], reply: 'ওয়ালাইকুমুস সালাম! 🌸 কেমন আছেন? 🤍' },
  { keys: ['কেমন আছো','কেমন আছো ভাই','কেমন আছেন','how are you','how r u'], reply: 'আলহামদুলিল্লাহ ভালো আছি! 🤍 আপনি কেমন আছেন?' },
  { keys: ['good morning','শুভ সকাল'], reply: 'শুভ সকাল! 🌷 দিনটি সুন্দর কাটুক।' },
  { keys: ['good afternoon','শুভ দুপুর'], reply: 'শুভ দুপুর! 🍃' },
  { keys: ['good evening','শুভ সন্ধ্যা'], reply: 'শুভ সন্ধ্যা! 🌆' },
  { keys: ['good night','শুভ রাত্রি','শুভরাত্রি'], reply: 'শুভ রাত্রি! ভালো থাকবেন। 🌙' },
  { keys: ['bye','goodbye','বাই','আল্লাহ হাফেজ'], reply: 'আল্লাহ হাফেজ! আবার কথা হবে ইনশাআল্লাহ। 🤍' },
  { keys: ['ধন্যবাদ','থ্যাংক ইউ','thank you','thanks'], reply: 'আপনাকে স্বাগতম! 🌸 আলহামদুলিল্লাহ, কাজে আসতে পেরেছি। 🤍' },
  { keys: ['কি খবর','কী খবর',"what's up"], reply: 'আলহামদুলিল্লাহ সব ভালো! 🌷 আপনার কী খবর?' },
  { keys: ['কে তুমি','তোমার নাম কি','তোমার নাম কী','who are you'], reply: 'আমি Mim Jannat! 🌸 ' + CREATOR_ANSWER },
  { keys: ['মাশাআল্লাহ','মাশাল্লাহ','মাশা আল্লাহ'], reply: 'আলহামদুলিল্লাহ! 🤍' },
  { keys: ['ইনশাআল্লাহ','ইনশাল্লাহ'], reply: 'ইনশাআল্লাহ। 🤍' }
];
// Conversation memory helpers (each person has a separate memory per chat).
const HISTORY_KEEP = 30;     // messages stored per person
const HISTORY_SEND = 24;     // messages sent to the AI each time
const RECENT_MS = 20 * 60 * 1000;
const convKeyOf = ctx => isPrivate(ctx) ? `private:${ctx.from.id}` : `group:${ctx.chat.id}:${ctx.from.id}`;
// AI memory of people inactive for 90+ days is removed (keeps the data file and Telegram backup small). Active people are never touched.
const MEMORY_MAX_AGE_MS = 90 * 24 * 3600 * 1000;
function pruneOldConversations() {
  if (!db.convTimes) return 0;
  const now = Date.now(); let n = 0;
  for (const key of Object.keys(db.conversations)) {
    const t = db.convTimes[key];
    if (t && now - t > MEMORY_MAX_AGE_MS) { delete db.conversations[key]; delete db.convTimes[key]; n++; }
  }
  for (const key of Object.keys(db.convTimes)) if (!db.conversations[key]) delete db.convTimes[key];
  if (n) { console.log(`Pruned ${n} inactive AI memories (90+ days).`); saveDb().catch(e => console.error('Prune save failed:', e.message)); }
  return n;
}
function hasRecentChat(key) {
  const t = db.convTimes && db.convTimes[key];
  return Boolean(t && Date.now() - t < RECENT_MS && (db.conversations[key] || []).length);
}
// Saves a fixed (non-AI) exchange into memory so the AI knows it was already said.
function rememberTurn(key, userText, botText) {
  const history = (db.conversations[key] || []).slice();
  history.push({ role: 'user', content: String(userText).slice(0, 3000) });
  history.push({ role: 'assistant', content: String(botText).slice(0, 3000) });
  db.conversations[key] = history.slice(-HISTORY_KEEP);
  db.convTimes = db.convTimes || {};
  db.convTimes[key] = Date.now();
  saveDb().catch(error => console.error('Conversation save failed:', error.message));
}
function fixedReply(chatId, text, key) {
  const n = norm(text);
  const custom = db.customReplies[String(chatId)] || [];
  const found = custom.find(x => norm(x.trigger) === n);
  if (found) return found.reply;
  // Default greetings are skipped in the middle of a running conversation, so the AI continues naturally.
  if (key && hasRecentChat(key)) return null;
  const base = DEFAULTS.find(x => x.keys.some(k => norm(k) === n));
  return base?.reply || null;
}
// Central fail-closed permission checks. Anonymous senders never receive inferred creator access.
async function groupCreatorCheck(ctx) {
  if (!ctx || !ctx.chat || !ctx.from) return { allowed:false, error:new Error('Missing group/user context'), unverified:true };
  const result = await permissions.verifyGroupCreator(ctx.api, ctx.chat.id, ctx.from.id);
  return { ...result, unverified:!result.verified };
}
async function canManageGroup(ctx) {
  if (isOwner(ctx)) return { allowed:true, error:null, role:'bot_creator', verified:true };
  return groupCreatorCheck(ctx);
}
function permissionFailure(ctx, result) {
  if (result && (result.unverified || result.error)) {
    return ctx.reply('Telegram থেকে এই গ্রুপের প্রকৃত Creator যাচাই করা যায়নি। নিরাপত্তার জন্য Access দেওয়া হয়নি। বটের Admin status ও Telegram API সংযোগ পরীক্ষা করে আবার চেষ্টা করো।');
  }
  if (ctx.from && String(ctx.from.id) === '1087968824') return ctx.reply('আপনি "Anonymous Admin" হিসেবে লিখছেন, তাই Telegram আপনার পরিচয় জানায় না। গ্রুপের Admin Rights থেকে "Remain Anonymous" বন্ধ করে আবার চেষ্টা করুন।');
  return ctx.reply('এই কাজটি শুধু Bot Creator অথবা সংশ্লিষ্ট গ্রুপের প্রকৃত Creator করতে পারবেন।');
}

// ---- v1.8 add-on module (broadcast, force join, group settings, registry) ----
const hooks = {}; // filled by panels.js (ban guard, private /settings, panel rows)
const extra = require('./features')({
  bot, db, saveDb, pending, keyOf, isOwner, isPrivate, isGroup, isCommand,
  canManageGroup, permissionFailure, getBotInfo: () => botInfo, ownerId: OWNER_TELEGRAM_ID, permissions, hooks
});
extra.installEarly();
// ---- v2.0 additive Premium modules (legacy handlers and data remain in place) ----
const premium = require('./premium')({
  bot, db, saveDb, pending, keyOf, isOwner, isPrivate, isGroup, extra, permissions, hooks, getBotInfo: () => botInfo
});
// ---- v2.1 additive module: warning/filter/welcome/goodbye/schedule managers, /schedule /warnings /health ----
const premiumExtra = require('./premium-extra')({
  bot, db, saveDb, pending, keyOf, isOwner, isPrivate, isGroup, permissions, premium, getBotInfo: () => botInfo, startedAt: Date.now(), dbFile: DB_FILE,
  healthInfo: () => `Instance: ${INSTANCE_ID} (চালু হয়েছে ${new Date(BOOT_AT).toLocaleString('en-GB', { timeZone: 'Asia/Dhaka' })})\n${backup.status()}\n💡 /health দুইবার দিন — Instance ID বদলালে বটের দুটি কপি চলছে (একই BOT_TOKEN দুই জায়গায়)।`
});
// ---- v1.9 add-on module (Master Admin Panel, Group Owner Panel, ban, global settings) ----
const panels = require('./panels')({
  bot, db, saveDb, pending, keyOf, isOwner, isPrivate, isGroup, norm, extra, hooks, permissions,
  getBotInfo: () => botInfo, ownerId: OWNER_TELEGRAM_ID
});

async function askAI(messages, name, inGroup, model = OPENROUTER_MODEL) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);
  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': String(process.env.RENDER_EXTERNAL_URL || process.env.SELF_URL || (botInfo ? `https://t.me/${botInfo.username}` : 'https://t.me')),
        'X-Title': 'Mim Jannat Telegram Bot'
      },
      body: JSON.stringify({
        model,
        messages: [{
          role: 'system',
          content: systemPrompt(name, inGroup)
        }, ...messages],
        temperature: 0.8,
        frequency_penalty: 0.4,
        presence_penalty: 0.3,
        max_tokens: AI_MAX_TOKENS
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = data.error?.message || `OpenRouter HTTP ${response.status}`;
      const apiError = new Error(detail);
      apiError.retryable = response.status === 429 || response.status >= 500;
      throw apiError;
    }
    const answer = data.choices?.[0]?.message?.content;
    if (typeof answer !== 'string' || !answer.trim()) throw new Error('OpenRouter returned an empty response');
    return answer.trim();
  } catch (error) {
    if (error.name === 'AbortError') {
      const timeoutError = new Error('AI request timed out after 25 seconds');
      timeoutError.retryable = true;
      throw timeoutError;
    }
    if (error instanceof TypeError) error.retryable = true; // network failure
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
// One automatic retry for timeouts, network errors, HTTP 429 and 5xx.
async function askAIRetryMain(messages, name, inGroup) {
  try { return await askAI(messages, name, inGroup); }
  catch (error) {
    if (!error.retryable) throw error;
    console.error('AI request failed, retrying once:', error.message);
    await new Promise(resolve => setTimeout(resolve, 1500));
    return askAI(messages, name, inGroup);
  }
}
// If an optional fallback model is configured (OPENROUTER_FALLBACK_MODEL), it is tried once when the main model still fails.
async function askAIRetry(messages, name, inGroup) {
  try { return await askAIRetryMain(messages, name, inGroup); }
  catch (error) {
    if (!OPENROUTER_FALLBACK_MODEL || OPENROUTER_FALLBACK_MODEL === OPENROUTER_MODEL) throw error;
    console.error(`Main AI model failed (${error.message}); trying fallback model ${OPENROUTER_FALLBACK_MODEL}`);
    return askAI(messages, name, inGroup, OPENROUTER_FALLBACK_MODEL);
  }
}
// ---- Every kind of message gets an answer: text, photo, sticker, voice, video, GIF, file, location, contact, poll ... ----
// Turns a non-text message into a short Bengali description so the AI can answer it naturally (the caption is kept).
function incoming(msg, captionOverride) {
  const caption = String(captionOverride !== undefined ? captionOverride : (msg.caption || '')).trim();
  if (msg.text) return { text: String(captionOverride !== undefined ? captionOverride : msg.text), image: null };
  let what = null, image = null;
  if (msg.photo && msg.photo.length) {
    what = 'একটি ছবি পাঠিয়েছে';
    const fit = msg.photo.filter(p => !p.file_size || p.file_size <= 4 * 1024 * 1024);
    image = (fit.length ? fit[fit.length - 1] : msg.photo[0]).file_id;
  } else if (msg.sticker) {
    what = `একটি স্টিকার পাঠিয়েছে${msg.sticker.emoji ? ` (${msg.sticker.emoji})` : ''}`;
    if (!msg.sticker.is_animated && !msg.sticker.is_video) image = msg.sticker.file_id;
  } else if (msg.animation) what = 'একটি GIF পাঠিয়েছে';
  else if (msg.video) what = 'একটি ভিডিও পাঠিয়েছে (ভেতরের কথা বা দৃশ্য তুমি দেখতে পাচ্ছো না)';
  else if (msg.video_note) what = 'একটি ভিডিও মেসেজ পাঠিয়েছে (তুমি দেখতে পাচ্ছো না)';
  else if (msg.voice) what = 'একটি ভয়েস মেসেজ পাঠিয়েছে (তুমি শুনতে পাচ্ছো না)';
  else if (msg.audio) what = `একটি অডিও পাঠিয়েছে${msg.audio.title ? ` (${msg.audio.title})` : ''} (তুমি শুনতে পাচ্ছো না)`;
  else if (msg.document) what = `একটি ফাইল পাঠিয়েছে${msg.document.file_name ? ` (${msg.document.file_name})` : ''} (ফাইলের ভেতরটা তুমি দেখতে পাচ্ছো না)`;
  else if (msg.location || msg.venue) what = 'একটি লোকেশন পাঠিয়েছে';
  else if (msg.contact) what = 'একটি Contact পাঠিয়েছে';
  else if (msg.poll) what = `একটি Poll পাঠিয়েছে${msg.poll.question ? `: ${msg.poll.question}` : ''}`;
  else if (msg.dice) what = `একটি ${msg.dice.emoji || ''} গেম/ডাইস পাঠিয়েছে (ফল: ${msg.dice.value})`;
  if (!what) return { text: '', image: null };
  return { text: `(ব্যবহারকারী ${what})${caption ? ' ' + caption : ''}`, image };
}
// Downloads a Telegram image and returns a data URL (the bot token never leaves this server). Null when not possible.
async function imageDataUrl(api, fileId) {
  try {
    const f = await api.getFile(fileId);
    if (!f || !f.file_path || (f.file_size && f.file_size > 5 * 1024 * 1024)) return null;
    const res = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${f.file_path}`, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    const ext = String(f.file_path).split('.').pop().toLowerCase();
    const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif' : 'image/jpeg';
    return `data:${mime};base64,${Buffer.from(await res.arrayBuffer()).toString('base64')}`;
  } catch (e) { console.error('Image download failed:', e.message); return null; }
}
async function aiReply(ctx, text, key, imageFileId) {
  const stored = (db.conversations[key] || []).slice();
  const history = stored.slice(-HISTORY_SEND);
  const userText = text.slice(0, 3000);
  await ctx.api.sendChatAction(ctx.chat.id, 'typing').catch(() => {});
  const dataUrl = imageFileId ? await imageDataUrl(ctx.api, imageFileId) : null;
  let raw;
  if (dataUrl) {
    const withImage = [...history, { role: 'user', content: [{ type: 'text', text: userText }, { type: 'image_url', image_url: { url: dataUrl } }] }];
    try { raw = await askAIRetry(withImage, nameOf(ctx), isGroup(ctx)); }
    catch (e) { console.error('Vision request failed, answering from the description only:', e.message); }
  }
  if (raw === undefined) raw = await askAIRetry([...history, { role: 'user', content: userText }], nameOf(ctx), isGroup(ctx));
  const answer = ensureEmoji(raw, text);
  stored.push({ role: 'user', content: userText });
  stored.push({ role: 'assistant', content: answer });
  db.conversations[key] = stored.slice(-HISTORY_KEEP);
  db.convTimes = db.convTimes || {};
  db.convTimes[key] = Date.now();
  await saveDb().catch(error => console.error('Conversation save failed:', error.message));
  await ctx.reply(answer, { reply_parameters: { message_id: ctx.msg.message_id, allow_sending_without_reply: true } });
}
// Only emojis from Telegram's allowed reaction list work (e.g. ✨ is not allowed).
const REACTIONS = ['❤','👍','🔥','🥰','😍','💯','🤩','👏','🙏','💘','😘','🤗'];
const pickReaction = () => REACTIONS[Math.floor(Math.random() * REACTIONS.length)];
const reactBlockedUntil = new Map(); // chatId -> time until which reactions are skipped (rate limit / reactions not allowed)
async function maybeReact(ctx) {
  if (isGroup(ctx) && !extra.groupSetting(ctx.chat.id, 'react')) return;
  if (Date.now() < (reactBlockedUntil.get(ctx.chat.id) || 0)) return;
  const emoji = pickReaction();
  await ctx.api.setMessageReaction(ctx.chat.id, ctx.msg.message_id, [{ type: 'emoji', emoji }]).catch(e => {
    const desc = String(e.description || e.message || '');
    if (e.error_code === 429) reactBlockedUntil.set(ctx.chat.id, Date.now() + (((e.parameters && e.parameters.retry_after) || 10) + 1) * 1000);
    else if (/REACTION_INVALID|reactions? (are|is) (not allowed|disabled)|not enough rights|CHAT_ADMIN_REQUIRED/i.test(desc)) reactBlockedUntil.set(ctx.chat.id, Date.now() + 10 * 60 * 1000);
    console.error('Reaction unavailable:', desc);
  });
}

const OWNER_ONLY_HELP = ['owner', 'button', 'broadcast', 'forcejoin', 'admin', 'welcome'];
function helpKeyboard(owner) {
  const kb = new InlineKeyboard();
  if (owner) {
    kb.text('👑 Owner Commands', 'help:owner').row()
      .text('👥 Group Commands', 'help:group').row()
      .text('🌸 Welcome Settings', 'help:welcome').row()
      .text('🔘 Button Message', 'help:button').row()
      .text('🤖 AI & Auto Reply', 'help:ai').row()
      .text('📢 /All Broadcast', 'help:broadcast').row()
      .text('🔒 Force Join', 'help:forcejoin').row()
      .text('⚙️ Group Settings', 'help:settings').row()
      .text('🛡 Master Admin Panel', 'help:admin').row();
  } else {
    kb.text('🤖 AI & Auto Reply', 'help:ai').row()
      .text('👥 Group Creator Guide', 'help:group').row()
      .text('⚙️ Group Settings', 'help:settings').row();
  }
  kb.text('🧰 Group Owner Panel', 'help:panel').row()
    .text('👑 Premium Group Dashboard', 'help:premium').row()
    .text('👑 Bot Creator', 'help:creator').row()
    .text('❌ বন্ধ করুন', 'help:close');
  return kb;
}
// Texts for everyone except the Bot Creator: no Owner/Master Admin commands are ever mentioned.
const USER_HELP = {
  home: '📚 MIM JANNAT BOT — ব্যবহার নির্দেশিকা\n👑 Bot Creator: GTS Tarek\nনিচের বাটনে চাপ দিয়ে জেনে নিন আমি কী কী করতে পারি। 🌸',
  ai: '🤖 AI & AUTO REPLY\n\nPrivate Chat-এ সাধারণ মেসেজ লিখলে আমি উত্তর দেব।\nগ্রুপে আমাকে @mention করলে অথবা আমার মেসেজে Reply করলে উত্তর দেব।\nHi, সালাম, কেমন আছেন — এমন কিছু কথার ছোট Auto Reply আছে। 🌷',
  group: '👥 GROUP CREATOR GUIDE\n\nএই কমান্ডগুলো কাজ করে শুধু সংশ্লিষ্ট গ্রুপের প্রকৃত Creator-এর জন্য (Telegram থেকে যাচাই হয়):\n/set — Trigger ও Reply তৈরি\n/list — সব Custom Reply\n/del 1 — ১ নম্বর Reply মুছুন\n/warn /unwarn /warnings /mute /unmute /ban /unban — সদস্যের মেসেজে Reply করে\n/premium — Premium Dashboard\n/cancel — চলমান কাজ বাতিল\n/id — আপনার ও Chat-এর ID',
  settings: '⚙️ GROUP SETTINGS\n\nগ্রুপের প্রকৃত Creator গ্রুপে /settings লিখে AI Reply, Auto Reply, Reactions ও Welcome চালু/বন্ধ করতে পারেন। প্রতিটি গ্রুপের সেটিংস আলাদা।\nPrivate Chat-এ /settings বা /panel দিলে আপনার নিজের গ্রুপগুলোর তালিকা আসে।',
  panel: '🧰 GROUP OWNER PANEL — /panel\n\nবটের Private Chat-এ /panel লিখুন। Telegram থেকে যাচাই করা আপনার নিজের গ্রুপগুলো দেখাবে; গ্রুপ বেছে সেটিংস, Welcome ও Custom Reply পরিচালনা করুন। অন্য গ্রুপের সেটিংস দেখা বা বদলানো যায় না।'
};
const HELP = {
  home: '📚 MIM JANNAT BOT — সম্পূর্ণ ব্যবহার নির্দেশিকা\n👑 Bot Creator: GTS Tarek\nনিচের বাটনে চাপ দিয়ে যে ফিচারটি জানতে চাও সেটি বেছে নাও। প্রতিটি বিভাগে কোথায় কমান্ড দিতে হবে এবং ধাপে ধাপে কী করতে হবে লেখা আছে।',
  owner: '👑 OWNER COMMANDS\n\n/start — Private Chat-এ বট চালু করে। শুধু নির্দিষ্ট Owner ID-র অ্যাকাউন্টে Owner সুবিধা চালু হবে।\n/help — এই নির্দেশিকা খুলবে।\n/id — নিজের Telegram ID ও বর্তমান Chat ID দেখাবে।\n/send — শুধু Owner-এর Private Chat-এ। প্রথমে মেসেজ/ছবি/ভিডিও/ভয়েস/ডকুমেন্ট পাঠাও, তারপর গ্রুপের @username বা numeric Chat ID দাও, Preview দেখে Send/Cancel চাপো।\n/baton — Button-সহ মেসেজ তৈরি করবে। ধাপে ধাপে মেসেজ, বাটনের নাম, URL, গন্তব্য ও Sender label চাইবে।',
  group: '👥 GROUP COMMANDS\n\nএই কমান্ডগুলো গ্রুপে ব্যবহার করবে। বটের Owner অথবা ওই গ্রুপের Creator ব্যবহার করতে পারবেন।\n/set — Trigger শব্দ পাঠাও, এরপর বটের নির্দিষ্ট Reply পাঠাও।\n/list — ওই গ্রুপের সব Custom Reply দেখাবে।\n/del 1 — /list-এর ১ নম্বর Reply মুছবে।\n/cancel — চলমান /set বা /send বা /baton কাজ বাতিল করবে।\n/id — গ্রুপের numeric Chat ID দেখাবে।\nনোট: বটের Owner সব গ্রুপে Custom Reply পরিচালনা করতে পারবে; অন্য সদস্যদের জন্য Telegram Group Creator Status যাচাই হবে।',
  welcome: '🌸 WELCOME SETTINGS\n\n/welcome কমান্ডটি Owner-এর Private Chat-এ দাও।\n১) Edit চাপলে নতুন Welcome Message লিখবে।\n২) বট Preview দেখাবে।\n৩) Confirm করলে নতুন মেসেজ সংরক্ষিত হবে।\n৪) ON/OFF দিয়ে নতুন সদস্যদের Welcome চালু/বন্ধ করবে।\nএটি সব গ্রুপে একই Welcome Text ব্যবহার করবে। নতুন সদস্য যোগ হলে বট গ্রুপে সেটি পাঠাবে।',
  button: '🔘 BUTTON MESSAGE — /baton\n\n১) Owner-এর Private Chat-এ /baton লিখবে।\n২) যে মেসেজটি পাঠাতে চাও সেটি পাঠাবে (text/photo/video/document ইত্যাদি)।\n৩) বাটনের নাম লিখবে।\n৪) বাটনে ক্লিক করলে যে HTTPS/Telegram URL খুলবে সেটি পাঠাবে।\n৫) প্রতিটি বাটনের রঙ বেছে নেবে: 🔵 নীল, 🟢 সবুজ, 🔴 লাল বা ⚪ ডিফল্ট। (রঙ শুধু নতুন Telegram অ্যাপে দেখা যায়।)\n৬) Destination গ্রুপের @username বা numeric Chat ID দেবে। Private invite link থেকে Chat ID বের করা যায় না।\n৭) Preview-তে মেসেজ, লিংক বাটন, Send ও Cancel দেখবে। Send চাপলে বটের অ্যাকাউন্ট থেকে গ্রুপে যাবে। Bot API দিয়ে ব্যক্তিগত Telegram account-এর হয়ে পাঠানো সম্ভব নয়।',
  broadcast: '📢 /All — GLOBAL BROADCAST (শুধু Bot Creator)\n\nOwner-এর Private Chat-এ /All লিখলে:\n১) যে মেসেজ পাঠাতে চাও সেটি পাঠাও (Text/Photo/Video/Voice/Document)।\n২) Button যোগ করবে কি না — Yes/No।\n৩) Yes হলে Button-এর নাম, URL ও রঙ দাও।\n৪) Preview দেখে ✅ Send All বা ❌ Cancel চাপো।\nমেসেজ যাবে বটকে /start করা সব User এবং বট যেসব গ্রুপে আছে সেসব গ্রুপে। শেষে Report: Total, Sent, Failed, Blocked/Unreachable। চলার সময় ⛔ Cancel Broadcast চাপা যাবে।',
  forcejoin: '🔒 FORCE JOIN\n\nসাধারণ ব্যবহারকারী ও Group Creator-কে বটের ফিচার ব্যবহারের আগে নির্ধারিত সব Channel-এ Join করে ✅ Verify চাপতে হয়। Channel ছেড়ে দিলে ফিচার আবার Lock হয়। Bot Creator-এর জন্য প্রযোজ্য নয়।\n\nOwner কমান্ড (Private Chat): /channels — Channel যোগ/মুছা, Force Join ON/OFF। বটকে আগে ওই Channel-এ Admin করতে হবে।',
  settings: '⚙️ GROUP SETTINGS\n\nগ্রুপে /settings লিখলে (শুধু ওই গ্রুপের Creator বা Owner) AI Reply, Auto Reply, Reactions ও Welcome চালু/বন্ধ করা যায়। প্রতিটি গ্রুপের সেটিংস আলাদা।\nPrivate Chat-এ /settings বা /panel দিলে নিজের (Telegram-এ যাচাই করা) গ্রুপের তালিকা আসে; গ্রুপ বেছে সব সেটিংস ও Custom Reply সেখান থেকেই বদলানো যায়।\n/welcome — গ্রুপে লিখলে ওই গ্রুপের নিজস্ব Welcome Message Edit/Preview/ON-OFF। Private Chat-এ /welcome দিয়ে নিজের গ্রুপ বেছেও করা যায়।\n/send ও /baton — Private Chat-এ ব্যবহার করে নিজের গ্রুপে মেসেজ পাঠানো যায়।',
  admin: '🛡 MASTER ADMIN PANEL — /admin (শুধু Bot Creator)\n\nBot Creator-এর Private Chat-এ /admin লিখলে আলাদা প্যানেল খোলে। অন্য কেউ ঢুকতে পারে না।\n📊 Dashboard — মোট ইউজার, মোট গ্রুপ, বর্তমানে বট যুক্ত গ্রুপ, সক্রিয় গ্রুপ।\n👥 User Management — সব ইউজারের তালিকা, তথ্য, Ban/Unban, AI মেমোরি মুছা।\n🏠 Group Management — সব গ্রুপের নাম, ID, Creator, সেটিংস; যেকোনো গ্রুপের সেটিংস/Welcome/Custom Reply পরিবর্তন।\n🚫 Ban / Unban — Ban করা ইউজার বটের কোনো ফিচার ব্যবহার করতে পারে না।\n⚙️ Global Settings — সব গ্রুপ ও ইউজারের জন্য AI, Auto Reply, Reaction, Welcome ও Maintenance Mode।\n📢 Broadcast — /All-এর মতোই। 📈 Statistics — বিস্তারিত পরিসংখ্যান।\n/settings (Private Chat) — সব গ্রুপের তালিকা থেকে একটি বেছে সেটিংস পরিবর্তন।',
  panel: '🧰 GROUP OWNER PANEL — /panel\n\nযেকোনো গ্রুপ Creator বটের Private Chat-এ /panel বা /settings লিখবে। Telegram API দিয়ে প্রকৃত Creator যাচাই হয়; শুধু তার নিজের গ্রুপগুলো দেখায়।\n১) গ্রুপ বেছে নাও।\n২) সেখানে AI Reply, Auto Reply, Reactions, Welcome (Edit/Preview/ON-OFF), Custom Replies (যোগ/মুছা) এবং Group Info পাবে।\nপ্রতিটি গ্রুপের সেটিংস আলাদা। অন্য গ্রুপ, Global Ban, /All, Token/API Key/Database/Hosting — এগুলোতে Creator-এর অধিকার নেই।\nবটকে গ্রুপে Admin রাখলে যাচাই সবচেয়ে নির্ভরযোগ্য।',
  ai: '🤖 AI & AUTO REPLY\n\nPrivate Chat-এ সাধারণ মেসেজ লিখলে AI উত্তর দেবে।\nGroup-এ শুধু বটকে @mention করলে অথবা বটের মেসেজে Reply করলে AI উত্তর দেবে।\nHi, Hello, সালাম, কেমন আছো, Good Morning ইত্যাদি নির্দিষ্ট Trigger-এ Fixed Reply দেবে।\n/set দিয়ে নিজের Trigger/Reply তৈরি করা যায়। AI চালাতে OpenRouter API Key এবং মডেল ব্যবহারের অনুমতি/ক্রেডিট লাগতে পারে।'
};

bot.command('start', async ctx => {
  if (!isPrivate(ctx)) return ctx.reply('আমাকে ব্যক্তিগত চ্যাটে /start দিন। 🌸');
  if (isOwner(ctx)) {
    const kb = new InlineKeyboard().text('🛡 Master Panel', 'adm:home').row().text('📚 Help', 'help:home').text('👑 Premium', 'help:premium');
    return ctx.reply('আসসালামু আলাইকুম, Bot Creator! 🌸\nMIM JANNAT BOT চালু আছে। 👑 GTS Tarek\nনিচের বাটন থেকে Master Panel খুলতে পারেন। 🤍', { reply_markup: kb });
  }
  return ctx.reply('আসসালামু আলাইকুম! 🌸\nআমি MIM JANNAT BOT। ' + CREATOR_ANSWER + '\nকীভাবে সাহায্য করতে পারি?', { reply_markup: new InlineKeyboard().text('📚 Help', 'help:home') });
});
bot.command('help', ctx => ctx.reply(isOwner(ctx) ? HELP.home : USER_HELP.home, { reply_markup: helpKeyboard(isOwner(ctx)) }));
bot.callbackQuery(/^help:(.+)$/, async ctx => {
  const section = ctx.match[1];
  const owner = isOwner(ctx);
  // Server-side check: hiding buttons is not security, so Owner-only sections are refused for everyone else.
  if (!owner && OWNER_ONLY_HELP.includes(section)) return ctx.answerCallbackQuery({ text: '🚫 এটি শুধু Bot Creator-এর জন্য।', show_alert: true });
  if (section === 'close') { await ctx.deleteMessage().catch(() => {}); return ctx.answerCallbackQuery(); }
  await ctx.answerCallbackQuery();
  if (section === 'home') return ctx.editMessageText(owner ? HELP.home : USER_HELP.home, { reply_markup: helpKeyboard(owner) }).catch(e => { if (!/not modified/i.test(String(e.description || e.message))) throw e; });
  if (section === 'creator') return ctx.editMessageText(`👑 Bot Creator Information\n\nOfficial Creator: GTS Tarek\nBot Name: MIM JANNAT BOT\nVersion: ${BOT_VERSION}\nCreator Status: Official Bot Creator\n\nCreator permission is verified using the configured numeric Telegram ID.`, { reply_markup:new InlineKeyboard().text('⬅️ মূল Help','help:home') }).catch(e => { if (!/not modified/i.test(String(e.description || e.message))) throw e; });
  if (section === 'premium') return premium.openSelection(ctx);
  const body = owner ? (HELP[section] || HELP.home) : (USER_HELP[section] || USER_HELP.home);
  await ctx.editMessageText(body, { reply_markup: new InlineKeyboard().text('⬅️ মূল Help', 'help:home').text('❌ বন্ধ', 'help:close') }).catch(async () => ctx.reply(body));
});
bot.command('id', async ctx => {
  let text = `এই চ্যাটের ID: ${ctx.chat.id}\nতোমার Telegram ID: ${ctx.from.id}`;
  if (isOwner(ctx)) text += '\nপরিচয়: 👑 বটের Owner';
  if (isGroup(ctx)) {
    const r = await groupCreatorCheck(ctx);
    if (r.allowed) text += '\nএই গ্রুপে: 👑 গ্রুপ Creator';
    else if (r.error || r.unverified) text += '\nএই গ্রুপে: Unverified (Telegram Creator পরিচয় যাচাই করতে পারেনি)';
    else text += '\nএই গ্রুপে: সাধারণ সদস্য/Admin (Creator নন)';
  }
  return ctx.reply(text);
});
bot.command('privacy', ctx => ctx.reply('🔐 আপনার গোপনীয়তা\n\n• আপনার সঙ্গে কথোপকথনের সাম্প্রতিক অংশ (সর্বোচ্চ ৩০টি মেসেজ) বট স্মৃতি হিসেবে রাখে, যাতে কথার সূত্র ধরে উত্তর দিতে পারে। ৯০ দিন নিষ্ক্রিয় থাকলে তা নিজে মুছে যায়।\n• উত্তর তৈরির জন্য আপনার মেসেজ (ও পাঠানো ছবি) একটি তৃতীয় পক্ষের AI সেবায় (OpenRouter) পাঠানো হয়।\n• বটের Bot Creator-এর কাছে সংরক্ষিত ডেটার Backup থাকে।\n• নিজের স্মৃতি মুছতে /forget লিখুন।'));
bot.command('forget', async ctx => {
  if (!ctx.from) return;
  const uid = String(ctx.from.id), suffix = `:${uid}`;
  let n = 0;
  for (const key of Object.keys(db.conversations)) {
    if (key === `private:${uid}` || (key.startsWith('group:') && key.endsWith(suffix))) { delete db.conversations[key]; if (db.convTimes) delete db.convTimes[key]; n++; }
  }
  if (n) await saveDb().catch(e => console.error('Forget save failed:', e.message));
  return ctx.reply(n ? '✅ আপনার সঙ্গে আমার কথোপকথনের স্মৃতি মুছে ফেলা হয়েছে। 🌸' : 'আপনার নামে কোনো সংরক্ষিত স্মৃতি নেই। 🌷');
});
// Group helper: shows what is still missing for the bot to work fully in this group.
bot.command('setup', async ctx => {
  if (!isGroup(ctx)) return ctx.reply('এই কমান্ডটি গ্রুপে ব্যবহার করুন। 🌸');
  const permission = await canManageGroup(ctx);
  if (!permission.allowed) return permissionFailure(ctx, permission);
  let me;
  try { me = await ctx.api.getChatMember(ctx.chat.id, botInfo.id); }
  catch (e) { console.error('/setup failed:', e.message); return ctx.reply('বটের অবস্থা যাচাই করা যায়নি। একটু পরে আবার চেষ্টা করুন।'); }
  const admin = me.status === 'administrator';
  const mark = v => v ? '✅' : '❌';
  const lines = ['🛠 গ্রুপ সেটআপ চেকলিস্ট', '', `${mark(admin)} বট Admin`, `${mark(admin && me.can_delete_messages)} "Delete messages" permission (Moderation-এর জন্য)`, `${mark(admin && me.can_restrict_members)} "Ban users/Restrict members" permission (/mute /ban /warn-এর জন্য)`, ''];
  lines.push(admin && me.can_delete_messages && me.can_restrict_members ? 'সব ঠিক আছে! 🎉 /settings ও /premium দিয়ে ফিচার চালু করুন।' : 'বটকে Admin বানিয়ে ❌ চিহ্নিত permission দিন, তারপর আবার /setup দিন।');
  return ctx.reply(lines.join('\n'));
});
bot.command('backup', async ctx => {
  if (!isOwner(ctx) || !isPrivate(ctx)) return ctx.reply('এই কমান্ড শুধু Bot Creator-এর Private Chat-এ।');
  const ok = await backup.flush(true);
  return ctx.reply(ok ? '✅ Backup নেওয়া হয়েছে ও পিন করা হয়েছে। বট রিস্টার্ট হলে এখান থেকে সব ডেটা নিজে ফিরে আসবে।' : '❌ Backup নেওয়া যায়নি। Render Logs দেখুন।');
});
bot.command('cancel', async ctx => { pending.delete(keyOf(ctx)); await ctx.reply('চলমান কাজ বাতিল করা হয়েছে।'); });

bot.command('set', async ctx => {
  if (!isGroup(ctx)) return ctx.reply('এই কমান্ডটি গ্রুপে ব্যবহার করো।');
  const permission = await canManageGroup(ctx);
  if (!permission.allowed) return permissionFailure(ctx, permission);
  pending.set(keyOf(ctx), { type: 'set', step: 'trigger' });
  return ctx.reply('কোন শব্দ/মেসেজের জন্য Reply সেট করতে চাও? Trigger পাঠাও।\nবাতিল: /cancel');
});
bot.command('list', async ctx => {
  if (!isGroup(ctx)) return ctx.reply('এই কমান্ডটি গ্রুপে ব্যবহার করো।');
  const permission = await canManageGroup(ctx);
  if (!permission.allowed) return permissionFailure(ctx, permission);
  const items = db.customReplies[String(ctx.chat.id)] || [];
  return ctx.reply(items.length ? 'Custom Replies:\n' + items.map((x,i)=>`${i+1}. ${x.trigger} → ${x.reply}`).join('\n') : 'এখনো কোনো Custom Reply নেই। /set দিয়ে তৈরি করো।');
});
bot.command('del', async ctx => {
  if (!isGroup(ctx)) return ctx.reply('এই কমান্ডটি গ্রুপে ব্যবহার করো।');
  const permission = await canManageGroup(ctx);
  if (!permission.allowed) return permissionFailure(ctx, permission);
  const list = db.customReplies[String(ctx.chat.id)] || [];
  const n = Number((ctx.match || '').trim());
  if (!Number.isInteger(n) || n < 1 || n > list.length) return ctx.reply('মুছতে /del 1 এভাবে নম্বর দাও। আগে /list দেখো।');
  const [removed] = list.splice(n-1,1); db.customReplies[String(ctx.chat.id)] = list; await saveDb();
  return ctx.reply(`মুছে ফেলা হয়েছে: ${removed.trigger}`);
});

bot.command('welcome', async ctx => {
  // Owner in private chat: the original global default welcome. Group Creators: per-group welcome (v1.8).
  if (!(isPrivate(ctx) && isOwner(ctx))) return extra.welcomeCommand(ctx);
  const kb = new InlineKeyboard().text('✏️ Edit Welcome', 'welcome:edit').row().text(db.welcome.enabled ? '🔴 OFF' : '🟢 ON', 'welcome:toggle').text('👁 Preview', 'welcome:preview');
  return ctx.reply(`🌸 Welcome Message Settings\nStatus: ${db.welcome.enabled ? 'ON' : 'OFF'}\n\nবর্তমান মেসেজ:\n\n${db.welcome.text}`, { reply_markup: kb });
});
bot.callbackQuery(/^welcome:(edit|toggle|preview)$/, async ctx => {
  if (!isOwner(ctx)) return ctx.answerCallbackQuery({ text: 'শুধু Owner ব্যবহার করতে পারবেন।', show_alert: true });
  const action = ctx.match[1];
  if (action === 'edit') { pending.set(keyOf(ctx), { type: 'welcome', step: 'text' }); await ctx.answerCallbackQuery(); return ctx.reply('নতুন Welcome Message লিখে পাঠাও। এরপর Preview ও Confirm দেখানো হবে। বাতিল: /cancel'); }
  if (action === 'toggle') { db.welcome.enabled = !db.welcome.enabled; await saveDb(); await ctx.answerCallbackQuery({ text: db.welcome.enabled ? 'Welcome ON' : 'Welcome OFF' }); return ctx.editMessageText(`🌸 Welcome Message Settings\nStatus: ${db.welcome.enabled ? 'ON' : 'OFF'}\n\n${db.welcome.text}`, { reply_markup: new InlineKeyboard().text('✏️ Edit Welcome','welcome:edit').row().text(db.welcome.enabled ? '🔴 OFF' : '🟢 ON','welcome:toggle').text('👁 Preview','welcome:preview') }); }
  await ctx.answerCallbackQuery(); return ctx.reply(db.welcome.text);
});
bot.callbackQuery(/^welcomeconfirm:(.+)$/, async ctx => {
  if (!isOwner(ctx)) return ctx.answerCallbackQuery({ text: 'শুধু Owner পারবেন।', show_alert: true });
  const id = ctx.match[1], draft = jobs.get(id);
  if (!draft) return ctx.answerCallbackQuery({ text: 'Preview-এর মেয়াদ শেষ। আবার /welcome দাও।', show_alert: true });
  db.welcome.text = draft.text; db.welcome.enabled = true; jobs.delete(id); await saveDb();
  await ctx.answerCallbackQuery({ text: 'Welcome Message সংরক্ষিত হয়েছে।' });
  await ctx.editMessageText('✅ নতুন Welcome Message সংরক্ষিত হয়েছে এবং ON করা হয়েছে।');
});
bot.callbackQuery(/^welcomecancel:(.+)$/, async ctx => { if (!isOwner(ctx)) return ctx.answerCallbackQuery({ text: 'শুধু Owner পারবেন।', show_alert: true }); jobs.delete(ctx.match[1]); await ctx.answerCallbackQuery({ text: 'বাতিল করা হয়েছে।' }); await ctx.editMessageText('❌ Welcome Message পরিবর্তন বাতিল।'); });

bot.command('send', async ctx => {
  if (!isPrivate(ctx)) return ctx.reply('এই কমান্ডটি শুধু Private Chat-এ ব্যবহার করা যাবে।');
  pending.set(keyOf(ctx), { type: 'send', step: 'content', userId: ctx.from.id });
  return ctx.reply('যে Text/Photo/Video/Voice/Document গ্রুপে পাঠাতে চাও সেটি পাঠাও।\nবাতিল: /cancel');
});
bot.command('baton', async ctx => {
  if (!isPrivate(ctx)) return ctx.reply('/baton শুধু Private Chat-এ ব্যবহার করা যাবে।');
  pending.set(keyOf(ctx), { type: 'button', step: 'content', userId: ctx.from.id });
  return ctx.reply('প্রথমে যে মেসেজের নিচে Button দিতে চাও সেটি পাঠাও। Text, Photo, Video বা Document দিতে পারো।\nবাতিল: /cancel');
});

bot.on('my_chat_member', async ctx => {
  const s = ctx.myChatMember.new_chat_member.status;
  const was = ctx.myChatMember.old_chat_member.status;
  if (['member','administrator'].includes(s) && ['left','kicked'].includes(was)) await ctx.api.sendMessage(ctx.chat.id, 'আসসালামু আলাইকুম! 🌸\nআমি MIM JANNAT BOT। /help দিয়ে আমার কমান্ডগুলো জানতে পারেন। 🤍').catch(e => console.error('Bot join welcome:', e.message));
});
bot.on('message:new_chat_members', async ctx => {
  const names = ctx.message.new_chat_members.filter(x => !x.is_bot).map(x => x.first_name).filter(Boolean);
  if (!names.length) return;
  const pc = premium.cfgFor(ctx.chat.id);
  if (pc.welcome.enabled && extra.globalEnabled('welcome')) {
    try {
      const members = ctx.message.new_chat_members.filter(x => !x.is_bot);
      const sent = await premium.sendConfigured(ctx.api, ctx.chat.id, pc.welcome, members, ctx.chat, ctx.msg.message_id);
      if (pc.welcome.deleteAfter > 0) setTimeout(() => ctx.api.deleteMessage(ctx.chat.id, sent.message_id).catch(() => {}), Math.min(pc.welcome.deleteAfter, 86400) * 1000).unref?.();
    } catch (e) { console.error('Premium welcome failed:', e.message); }
    return;
  }
  const welcomeCfg = extra.effectiveWelcome(ctx.chat.id);
  if (!welcomeCfg.enabled) return;
  const text = welcomeCfg.text.replaceAll('{name}', names.join(', '));
  await ctx.reply(text, { reply_parameters: { message_id: ctx.msg.message_id } }).catch(e => console.error('Member welcome failed:', e.message));
});

extra.installFlows();
panels.installFlows();
bot.on('message', async ctx => {
  const msg = ctx.msg;
  const text = msg.text || msg.caption || '';
  const k = keyOf(ctx);
  const flow = pending.get(k);

  if (flow && !isCommand(text)) {
    if (flow.type === 'set' && isGroup(ctx)) {
      if (flow.step === 'trigger') { flow.trigger = text.trim(); flow.step = 'reply'; pending.set(k, flow); return ctx.reply('এই Trigger-এর জন্য বট কী উত্তর দেবে? Reply পাঠাও।'); }
      if (flow.step === 'reply') { const list = db.customReplies[String(ctx.chat.id)] || []; const i = list.findIndex(x => norm(x.trigger) === norm(flow.trigger)); const item = { trigger: flow.trigger, reply: text.trim() }; if (i >= 0) list[i] = item; else list.push(item); db.customReplies[String(ctx.chat.id)] = list; pending.delete(k); await saveDb(); return ctx.reply(`সেট হয়েছে!\nTrigger: ${item.trigger}\nReply: ${item.reply}`); }
    }
    if (flow.type === 'welcome' && isPrivate(ctx) && isOwner(ctx)) {
      const id = `welcome_${Date.now()}_${ctx.from.id}`; jobs.set(id, { text: text.trim() }); pending.delete(k);
      const kb = new InlineKeyboard().text('✅ Confirm & Save', `welcomeconfirm:${id}`).text('❌ Cancel', `welcomecancel:${id}`);
      return ctx.reply(`🌸 Welcome Message Preview\n\n${text.trim()}\n\nএটাই কি নতুন Welcome Message হবে?`, { reply_markup: kb });
    }
    if ((flow.type === 'send' || flow.type === 'button') && isPrivate(ctx)) {
      if (flow.step === 'content') { flow.fromChatId = ctx.chat.id; flow.messageId = msg.message_id; flow.step = flow.type === 'send' ? 'destination' : 'label'; pending.set(k, flow); return ctx.reply(flow.type === 'send' ? 'এখন destination গ্রুপের @username অথবা numeric Chat ID পাঠাও।' : 'Button-এর নাম কী হবে? নাম লিখে পাঠাও।'); }
      if (flow.type === 'button' && flow.step === 'label') { flow.label = text.trim(); flow.step = 'url'; pending.set(k, flow); return ctx.reply('এখন Button-এ ক্লিক করলে যে URL খুলবে সেটি পাঠাও (https:// অথবা t.me/ লিংক)।'); }
      if (flow.type === 'button' && flow.step === 'url') { if (!/^https?:\/\//i.test(text.trim()) && !/^t\.me\//i.test(text.trim())) return ctx.reply('সঠিক URL দাও। https:// অথবা t.me/ দিয়ে শুরু করো।'); flow.url = /^t\.me\//i.test(text.trim()) ? `https://${text.trim()}` : text.trim(); flow.step = 'color'; pending.set(k, flow); return ctx.reply(`এই বাটনের রঙ কী হবে? (বাটন: ${flow.label})`, { reply_markup: new InlineKeyboard().text('🔵 নীল', 'btncolor:primary').text('🟢 সবুজ', 'btncolor:success').row().text('🔴 লাল', 'btncolor:danger').text('⚪ ডিফল্ট', 'btncolor:default') }); }
      if (flow.step === 'destination') {
        let dest = text.trim(); const m = dest.match(/(?:https?:\/\/)?t\.me\/([A-Za-z0-9_]{5,})\/?$/i); if (m) dest = '@' + m[1];
        if (!/^@?[A-Za-z0-9_]{5,}$/.test(dest) && !/^-?\d+$/.test(dest)) return ctx.reply('Destination হিসেবে @username অথবা numeric Chat ID দাও।');
        // Group Creators may only send to a group they created (server-side Telegram creator check). Owner: unrestricted.
        if (!isOwner(ctx)) { const target = await extra.resolveDestination(ctx.api, dest, ctx.from.id); if (!target.ok) return ctx.reply(target.message); dest = String(target.chat.id); }
        flow.destination = dest;
        if (flow.type === 'button') { flow.sender = 'bot'; flow.step = 'confirm'; return sendButtonPreview(ctx, k, flow); }
        const id = `send_${Date.now()}_${ctx.from.id}`; jobs.set(id, flow); pending.delete(k);
        const kb = new InlineKeyboard().text('✅ Send', `jobsend:${id}`).text('❌ Cancel', `jobcancel:${id}`);
        const preview = await ctx.api.copyMessage(ctx.chat.id, flow.fromChatId, flow.messageId, { reply_markup: kb }).catch(e => { console.error('Preview copy failed:', e.message); return null; });
        if (!preview) return ctx.reply('Preview তৈরি করা যায়নি। অন্য মেসেজ দিয়ে আবার চেষ্টা করো।');
        return ctx.reply(`উপরের মেসেজটি পাঠানো হবে।\nDestination: ${dest}\nSend অথবা Cancel চাপো।`);
      }
    }
  }

  // Private chat: a sticker is answered with a sticker of the same kind (same pack and emoji when possible).
  if (isPrivate(ctx) && msg.sticker && (isOwner(ctx) || extra.globalEnabled('auto'))) {
    try {
      const fileId = await stickerReplier.choose(ctx.api, msg.sticker);
      if (fileId) {
        await ctx.api.sendChatAction(ctx.chat.id, 'choose_sticker').catch(() => {});
        await ctx.api.sendSticker(ctx.chat.id, fileId, { reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true } });
        rememberTurn(`private:${ctx.from.id}`, `(ব্যবহারকারী একটি স্টিকার পাঠিয়েছে${msg.sticker.emoji ? ` ${msg.sticker.emoji}` : ''})`, `(আমিও একটি স্টিকার পাঠিয়েছি)`);
        return;
      }
    } catch (e) { console.error('Sticker reply failed, answering with text instead:', e.message); }
  }
  const inc = incoming(msg);
  if (isPrivate(ctx) && !isCommand(text) && inc.text) {
    if (!isOwner(ctx) && !extra.globalEnabled('ai')) return ctx.reply('এখন AI reply সাময়িকভাবে বন্ধ আছে। পরে আবার চেষ্টা করুন।');
    try { return await aiReply(ctx, inc.text, `private:${ctx.from.id}`, inc.image); }
    catch (e) { console.error('Private AI error:', e.message); return ctx.reply('AI সেবায় সমস্যা হচ্ছে। একটু পরে আবার চেষ্টা করুন।'); }
  }
  if (isGroup(ctx)) {
    if (isCommand(text)) return;
    const entities = msg.entities || msg.caption_entities || [];
    const botUser = botInfo ? botInfo.username.toLowerCase() : '';
    const mentioned = Boolean(botInfo) && entities.some(e =>
      (e.type === 'mention' && text.slice(e.offset, e.offset + e.length).toLowerCase() === `@${botUser}`) ||
      (e.type === 'text_mention' && e.user?.id === botInfo.id)
    ) || (Boolean(botInfo) && new RegExp(`(^|[^A-Za-z0-9_])@${botUser}(?![A-Za-z0-9_])`, 'i').test(text));
    const replied = msg.reply_to_message?.from?.id === botInfo?.id;
    if ((mentioned || replied) && inc.text) {
      const cleanedText = botInfo ? text.replace(new RegExp(`@${botInfo.username}`, 'ig'), ' ').replace(/\s+/g, ' ').trim() : text.trim();
      const incClean = msg.text ? { text: cleanedText, image: null } : incoming(msg, cleanedText);
      const cleaned = incClean.text;
      const replyOpts = { reply_parameters: { message_id: msg.message_id } };
      // Only a mention (no other words): greet without needing the AI service.
      if (!cleaned) {
        const greetings = ['জি, বলুন! 🌸', 'হ্যাঁ, আমি আছি! 🥺 কী খবর?', 'জি, শুনছি! 🫣 কী লাগবে বলুন?', 'আসসালামু আলাইকুম! 🤍 বলুন, কীভাবে সাহায্য করতে পারি?'];
        const greet = greetings[Math.floor(Math.random() * greetings.length)];
        await ctx.reply(greet, replyOpts);
        rememberTurn(convKeyOf(ctx), '(শুধু মেনশন করেছে)', greet);
        await maybeReact(ctx);
        return;
      }
      const gKey = convKeyOf(ctx);
      const fixedMention = extra.groupSetting(ctx.chat.id, 'auto') ? fixedReply(ctx.chat.id, cleaned, gKey) : null;
      if (fixedMention) { await ctx.reply(fixedMention, replyOpts); rememberTurn(gKey, cleaned, fixedMention); await maybeReact(ctx); return; }
      if (!extra.groupSetting(ctx.chat.id, 'ai')) { await maybeReact(ctx); return; }
      try { await aiReply(ctx, cleaned, `group:${ctx.chat.id}:${ctx.from.id}`, incClean.image); }
      catch (e) { console.error('Group AI error:', e.message); await ctx.reply('AI সেবায় এখন সমস্যা হচ্ছে। একটু পরে আবার চেষ্টা করুন।', replyOpts).catch(() => {}); }
      await maybeReact(ctx);
      return;
    }
    const gKey2 = convKeyOf(ctx);
    const fixed = extra.groupSetting(ctx.chat.id, 'auto') ? fixedReply(ctx.chat.id, text, gKey2) : null;
    if (fixed) { await ctx.reply(fixed, { reply_parameters: { message_id: msg.message_id } }); rememberTurn(gKey2, text, fixed); await maybeReact(ctx); return; }
    await maybeReact(ctx);
  }
});

// Telegram supports 3 button colors: primary (blue), success (green), danger (red). No style = default.
const BTN_COLOR_NAME = { primary: '🔵 নীল', success: '🟢 সবুজ', danger: '🔴 লাল' };
function buildUrlKb(buttons, withStyle = true) {
  const kb = new InlineKeyboard();
  for (const b of buttons) {
    kb.url(b.label, b.url);
    if (withStyle && b.style) { const row = kb.inline_keyboard[kb.inline_keyboard.length - 1]; row[row.length - 1].style = b.style; }
    kb.row();
  }
  return kb;
}
bot.callbackQuery(/^btncolor:(primary|success|danger|default)$/, async ctx => {
  if (!isPrivate(ctx)) return ctx.answerCallbackQuery({ text: 'এই কাজ শুধু Private Chat-এ করা যাবে।', show_alert: true });
  const flow = pending.get(keyOf(ctx)); if (!flow || flow.type !== 'button' || flow.step !== 'color') return ctx.answerCallbackQuery({ text: 'এই ধাপের মেয়াদ শেষ। /baton দিয়ে আবার শুরু করো।', show_alert: true });
  await ctx.answerCallbackQuery();
  await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }).catch(() => {});
  const style = ctx.match[1] === 'default' ? undefined : ctx.match[1];
  flow.buttons = flow.buttons || [];
  flow.buttons.push({ label: flow.label, url: flow.url, style });
  flow.step = 'more'; pending.set(keyOf(ctx), flow);
  return ctx.reply(`✅ বাটন যোগ হয়েছে (মোট ${flow.buttons.length}টি, রঙ: ${style ? BTN_COLOR_NAME[style] : '⚪ ডিফল্ট'})।\n\nআরেকটি বাটন যোগ করতে চাও?`, { reply_markup: new InlineKeyboard().text('➕ হ্যাঁ, আরেকটি', 'morebtn:yes').text('➡️ না, পরের ধাপে', 'morebtn:no') });
});
bot.callbackQuery(/^morebtn:(yes|no)$/, async ctx => {
  if (!isPrivate(ctx)) return ctx.answerCallbackQuery({ text: 'এই কাজ শুধু Private Chat-এ করা যাবে।', show_alert: true });
  const flow = pending.get(keyOf(ctx)); if (!flow || flow.type !== 'button' || flow.step !== 'more') return ctx.answerCallbackQuery({ text: 'এই ধাপের মেয়াদ শেষ। /baton দিয়ে আবার শুরু করো।', show_alert: true });
  await ctx.answerCallbackQuery();
  await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }).catch(() => {});
  if (ctx.match[1] === 'yes') { flow.step = 'label'; pending.set(keyOf(ctx), flow); return ctx.reply('পরের Button-এর নাম কী হবে? নাম লিখে পাঠাও।'); }
  flow.step = 'destination'; pending.set(keyOf(ctx), flow);
  return ctx.reply('এখন যে গ্রুপে পাঠাতে চাও তার @username অথবা numeric Chat ID পাঠাও। Private invite link নয়।');
});
// Telegram Bot API can only send as the bot, so the old "Owner-এর পক্ষ থেকে / Bot-এর পক্ষ থেকে" choice changed nothing and has been removed.
async function sendButtonPreview(ctx, k, flow) {
  const id = `button_${Date.now()}_${ctx.from.id}`; jobs.set(id, flow); flow.jobId = id;
  const kb = buildUrlKb(flow.buttons || [{ label: flow.label, url: flow.url }]).text('✅ Send', `jobsend:${id}`).text('❌ Cancel', `jobcancel:${id}`);
  await ctx.reply(`🔎 Button Message Preview\nপ্রেরক: 🤖 MIM JANNAT BOT\nDestination: ${flow.destination}\nনিচের Preview-তে Button ও Send/Cancel আছে।`);
  const copied = await ctx.api.copyMessage(ctx.chat.id, flow.fromChatId, flow.messageId, { reply_markup: kb }).catch(e => { console.error('Button preview failed:', e.message); return null; });
  if (!copied) { jobs.delete(id); pending.delete(k); return ctx.reply('Button Preview তৈরি করা যায়নি। /baton দিয়ে আবার চেষ্টা করো।'); }
  pending.delete(k);
}
// Old Preview messages may still carry the removed sender buttons: answer politely instead of failing silently.
bot.callbackQuery(/^sender:(owner|bot)$/, ctx => ctx.answerCallbackQuery({ text: 'এই ধাপ আর নেই। /baton দিয়ে নতুন করে শুরু করো।', show_alert: true }));
bot.callbackQuery(/^jobsend:(.+)$/, async ctx => {
  const id = ctx.match[1], job = jobs.get(id); if (!job) return ctx.answerCallbackQuery({ text: 'এই Preview আর বৈধ নয়। আবার শুরু করো।', show_alert: true });
  if (String(job.userId || OWNER_TELEGRAM_ID) !== String(ctx.from.id)) return ctx.answerCallbackQuery({ text: 'এই Preview তোমার নয়।', show_alert: true });
  // Re-check on the server at send time: only the Owner or the real creator of the destination group may send.
  if (!isOwner(ctx) && !(await extra.canSendTo(ctx.api, job.destination, ctx.from.id))) return ctx.answerCallbackQuery({ text: 'শুধু নিজের তৈরি গ্রুপে পাঠানো যাবে।', show_alert: true });
  try {
    if (job.type === 'button') {
      const btns = job.buttons || [{ label: job.label, url: job.url }];
      try {
        await ctx.api.copyMessage(job.destination, job.fromChatId, job.messageId, { reply_markup: buildUrlKb(btns) });
      } catch (styleErr) {
        if (!btns.some(b => b.style)) throw styleErr;
        console.error('Send with button colors failed, retrying without colors:', styleErr.message);
        await ctx.api.copyMessage(job.destination, job.fromChatId, job.messageId, { reply_markup: buildUrlKb(btns, false) });
      }
    } else {
      await ctx.api.copyMessage(job.destination, job.fromChatId, job.messageId);
    }
    jobs.delete(id); await ctx.answerCallbackQuery({ text: 'মেসেজ পাঠানো হয়েছে।' });
    await ctx.editMessageText('✅ Destination-এ মেসেজ পাঠানো হয়েছে।').catch(() => {});
  } catch (e) { console.error('Send job failed:', e.message); await ctx.answerCallbackQuery({ text: 'পাঠানো যায়নি। বট গ্রুপে আছে এবং Send permission আছে কি না দেখো।', show_alert: true }); }
});
bot.callbackQuery(/^jobcancel:(.+)$/, async ctx => { const cancelJob = jobs.get(ctx.match[1]); if (String((cancelJob && cancelJob.userId) || OWNER_TELEGRAM_ID) !== String(ctx.from.id)) return ctx.answerCallbackQuery({ text: 'এই Preview তোমার নয়।', show_alert: true }); jobs.delete(ctx.match[1]); await ctx.answerCallbackQuery({ text: 'বাতিল করা হয়েছে।' }); await ctx.editMessageText('❌ পাঠানো বাতিল হয়েছে।').catch(() => {}); });

bot.on('channel_post', async ctx => { if (!extra.globalEnabled('react')) return; await ctx.api.setMessageReaction(ctx.chat.id, ctx.channelPost.message_id, [{ type: 'emoji', emoji: pickReaction() }]).catch(err => console.error('Channel reaction:', err.message)); });

const app = express();
app.get('/', (_req,res) => res.status(200).send('Mim Jannat bot is running.'));
app.disable('x-powered-by');
app.get('/health', (_req,res) => res.status(200).json({ ok: true, bot: BOT_NAME, version: BOT_VERSION, creator: BRAND_NAME })); // no server paths in the public response
const server = app.listen(PORT, '0.0.0.0', () => console.log(`Health server listening on ${PORT}; data file: ${DB_FILE}`));
// Render Free web services fall asleep after ~15 minutes without inbound HTTP traffic, which would stop this polling bot.
// Render sets RENDER_EXTERNAL_URL automatically; the bot pings its own /health every 10 minutes to stay awake (set KEEP_ALIVE=off to disable).
const SELF_URL = String(process.env.RENDER_EXTERNAL_URL || process.env.SELF_URL || '').replace(/\/+$/, '');
if (SELF_URL && String(process.env.KEEP_ALIVE || '').toLowerCase() !== 'off') {
  const pingTimer = setInterval(() => {
    fetch(`${SELF_URL}/health`, { signal: AbortSignal.timeout(15000) }).catch(e => console.error('Keep-alive ping failed:', e.message));
  }, 10 * 60 * 1000);
  pingTimer.unref?.();
}
bot.catch(error => {
  const e = error.error || error;
  if (e && e.error_code) console.error(`Telegram API error ${e.error_code} while handling update ${error.ctx?.update?.update_id}:`, e.description || e.message);
  else console.error('Unhandled Telegram update error:', e);
});

let runnerHandle = null;
let shuttingDown = false;
let started = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  extra.onShutdown();
  premium.onShutdown();
  console.log(`Received ${signal}; shutting down gracefully...`);
  try {
    if (runnerHandle) await runnerHandle.stop();
    await saveDb().catch(error => console.error('Final database save failed:', error.message));
    await Promise.race([backup.flush(false), new Promise(r => setTimeout(r, 6000))]);
  } catch (error) {
    console.error('Shutdown error:', error);
  } finally {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 8000).unref();
  }
}

let pollingConflicts = 0;
let lastConflictAlert = 0;
function startPolling() {
  // Never start a second polling loop inside this process.
  if (runnerHandle || shuttingDown) return;
  runnerHandle = run(bot, {
    runner: { fetch: { allowed_updates: ['message', 'edited_message', 'callback_query', 'my_chat_member', 'channel_post'] } },
    sink: { concurrency: 8 }
  });
  console.log('Mim Jannat concurrent long-polling runner started (max 8 updates).');
  const task = runnerHandle.task();
  if (!task) return;
  task.then(() => { runnerHandle = null; }).catch(async error => {
    runnerHandle = null;
    if (shuttingDown) return;
    const isConflict = error && (error.error_code === 409 || /Conflict/i.test(String(error.description || error.message)));
    if (isConflict) {
      pollingConflicts++;
      if (Date.now() - lastConflictAlert > 30 * 60 * 1000) { lastConflictAlert = Date.now(); bot.api.sendMessage(OWNER_TELEGRAM_ID, '⚠️ সতর্কতা: একই BOT_TOKEN দিয়ে বটের আরেকটি কপি অন্য কোথাও চলছে (পুরোনো Render Service, অন্য হোস্ট বা ফোন/কম্পিউটার)। দুটি কপি থাকলে সেটিংস, Channel, Warning মাঝে মাঝে হারিয়ে যাওয়ার মতো দেখায়। পুরোনো কপি বন্ধ করুন — শুধু একটি চালু রাখুন।').catch(() => {}); }
      console.error(`409 Conflict: another process is polling with the same BOT_TOKEN (or a webhook is set). Stop the other instance. Attempt ${pollingConflicts}/10 — retrying in 20s without restarting the process.`);
      if (pollingConflicts <= 10) { await new Promise(resolve => setTimeout(resolve, 20000)); return startPolling(); }
      console.error('409 Conflict did not clear after 10 attempts; exiting.');
      return process.exit(1);
    }
    console.error('Polling runner stopped unexpectedly:', error);
    process.exit(1);
  });
}

(async () => {
  try {
    botInfo = await bot.api.getMe();
    // Telegram's command menu (the "/" button): separate lists for users, groups and the Bot Creator. Never fatal.
    try {
      const userCmds = [['start', 'বট চালু করুন'], ['help', 'ব্যবহার নির্দেশিকা'], ['panel', 'আমার গ্রুপের প্যানেল'], ['privacy', 'গোপনীয়তা'], ['forget', 'আমার স্মৃতি মুছুন'], ['id', 'আইডি দেখুন']];
      const groupCmds = [['help', 'ব্যবহার নির্দেশিকা'], ['setup', 'গ্রুপ সেটআপ যাচাই'], ['settings', 'গ্রুপ সেটিংস'], ['premium', 'Premium Dashboard'], ['set', 'Custom Reply তৈরি'], ['list', 'Custom Reply তালিকা'], ['warn', 'Warning (Reply করে)'], ['mute', 'Mute (Reply করে)'], ['ban', 'Ban (Reply করে)'], ['id', 'আইডি দেখুন']];
      const ownerCmds = [...userCmds, ['admin', 'Master Admin Panel'], ['send', 'গ্রুপে মেসেজ পাঠান'], ['baton', 'বাটনসহ মেসেজ'], ['all', 'Global Broadcast'], ['channels', 'Force Join Channel'], ['backup', 'এখনই Backup'], ['health', 'বটের অবস্থা']];
      const toCmd = ([command, description]) => ({ command, description });
      await bot.api.setMyCommands(userCmds.map(toCmd), { scope: { type: 'all_private_chats' } });
      await bot.api.setMyCommands(groupCmds.map(toCmd), { scope: { type: 'all_group_chats' } });
      await bot.api.setMyCommands(ownerCmds.map(toCmd), { scope: { type: 'chat', chat_id: Number(OWNER_TELEGRAM_ID) } });
    } catch (e) { console.error('Command menu setup skipped:', e.message); }
    // Remove a previously configured webhook before starting long polling.
    await bot.api.deleteWebhook({ drop_pending_updates: false });
    if (freshDb) { // empty disk: bring everything back from the pinned Telegram backup
      const r = await backup.restore();
      if (r.ok) {
        Object.assign(db, r.data, { ownerId: OWNER_TELEGRAM_ID });
        console.log('Database restored from the pinned Telegram backup.');
        if (corruptDbNote) bot.api.sendMessage(OWNER_TELEGRAM_ID, `ℹ️ ${corruptDbNote}`).catch(() => {});
        bot.api.sendMessage(OWNER_TELEGRAM_ID, '✅ বট রিস্টার্ট হয়েছিল। আপনার আগের সব ডেটা (সেটিংস, Channel, Filter, Warning, Schedule, AI স্মৃতি) Backup থেকে ফিরিয়ে আনা হয়েছে। 🤍').catch(() => {});
      } else {
        console.log('No Telegram backup restored:', r.reason);
        if (corruptDbNote) bot.api.sendMessage(OWNER_TELEGRAM_ID, `⚠️ ${corruptDbNote} Telegram Backup পাওয়া যায়নি (${r.reason}), তাই খালি ডেটা দিয়ে চালু হয়েছে।`).catch(() => {});
        bot.api.sendMessage(OWNER_TELEGRAM_ID, `ℹ️ বট খালি ডেটা নিয়ে চালু হয়েছে (${r.reason})। সেটিংস দেওয়ার পর স্বয়ংক্রিয়ভাবে Backup নেওয়া হবে; এখনই নিতে /backup দিন।`).catch(() => {});
      }
    }
    const previousSchema = Number(db.schemaVersion || 0);
    if (previousSchema < SCHEMA_VERSION) {
      const backupPath = await backupDbBeforeUpgrade(); // only needed when the schema changes; a failed backup aborts startup before anything is written
      db.migrationLog = [...(Array.isArray(db.migrationLog) ? db.migrationLog : []), { from: previousSchema, to: SCHEMA_VERSION, at: Date.now(), backup: backupPath ? path.basename(backupPath) : null }].slice(-20);
      db.schemaVersion = SCHEMA_VERSION;
    }
    await saveDb().catch(error => console.error('Initial database save failed:', error.message));
    console.log(`Starting Mim Jannat as @${botInfo.username}; fixed owner ID=${OWNER_TELEGRAM_ID}`);
    pruneOldConversations();
    setInterval(pruneOldConversations, 24 * 3600 * 1000).unref?.();
    startPolling();
    started = true;
    backup.markDirty();
    panels.start(bot.api);
  } catch (error) {
    console.error('Bot startup failed:', error);
    server.close();
    process.exit(1);
  }
})();

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', error => console.error('Unhandled promise rejection:', error));
process.on('uncaughtException', error => {
  console.error('Uncaught exception:', error);
  // After startup the bot keeps serving users; a startup-time failure stops safely before data is touched.
  if (!started && !shuttingDown) process.exit(1);
});
