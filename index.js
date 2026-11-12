require('dotenv').config();
const { Bot, InlineKeyboard } = require('grammy');
const { run, sequentialize } = require('@grammyjs/runner');
const express = require('express');
const fs = require('fs');
const path = require('path');

const BOT_TOKEN = process.env.BOT_TOKEN;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL = 'openai/gpt-4o-mini';
// Fixed owner identity: never assign ownership to the first person who sends /start.
const OWNER_TELEGRAM_ID = String(process.env.OWNER_ID || '7926785649').trim();
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
      console.error('Database load failed; starting with safe defaults:', error.message);
      try {
        if (fs.existsSync(DB_FILE)) {
          fs.copyFileSync(DB_FILE, DB_FILE + '.corrupt-' + Date.now() + '.bak');
        }
      } catch (backupError) {
        console.error('Database backup failed:', backupError.message);
      }
    }
    return emptyDb();
  }
}

let db = loadDb();
let saveQueue = Promise.resolve();

function saveDb() {
  const snapshot = JSON.stringify({ ...db, ownerId: OWNER_TELEGRAM_ID }, null, 2);
  // Recover the queue after a failed write so one disk error cannot disable all future saves.
  saveQueue = saveQueue.catch(() => {}).then(async () => {
    await fs.promises.mkdir(DATA_DIR, { recursive: true });
    const tmp = DB_FILE + '.tmp';
    await fs.promises.writeFile(tmp, snapshot, 'utf8');
    await fs.promises.rename(tmp, DB_FILE);
  });
  return saveQueue;
}

const bot = new Bot(BOT_TOKEN);
// Preserve each user's message order while allowing different users to be processed concurrently.
bot.use(sequentialize(ctx => {
  const chatId = ctx.chat?.id?.toString();
  const userId = ctx.from?.id?.toString();
  return chatId && userId ? [`${chatId}:${userId}`] : [];
}));
let botInfo;
const pending = new Map();
const jobs = new Map();
const keyOf = ctx => `${ctx.chat.id}:${ctx.from.id}`;
const isPrivate = ctx => ctx.chat?.type === 'private';
const isGroup = ctx => ['group', 'supergroup'].includes(ctx.chat?.type);
const isOwner = ctx => Boolean(ctx.from && String(ctx.from.id) === OWNER_TELEGRAM_ID);
const isCommand = t => typeof t === 'string' && t.startsWith('/');
const nameOf = ctx => [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(' ') || 'বন্ধু';
const norm = s => String(s || '').toLocaleLowerCase('en-US').normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/[.,!?;:،؛؟…。、]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/([a-z])\1{2,}/g, '$1$1');

const DEFAULTS = [
  { keys: ['hi','hii','hiii','hello','helloo','hey','heyy','হাই','হাইই'], reply: 'হ্যালো! 😊 কেমন আছো?' },
  { keys: ['আসসালামু আলাইকুম','আসসালামুয়ালাইকুম','সালাম','সালাম আলাইকুম'], reply: 'ওয়ালাইকুমুস সালাম! 🌸' },
  { keys: ['কেমন আছো','কেমন আছো ভাই','কেমন আছেন','how are you','how r u'], reply: 'আলহামদুলিল্লাহ ভালো আছি! তুমি কেমন আছো? 😊' },
  { keys: ['good morning','শুভ সকাল'], reply: 'শুভ সকাল! দিনটি সুন্দর কাটুক। ☀️' },
  { keys: ['good afternoon','শুভ দুপুর'], reply: 'শুভ দুপুর! 😊' },
  { keys: ['good evening','শুভ সন্ধ্যা'], reply: 'শুভ সন্ধ্যা! 🌆' },
  { keys: ['good night','শুভ রাত্রি','শুভরাত্রি'], reply: 'শুভ রাত্রি! ভালো থেকো। 🌙' },
  { keys: ['bye','goodbye','বাই','আল্লাহ হাফেজ'], reply: 'আল্লাহ হাফেজ! আবার কথা হবে। 💚' },
  { keys: ['ধন্যবাদ','থ্যাংক ইউ','thank you','thanks'], reply: 'স্বাগতম! 😊' },
  { keys: ['কি খবর','কী খবর',"what's up"], reply: 'সব ভালো! তোমার কী খবর? 😄' },
  { keys: ['কে তুমি','তোমার নাম কি','তোমার নাম কী','who are you'], reply: 'আমি Mim Jannat — তোমাদের সহকারী বট। 🌸' },
  { keys: ['মাশাআল্লাহ','মাশাল্লাহ','মাশা আল্লাহ'], reply: 'আলহামদুলিল্লাহ! ❤️' },
  { keys: ['ইনশাআল্লাহ','ইনশাল্লাহ'], reply: 'ইনশাআল্লাহ। 🤍' }
];
function fixedReply(chatId, text) {
  const n = norm(text);
  const custom = db.customReplies[String(chatId)] || [];
  const found = custom.find(x => norm(x.trigger) === n);
  if (found) return found.reply;
  const base = DEFAULTS.find(x => x.keys.some(k => norm(k) === n));
  return base?.reply || null;
}
const ANON_ADMIN_BOT_ID = '1087968824'; // Telegram's "GroupAnonymousBot"
const isAnonymousSender = ctx => Boolean(
  ctx.from && (String(ctx.from.id) === ANON_ADMIN_BOT_ID || (ctx.msg?.sender_chat && ctx.msg.sender_chat.id === ctx.chat?.id))
);
// Finds the real group creator from the administrator list (works even when getChatMember is restricted).
async function findGroupCreator(ctx) {
  const admins = await ctx.api.getChatAdministrators(ctx.chat.id);
  const creator = admins.find(a => a.status === 'creator') || null;
  return { admins, creator };
}
async function groupCreatorCheck(ctx) {
  try {
    const { admins, creator } = await findGroupCreator(ctx);
    if (!creator) return { allowed: false, error: new Error('Group creator not found in administrator list') };
    // Creator sends as "Anonymous Admin": Telegram hides identity, so accept only when it can only be the creator.
    if (isAnonymousSender(ctx)) {
      const anonymousAdmins = admins.filter(a => a.is_anonymous);
      if (creator.is_anonymous && anonymousAdmins.length === 1) return { allowed: true, error: null, via: 'anonymous-creator' };
      return { allowed: false, error: null, anonymousUnknown: true };
    }
    if (String(creator.user.id) === String(ctx.from.id)) return { allowed: true, error: null };
    return { allowed: false, error: null };
  } catch (error) {
    console.error(`Group creator verification failed for chat ${ctx.chat.id}, user ${ctx.from?.id}:`, error);
    try {
      const member = await ctx.api.getChatMember(ctx.chat.id, ctx.from.id);
      return { allowed: member.status === 'creator', error: null };
    } catch (error2) {
      console.error(`getChatMember fallback failed for chat ${ctx.chat.id}, user ${ctx.from?.id}:`, error2);
      return { allowed: false, error: error2 };
    }
  }
}
async function canManageGroup(ctx) {
  if (isOwner(ctx)) return { allowed: true, error: null };
  return groupCreatorCheck(ctx);
}
function permissionFailure(ctx, result) {
  if (result.anonymousUnknown) {
    return ctx.reply('তুমি Anonymous Admin হিসেবে মেসেজ দিচ্ছো, তাই Telegram তোমার পরিচয় দেখায় না। গ্রুপের Admin Settings-এ গিয়ে "Remain Anonymous" বন্ধ করে আবার কমান্ড দাও।');
  }
  if (result.error) {
    return ctx.reply('Telegram থেকে এই গ্রুপের Creator পরিচয় যাচাই করা যায়নি। বটটি গ্রুপে Admin আছে কি না দেখো, তারপর আবার চেষ্টা করো। বিস্তারিত Render Logs-এ সংরক্ষিত হয়েছে।');
  }
  return ctx.reply('এই কমান্ডটি শুধু এই গ্রুপের Creator অথবা বটের নির্দিষ্ট Owner ব্যবহার করতে পারবেন।');
}

async function askAI(messages) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);
  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://render.com',
        'X-Title': 'Mim Jannat Telegram Bot'
      },
      body: JSON.stringify({
        model: OPENROUTER_MODEL,
        messages: [{
          role: 'system',
          content: 'তুমি Mim Jannat নামের বন্ধুসুলভ Telegram সহকারী। স্বাভাবিক, ভদ্র ও সংক্ষিপ্ত বাংলায় উত্তর দেবে; ব্যবহারকারী ইংরেজিতে লিখলে ইংরেজিতে উত্তর দেবে। নিজেকে মানুষ বলে দাবি করবে না।'
        }, ...messages],
        temperature: 0.7,
        max_tokens: 600
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = data.error?.message || `OpenRouter HTTP ${response.status}`;
      throw new Error(detail);
    }
    const answer = data.choices?.[0]?.message?.content;
    if (typeof answer !== 'string' || !answer.trim()) throw new Error('OpenRouter returned an empty response');
    return answer.trim();
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('AI request timed out after 25 seconds');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
async function aiReply(ctx, text, key) {
  const history = (db.conversations[key] || []).slice(-8);
  history.push({ role: 'user', content: text.slice(0, 3000) });
  await ctx.api.sendChatAction(ctx.chat.id, 'typing').catch(() => {});
  const answer = await askAI(history);
  history.push({ role: 'assistant', content: answer });
  db.conversations[key] = history.slice(-10);
  await saveDb().catch(error => console.error('Conversation save failed:', error.message));
  await ctx.reply(answer, { reply_parameters: { message_id: ctx.msg.message_id } });
}
async function maybeReact(ctx) {
  if (Math.random() > 0.16) return;
  const emoji = ['❤️','👍','🔥','🥰','✨'][Math.floor(Math.random() * 5)];
  await ctx.api.setMessageReaction(ctx.chat.id, ctx.msg.message_id, [{ type: 'emoji', emoji }]).catch(e => console.error('Reaction unavailable:', e.message));
}

function helpKeyboard() {
  return new InlineKeyboard()
    .text('👑 Owner Commands', 'help:owner').row()
    .text('👥 Group Commands', 'help:group').row()
    .text('🌸 Welcome Settings', 'help:welcome').row()
    .text('🔘 Button Message', 'help:button').row()
    .text('🤖 AI & Auto Reply', 'help:ai').row()
    .text('❌ বন্ধ করুন', 'help:close');
}
const HELP = {
  home: '📚 Mim Jannat — সম্পূর্ণ ব্যবহার নির্দেশিকা\nনিচের বাটনে চাপ দিয়ে যে ফিচারটি জানতে চাও সেটি বেছে নাও। প্রতিটি বিভাগে কোথায় কমান্ড দিতে হবে এবং ধাপে ধাপে কী করতে হবে লেখা আছে।',
  owner: '👑 OWNER COMMANDS\n\n/start — Private Chat-এ বট চালু করে। শুধু নির্দিষ্ট Owner ID-র অ্যাকাউন্টে Owner সুবিধা চালু হবে।\n/help — এই নির্দেশিকা খুলবে।\n/id — নিজের Telegram ID ও বর্তমান Chat ID দেখাবে।\n/send — শুধু Owner-এর Private Chat-এ। প্রথমে মেসেজ/ছবি/ভিডিও/ভয়েস/ডকুমেন্ট পাঠাও, তারপর গ্রুপের @username বা numeric Chat ID দাও, Preview দেখে Send/Cancel চাপো।\n/baton — Button-সহ মেসেজ তৈরি করবে। ধাপে ধাপে মেসেজ, বাটনের নাম, URL, গন্তব্য ও Sender label চাইবে।',
  group: '👥 GROUP COMMANDS\n\nএই কমান্ডগুলো গ্রুপে ব্যবহার করবে। বটের Owner অথবা ওই গ্রুপের Creator ব্যবহার করতে পারবেন।\n/set — Trigger শব্দ পাঠাও, এরপর বটের নির্দিষ্ট Reply পাঠাও।\n/list — ওই গ্রুপের সব Custom Reply দেখাবে।\n/del 1 — /list-এর ১ নম্বর Reply মুছবে।\n/cancel — চলমান /set বা /send বা /baton কাজ বাতিল করবে।\n/id — গ্রুপের numeric Chat ID দেখাবে।\nনোট: বটের Owner সব গ্রুপে Custom Reply পরিচালনা করতে পারবে; অন্য সদস্যদের জন্য Telegram Group Creator Status যাচাই হবে।',
  welcome: '🌸 WELCOME SETTINGS\n\n/welcome কমান্ডটি Owner-এর Private Chat-এ দাও।\n১) Edit চাপলে নতুন Welcome Message লিখবে।\n২) বট Preview দেখাবে।\n৩) Confirm করলে নতুন মেসেজ সংরক্ষিত হবে।\n৪) ON/OFF দিয়ে নতুন সদস্যদের Welcome চালু/বন্ধ করবে।\nএটি সব গ্রুপে একই Welcome Text ব্যবহার করবে। নতুন সদস্য যোগ হলে বট গ্রুপে সেটি পাঠাবে।',
  button: '🔘 BUTTON MESSAGE — /baton\n\n১) Owner-এর Private Chat-এ /baton লিখবে।\n২) যে মেসেজটি পাঠাতে চাও সেটি পাঠাবে (text/photo/video/document ইত্যাদি)।\n৩) বাটনের নাম লিখবে।\n৪) বাটনে ক্লিক করলে যে HTTPS/Telegram URL খুলবে সেটি পাঠাবে।\n৫) Destination গ্রুপের @username বা numeric Chat ID দেবে। Private invite link থেকে Chat ID বের করা যায় না।\n৬) Sender label বেছে নেবে: Owner-এর পক্ষ থেকে অথবা Bot-এর পক্ষ থেকে।\n৭) Preview-তে মেসেজ, লিংক বাটন, Send ও Cancel দেখবে। Send চাপলে বটের অ্যাকাউন্ট থেকে গ্রুপে যাবে। Bot API দিয়ে ব্যক্তিগত Telegram account-এর হয়ে পাঠানো সম্ভব নয়।',
  ai: '🤖 AI & AUTO REPLY\n\nPrivate Chat-এ সাধারণ মেসেজ লিখলে AI উত্তর দেবে।\nGroup-এ শুধু বটকে @mention করলে অথবা বটের মেসেজে Reply করলে AI উত্তর দেবে।\nHi, Hello, সালাম, কেমন আছো, Good Morning ইত্যাদি নির্দিষ্ট Trigger-এ Fixed Reply দেবে।\n/set দিয়ে নিজের Trigger/Reply তৈরি করা যায়। AI চালাতে OpenRouter API Key এবং মডেল ব্যবহারের অনুমতি/ক্রেডিট লাগতে পারে।'
};

bot.command('start', async ctx => {
  if (!isPrivate(ctx)) return ctx.reply('আমাকে ব্যক্তিগত চ্যাটে /start দাও।');
  if (isOwner(ctx)) return ctx.reply('আসসালামু আলাইকুম, Owner! 🌸\nMim Jannat চালু আছে। /help দিয়ে নির্দেশিকা দেখো।');
  return ctx.reply('আসসালামু আলাইকুম! 🌸\nআমি Mim Jannat। কীভাবে সাহায্য করতে পারি?');
});
bot.command('help', ctx => ctx.reply(HELP.home, { reply_markup: helpKeyboard() }));
bot.callbackQuery(/^help:(.+)$/, async ctx => {
  const section = ctx.match[1];
  if (section === 'close') { await ctx.deleteMessage().catch(() => {}); return ctx.answerCallbackQuery(); }
  await ctx.answerCallbackQuery();
  if (section === 'home') return ctx.editMessageText(HELP.home, { reply_markup: helpKeyboard() });
  await ctx.editMessageText(HELP[section] || HELP.home, { reply_markup: new InlineKeyboard().text('⬅️ মূল Help', 'help:home').text('❌ বন্ধ', 'help:close') }).catch(async () => ctx.reply(HELP[section] || HELP.home));
});
bot.callbackQuery('help:home', async ctx => { await ctx.answerCallbackQuery(); await ctx.editMessageText(HELP.home, { reply_markup: helpKeyboard() }); });
bot.command('id', async ctx => {
  let text = `এই চ্যাটের ID: ${ctx.chat.id}\nতোমার Telegram ID: ${ctx.from.id}`;
  if (isOwner(ctx)) text += '\nপরিচয়: 👑 বটের Owner';
  if (isGroup(ctx)) {
    const r = await groupCreatorCheck(ctx);
    if (r.allowed) text += '\nএই গ্রুপে: 👑 গ্রুপ Creator';
    else if (r.anonymousUnknown) text += '\nএই গ্রুপে: Anonymous Admin (পরিচয় যাচাই করা যায়নি; Remain Anonymous বন্ধ করো)';
    else if (r.error) text += '\nএই গ্রুপে: যাচাই করা যায়নি (বটকে গ্রুপে Admin করো)';
    else text += '\nএই গ্রুপে: সাধারণ সদস্য/Admin (Creator নন)';
  }
  return ctx.reply(text);
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
  if (!isPrivate(ctx) || !isOwner(ctx)) return ctx.reply('এই সেটিংস শুধু Owner-এর Private Chat-এ ব্যবহার করা যাবে।');
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
  if (!isPrivate(ctx) || !isOwner(ctx)) return ctx.reply('এই কমান্ডটি শুধু Owner-এর Private Chat-এ ব্যবহার করা যাবে।');
  pending.set(keyOf(ctx), { type: 'send', step: 'content' });
  return ctx.reply('যে Text/Photo/Video/Voice/Document গ্রুপে পাঠাতে চাও সেটি পাঠাও।\nবাতিল: /cancel');
});
bot.command('baton', async ctx => {
  if (!isPrivate(ctx) || !isOwner(ctx)) return ctx.reply('শুধু Owner-এর Private Chat-এ /baton ব্যবহার করা যাবে।');
  pending.set(keyOf(ctx), { type: 'button', step: 'content' });
  return ctx.reply('প্রথমে যে মেসেজের নিচে Button দিতে চাও সেটি পাঠাও। Text, Photo, Video বা Document দিতে পারো।\nবাতিল: /cancel');
});

bot.on('my_chat_member', async ctx => {
  const s = ctx.myChatMember.new_chat_member.status;
  if (['member','administrator'].includes(s)) await ctx.api.sendMessage(ctx.chat.id, 'আসসালামু আলাইকুম! 🌸\nআমি Mim Jannat। /help দিয়ে আমার কমান্ডগুলো জানতে পারো।').catch(e => console.error('Bot join welcome:', e.message));
});
bot.on('message:new_chat_members', async ctx => {
  if (!db.welcome.enabled) return;
  const names = ctx.message.new_chat_members.filter(x => !x.is_bot).map(x => x.first_name).filter(Boolean);
  if (!names.length) return;
  const text = db.welcome.text.replaceAll('{name}', names.join(', '));
  await ctx.reply(text, { reply_parameters: { message_id: ctx.msg.message_id } }).catch(e => console.error('Member welcome failed:', e.message));
});

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
    if ((flow.type === 'send' || flow.type === 'button') && isPrivate(ctx) && isOwner(ctx)) {
      if (flow.step === 'content') { flow.fromChatId = ctx.chat.id; flow.messageId = msg.message_id; flow.step = flow.type === 'send' ? 'destination' : 'label'; pending.set(k, flow); return ctx.reply(flow.type === 'send' ? 'এখন destination গ্রুপের @username অথবা numeric Chat ID পাঠাও।' : 'Button-এর নাম কী হবে? নাম লিখে পাঠাও।'); }
      if (flow.type === 'button' && flow.step === 'label') { flow.label = text.trim(); flow.step = 'url'; pending.set(k, flow); return ctx.reply('এখন Button-এ ক্লিক করলে যে URL খুলবে সেটি পাঠাও (https:// অথবা t.me/ লিংক)।'); }
      if (flow.type === 'button' && flow.step === 'url') { if (!/^https?:\/\//i.test(text.trim()) && !/^t\.me\//i.test(text.trim())) return ctx.reply('সঠিক URL দাও। https:// অথবা t.me/ দিয়ে শুরু করো।'); flow.url = /^t\.me\//i.test(text.trim()) ? `https://${text.trim()}` : text.trim(); flow.step = 'destination'; pending.set(k, flow); return ctx.reply('এখন যে গ্রুপে পাঠাতে চাও তার @username অথবা numeric Chat ID পাঠাও। Private invite link নয়।'); }
      if (flow.step === 'destination') {
        let dest = text.trim(); const m = dest.match(/(?:https?:\/\/)?t\.me\/([A-Za-z0-9_]{5,})\/?$/i); if (m) dest = '@' + m[1];
        if (!/^@?[A-Za-z0-9_]{5,}$/.test(dest) && !/^-?\d+$/.test(dest)) return ctx.reply('Destination হিসেবে @username অথবা numeric Chat ID দাও।');
        flow.destination = dest;
        if (flow.type === 'button') { flow.step = 'sender'; pending.set(k, flow); const kb = new InlineKeyboard().text('👤 Owner-এর পক্ষ থেকে', 'sender:owner').row().text('🤖 Bot-এর পক্ষ থেকে', 'sender:bot'); return ctx.reply('মেসেজে কোন পরিচয় দেখাতে চাও?', { reply_markup: kb }); }
        const id = `send_${Date.now()}_${ctx.from.id}`; jobs.set(id, flow); pending.delete(k);
        const kb = new InlineKeyboard().text('✅ Send', `jobsend:${id}`).text('❌ Cancel', `jobcancel:${id}`);
        const preview = await ctx.api.copyMessage(ctx.chat.id, flow.fromChatId, flow.messageId, { reply_markup: kb }).catch(e => { console.error('Preview copy failed:', e.message); return null; });
        if (!preview) return ctx.reply('Preview তৈরি করা যায়নি। অন্য মেসেজ দিয়ে আবার চেষ্টা করো।');
        return ctx.reply(`উপরের মেসেজটি পাঠানো হবে।\nDestination: ${dest}\nSend অথবা Cancel চাপো।`);
      }
    }
  }

  if (isPrivate(ctx) && !isCommand(text) && text) {
    try { return await aiReply(ctx, text, `private:${ctx.from.id}`); }
    catch (e) { console.error('Private AI error:', e.message); return ctx.reply('AI সেবায় সমস্যা হচ্ছে। একটু পরে আবার চেষ্টা করো।'); }
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
    if ((mentioned || replied) && text) {
      const cleaned = botInfo ? text.replace(new RegExp(`@${botInfo.username}`, 'ig'), ' ').replace(/\s+/g, ' ').trim() : text.trim();
      const replyOpts = { reply_parameters: { message_id: msg.message_id } };
      // Only a mention (no other words): greet without needing the AI service.
      if (!cleaned) {
        const greetings = ['জি, বলো! 😊', 'হ্যাঁ, আমি আছি! 🌸 কী খবর?', 'হ্যালো! 😊 কেমন আছো?', 'জি, শুনছি! বলো কী লাগবে? 💚'];
        await ctx.reply(greetings[Math.floor(Math.random() * greetings.length)], replyOpts);
        await maybeReact(ctx);
        return;
      }
      const fixedMention = fixedReply(ctx.chat.id, cleaned);
      if (fixedMention) { await ctx.reply(fixedMention, replyOpts); await maybeReact(ctx); return; }
      try { await aiReply(ctx, cleaned, `group:${ctx.chat.id}:${ctx.from.id}`); }
      catch (e) { console.error('Group AI error:', e.message); await ctx.reply('AI সেবায় এখন সমস্যা হচ্ছে। একটু পরে আবার বলো। 🌸', replyOpts).catch(() => {}); }
      await maybeReact(ctx);
      return;
    }
    const fixed = fixedReply(ctx.chat.id, text);
    if (fixed) { await ctx.reply(fixed, { reply_parameters: { message_id: msg.message_id } }); await maybeReact(ctx); return; }
    await maybeReact(ctx);
  }
});

bot.callbackQuery(/^sender:(owner|bot)$/, async ctx => {
  if (!isOwner(ctx)) return ctx.answerCallbackQuery({ text: 'শুধু Owner পারবেন।', show_alert: true });
  const flow = pending.get(keyOf(ctx)); if (!flow || flow.type !== 'button' || flow.step !== 'sender') return ctx.answerCallbackQuery({ text: 'এই ধাপের মেয়াদ শেষ। /baton দিয়ে আবার শুরু করো।', show_alert: true });
  flow.sender = ctx.match[1]; flow.step = 'confirm'; pending.set(keyOf(ctx), flow);
  const id = `button_${Date.now()}_${ctx.from.id}`; jobs.set(id, flow); flow.jobId = id;
  const label = flow.sender === 'owner' ? '👤 Owner-এর পক্ষ থেকে' : '🤖 Mim Jannat Bot-এর পক্ষ থেকে';
  const kb = new InlineKeyboard().url(flow.label, flow.url).row().text('✅ Send', `jobsend:${id}`).text('❌ Cancel', `jobcancel:${id}`);
  await ctx.answerCallbackQuery();
  await ctx.reply(`🔎 Button Message Preview\nপরিচয়: ${label}\nDestination: ${flow.destination}\nনিচের Preview-তে Button ও Send/Cancel আছে।`);
  const copied = await ctx.api.copyMessage(ctx.chat.id, flow.fromChatId, flow.messageId, { reply_markup: kb }).catch(e => { console.error('Button preview failed:', e.message); return null; });
  if (!copied) { jobs.delete(id); pending.delete(keyOf(ctx)); return ctx.reply('Button Preview তৈরি করা যায়নি। /baton দিয়ে আবার চেষ্টা করো।'); }
  pending.delete(keyOf(ctx));
});
bot.callbackQuery(/^jobsend:(.+)$/, async ctx => {
  if (!isOwner(ctx)) return ctx.answerCallbackQuery({ text: 'শুধু Owner পারবেন।', show_alert: true });
  const id = ctx.match[1], job = jobs.get(id); if (!job) return ctx.answerCallbackQuery({ text: 'এই Preview আর বৈধ নয়। আবার শুরু করো।', show_alert: true });
  try {
    if (job.type === 'button') {
      const label = job.sender === 'owner' ? '👤 Owner-এর পক্ষ থেকে' : '🤖 Mim Jannat Bot-এর পক্ষ থেকে';
      await ctx.api.sendMessage(job.destination, label);
      await ctx.api.copyMessage(job.destination, job.fromChatId, job.messageId, { reply_markup: new InlineKeyboard().url(job.label, job.url) });
    } else {
      await ctx.api.copyMessage(job.destination, job.fromChatId, job.messageId);
    }
    jobs.delete(id); await ctx.answerCallbackQuery({ text: 'মেসেজ পাঠানো হয়েছে।' });
    await ctx.editMessageText('✅ Destination-এ মেসেজ পাঠানো হয়েছে।').catch(() => {});
  } catch (e) { console.error('Send job failed:', e.message); await ctx.answerCallbackQuery({ text: 'পাঠানো যায়নি। বট গ্রুপে আছে এবং Send permission আছে কি না দেখো।', show_alert: true }); }
});
bot.callbackQuery(/^jobcancel:(.+)$/, async ctx => { if (!isOwner(ctx)) return ctx.answerCallbackQuery({ text: 'শুধু Owner পারবেন।', show_alert: true }); jobs.delete(ctx.match[1]); await ctx.answerCallbackQuery({ text: 'বাতিল করা হয়েছে।' }); await ctx.editMessageText('❌ পাঠানো বাতিল হয়েছে।').catch(() => {}); });

bot.on('channel_post', async ctx => { if (Math.random() < 0.2) { const e = ['❤️','👍','🔥','✨'][Math.floor(Math.random()*4)]; await ctx.api.setMessageReaction(ctx.chat.id, ctx.channelPost.message_id, [{ type: 'emoji', emoji: e }]).catch(err => console.error('Channel reaction:', err.message)); } });

const app = express();
app.get('/', (_req,res) => res.status(200).send('Mim Jannat bot is running.'));
app.get('/health', (_req,res) => res.status(200).json({ ok: true, bot: 'Mim Jannat', storage: DB_FILE }));
const server = app.listen(PORT, '0.0.0.0', () => console.log(`Health server listening on ${PORT}; data file: ${DB_FILE}`));
bot.catch(error => {
  console.error('Unhandled Telegram update error:', error.error || error);
});

let runnerHandle = null;
let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}; shutting down gracefully...`);
  try {
    if (runnerHandle) await runnerHandle.stop();
    await saveDb().catch(error => console.error('Final database save failed:', error.message));
  } catch (error) {
    console.error('Shutdown error:', error);
  } finally {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 8000).unref();
  }
}

(async () => {
  try {
    botInfo = await bot.api.getMe();
    // Remove a previously configured webhook before starting long polling.
    await bot.api.deleteWebhook({ drop_pending_updates: false });
    // Hide the "/" command-menu button in chats. Typed commands (/set, /list, /send ...) keep working,
    // because they are handled by bot.command(...) handlers and do not depend on the menu.
    const hideScopes = [undefined, { type: 'default' }, { type: 'all_private_chats' }, { type: 'all_group_chats' }, { type: 'all_chat_administrators' }];
    for (const scope of hideScopes) {
      for (const language_code of [undefined, 'bn', 'en']) {
        const options = {};
        if (scope) options.scope = scope;
        if (language_code) options.language_code = language_code;
        await bot.api.deleteMyCommands(options).catch(error => console.error('deleteMyCommands failed:', error.message));
      }
    }
    await saveDb().catch(error => console.error('Initial database save failed:', error.message));
    console.log(`Starting Mim Jannat as @${botInfo.username}; fixed owner ID=${OWNER_TELEGRAM_ID}`);
    runnerHandle = run(bot, {
      runner: { fetch: { allowed_updates: ['message', 'callback_query', 'my_chat_member', 'channel_post'] } },
      sink: { concurrency: 8 }
    });
    console.log('Mim Jannat concurrent long-polling runner started (max 8 updates).');
    runnerHandle.task()?.catch(error => {
      console.error('Polling runner stopped unexpectedly:', error);
      if (!shuttingDown) process.exit(1);
    });
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
  if (!shuttingDown) process.exit(1);
});
