require('dotenv').config();
const { Bot, InlineKeyboard } = require('grammy');
const express = require('express');
const fs = require('fs');
const path = require('path');

const BOT_TOKEN = process.env.BOT_TOKEN;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL = 'openai/gpt-4o-mini';
const PORT = Number(process.env.PORT || 10000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'bot-data.json');

if (!BOT_TOKEN) throw new Error('BOT_TOKEN is missing. Add it to the environment variables.');
if (!OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY is missing. Add it to the environment variables.');

fs.mkdirSync(DATA_DIR, { recursive: true });
const emptyDb = () => ({ ownerId: null, customReplies: {}, conversations: {} });
function loadDb() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    return { ...emptyDb(), ...parsed };
  } catch { return emptyDb(); }
}
let db = loadDb();
let saveQueue = Promise.resolve();
function saveDb() {
  const snapshot = JSON.stringify(db, null, 2);
  saveQueue = saveQueue.then(() => fs.promises.writeFile(DB_FILE + '.tmp', snapshot).then(() => fs.promises.rename(DB_FILE + '.tmp', DB_FILE)));
  return saveQueue;
}

const bot = new Bot(BOT_TOKEN);
let botInfo = null;
const pendingSet = new Map();
const pendingSend = new Map();
const sendJobs = new Map();

const DEFAULTS = [
  { keys: ['hi', 'hii', 'hiii', 'hello', 'helloo', 'hey', 'heyy'], reply: 'হ্যালো! 😊 কেমন আছো?' },
  { keys: ['আসসালামু আলাইকুম', 'আসসালামুয়ালাইকুম', 'সালাম', 'সালাম আলাইকুম'], reply: 'ওয়ালাইকুমুস সালাম! 🌸' },
  { keys: ['কেমন আছো', 'কেমন আছো ভাই', 'কেমন আছেন', 'how are you', 'how r u'], reply: 'আলহামদুলিল্লাহ ভালো আছি! তুমি কেমন আছো? 😊' },
  { keys: ['good morning', 'শুভ সকাল'], reply: 'শুভ সকাল! দিনটি সুন্দর কাটুক। ☀️' },
  { keys: ['good afternoon', 'শুভ দুপুর'], reply: 'শুভ দুপুর! 😊' },
  { keys: ['good evening', 'শুভ সন্ধ্যা'], reply: 'শুভ সন্ধ্যা! 🌆' },
  { keys: ['good night', 'শুভ রাত্রি', 'শুভরাত্রি'], reply: 'শুভ রাত্রি! ভালো থেকো। 🌙' },
  { keys: ['bye', 'goodbye', 'বাই', 'আল্লাহ হাফেজ'], reply: 'আল্লাহ হাফেজ! আবার কথা হবে। 💚' },
  { keys: ['ধন্যবাদ', 'থ্যাংক ইউ', 'thank you', 'thanks'], reply: 'স্বাগতম! 😊' },
  { keys: ['কি খবর', 'কী খবর', 'what is up', "what's up"], reply: 'সব ভালো! তোমার কী খবর? 😄' },
  { keys: ['কে তুমি', 'তোমার নাম কি', 'তোমার নাম কী', 'who are you'], reply: 'আমি Mim Jannat — তোমাদের গ্রুপের সহকারী বট। 🌸' },
  { keys: ['মাশাআল্লাহ', 'মাশাল্লাহ', 'মাশা আল্লাহ'], reply: 'আলহামদুলিল্লাহ! ❤️' },
  { keys: ['ইনশাআল্লাহ', 'ইনশাল্লাহ'], reply: 'ইনশাআল্লাহ। 🤍' }
];

function normalize(value) {
  return String(value || '').toLocaleLowerCase('en-US')
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[.,!?;:،؛؟…。、]+/g, ' ')
    .replace(/\s+/g, ' ').trim()
    .replace(/([a-z])\1{2,}/g, '$1$1');
}
function findDefault(text) {
  const n = normalize(text);
  for (const item of DEFAULTS) {
    if (item.keys.some(k => normalize(k) === n)) return item.reply;
  }
  return null;
}
function findCustom(chatId, text) {
  const list = db.customReplies[String(chatId)] || [];
  const n = normalize(text);
  const found = list.find(x => normalize(x.trigger) === n);
  return found ? found.reply : null;
}
function isGroup(ctx) { return ctx.chat && (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup'); }
function isOwner(ctx) { return !!db.ownerId && ctx.from && String(ctx.from.id) === String(db.ownerId); }
function isPrivate(ctx) { return ctx.chat && ctx.chat.type === 'private'; }
function senderName(ctx) {
  return [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(' ') || 'বন্ধু';
}
function isCommand(text) { return typeof text === 'string' && text.startsWith('/'); }

async function askAI(messages) {
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://render.com',
      'X-Title': 'Mim Jannat Telegram Bot'
    },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      messages: [
        { role: 'system', content: 'তুমি Mim Jannat নামের বন্ধুসুলভ Telegram সহকারী। স্বাভাবিক, ভদ্র ও সংক্ষিপ্ত বাংলায় উত্তর দেবে; ব্যবহারকারী ইংরেজিতে লিখলে ইংরেজিতে উত্তর দেবে। নিজেকে মানুষ বলে দাবি করবে না। ক্ষতিকর বা বিপজ্জনক কাজে নির্দেশনা দেবে না।' },
        ...messages
      ],
      temperature: 0.75,
      max_tokens: 500
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || `OpenRouter HTTP ${response.status}`);
  return data.choices?.[0]?.message?.content?.trim() || 'দুঃখিত, এই মুহূর্তে উত্তর তৈরি করতে পারছি না।';
}
async function aiReply(ctx, text, key) {
  const history = db.conversations[key] || [];
  history.push({ role: 'user', content: text.slice(0, 3000) });
  const clipped = history.slice(-10);
  await ctx.api.sendChatAction(ctx.chat.id, 'typing').catch(() => {});
  const answer = await askAI(clipped);
  clipped.push({ role: 'assistant', content: answer });
  db.conversations[key] = clipped.slice(-10);
  await saveDb();
 await ctx.reply(answer);

async function canManageGroupReplies(ctx) {
  // The bot's first private-chat owner may manage triggers too.
  // Telegram group creator is also allowed, even if they are not the bot owner.
  if (isOwner(ctx)) return true;
  try {
    const member = await ctx.api.getChatMember(ctx.chat.id, ctx.from.id);
    return member.status === 'creator';
  } catch (error) {
    console.error('Group creator check failed:', error.message);
    return false;
  }
}
async function react(ctx) {
  const choices = ['❤️', '👍', '🔥', '🥰', '✨'];
  if (Math.random() < 0.17) {
    const emoji = choices[Math.floor(Math.random() * choices.length)];
    await ctx.api.setMessageReaction(ctx.chat.id, ctx.msg.message_id, [{ type: 'emoji', emoji }]).catch(() => {});
  }
}

bot.command('start', async ctx => {
  if (!isPrivate(ctx)) return ctx.reply('আমাকে ব্যক্তিগত চ্যাটে /start দাও।');
  if (!db.ownerId) {
    db.ownerId = String(ctx.from.id);
    await saveDb();
    return ctx.reply(`আসসালামু আলাইকুম, ${senderName(ctx)}! 🌸\nতুমি প্রথমে /start করেছ, তাই এই বটের Owner হিসেবে সেট হয়েছ।\n\nআমি Mim Jannat। ব্যক্তিগত চ্যাটে AI-এর সঙ্গে কথা বলতে পারো।`);
  }
  if (isOwner(ctx)) return ctx.reply('আসসালামু আলাইকুম, Owner! 🌸\nMim Jannat চালু আছে। /help লিখে কমান্ডগুলো দেখো।');
  return ctx.reply('আসসালামু আলাইকুম! 🌸\nআমি Mim Jannat। কীভাবে সাহায্য করতে পারি?');
});

bot.command('help', async ctx => {
  const common = 'ব্যক্তিগত চ্যাটে সাধারণভাবে কথা বললেই AI উত্তর দেবে।\nগ্রুপে নির্দিষ্ট greeting-এর fixed reply পাবা; AI চালু হবে শুধু আমাকে mention করলে বা আমার মেসেজে reply দিলে।';
  const owner = '\n\nOwner কমান্ড:\n/send — গ্রুপে মেসেজ পাঠানো\n/id — বর্তমান চ্যাটের ID';
  const admin = '\n\nগ্রুপ Owner কমান্ড:\n/set — custom trigger তৈরি\n/list — trigger তালিকা\n/del — trigger মুছবে\n/cancel — চলমান কাজ বাতিল\n/id — গ্রুপ ID';
  return ctx.reply(common + (isOwner(ctx) ? owner : '') + (isGroup(ctx) ? admin : ''));
});

bot.command('id', async ctx => ctx.reply(`এই চ্যাটের ID: ${ctx.chat.id}\nতোমার Telegram ID: ${ctx.from.id}`));
bot.command('cancel', async ctx => {
  const key = `${ctx.chat.id}:${ctx.from.id}`;
  pendingSet.delete(key); pendingSend.delete(key);
  return ctx.reply('চলমান কাজ বাতিল করা হয়েছে।');
});

bot.command('set', async ctx => {
  if (!isGroup(ctx)) return ctx.reply('এই কমান্ডটি গ্রুপে ব্যবহার করো।');
  if (!(await canManageGroupReplies(ctx))) return ctx.reply('শুধু বটের Owner অথবা গ্রুপের Creator এই কমান্ড ব্যবহার করতে পারবেন।');
  pendingSet.set(`${ctx.chat.id}:${ctx.from.id}`, { step: 'trigger' });
  return ctx.reply('কোন মেসেজ/শব্দের জন্য reply সেট করতে চাও? Trigger লিখে পাঠাও।\nবাতিল করতে /cancel');
});
bot.command('list', async ctx => {
  if (!isGroup(ctx)) return;
  if (!(await canManageGroupReplies(ctx))) return ctx.reply('শুধু বটের Owner অথবা গ্রুপের Creator এই তালিকা দেখতে পারবেন।');
  const items = db.customReplies[String(ctx.chat.id)] || [];
  if (!items.length) return ctx.reply('এখনো কোনো custom reply সেট করা হয়নি।');
  return ctx.reply('Custom replies:\n' + items.map((x, i) => `${i + 1}. ${x.trigger} → ${x.reply}`).join('\n'));
});
bot.command('del', async ctx => {
  if (!isGroup(ctx)) return;
  if (!(await canManageGroupReplies(ctx))) return ctx.reply('শুধু বটের Owner অথবা গ্রুপের Creator এই কমান্ড ব্যবহার করতে পারবেন।');
  const items = db.customReplies[String(ctx.chat.id)] || [];
  const n = Number((ctx.match || '').trim());
  if (!Number.isInteger(n) || n < 1 || n > items.length) return ctx.reply('মুছতে /del 1 এভাবে নম্বর দাও। আগে /list দিয়ে তালিকা দেখো।');
  const removed = items.splice(n - 1, 1);
  db.customReplies[String(ctx.chat.id)] = items;
  await saveDb();
  return ctx.reply(`মুছে ফেলা হয়েছে: ${removed[0].trigger}`);
});

bot.command('send', async ctx => {
  if (!isPrivate(ctx) || !isOwner(ctx)) return ctx.reply('এই কমান্ডটি শুধু Owner ব্যক্তিগত চ্যাটে ব্যবহার করতে পারবেন।');
  pendingSend.set(`${ctx.chat.id}:${ctx.from.id}`, { step: 'content' });
  return ctx.reply('যে মেসেজটি গ্রুপে পাঠাতে চাও সেটি এখন পাঠাও। Text, photo, video, voice বা document দিতে পারো।\nবাতিল করতে /cancel');
});

bot.on('my_chat_member', async ctx => {
  const update = ctx.myChatMember;
  if (update.new_chat_member.status === 'member' || update.new_chat_member.status === 'administrator') {
    await ctx.api.sendMessage(update.chat.id, 'আসসালামু আলাইকুম! 🌸\nআমি Mim Jannat। এই গ্রুপে নির্দিষ্ট greeting-এর reply দেব, আর আমাকে mention/reply করলে AI উত্তর দেবে।').catch(() => {});
  }
});

bot.on('message', async ctx => {
  const msg = ctx.msg;
  const text = msg.text || msg.caption || '';
  const key = `${ctx.chat.id}:${ctx.from.id}`;

  if (isPrivate(ctx) && isOwner(ctx) && pendingSend.has(key) && !isCommand(text)) {
    const flow = pendingSend.get(key);
    if (flow.step === 'content') {
      const copy = await ctx.api.copyMessage(ctx.chat.id, ctx.chat.id, msg.message_id).catch(async () => null);
      if (!copy) return ctx.reply('এই মেসেজটি preview করা যায়নি। অন্যভাবে আবার পাঠাও অথবা /cancel দাও।');
      const jobId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      sendJobs.set(jobId, { fromChatId: ctx.chat.id, messageId: msg.message_id, ownerId: String(ctx.from.id) });
      pendingSend.set(key, { step: 'destination', jobId });
      return ctx.reply('Preview উপরে দেখানো হয়েছে। এখন destination গ্রুপের @username অথবা numeric Chat ID পাঠাও।\nPrivate invite link দিয়ে Bot API থেকে গ্রুপ খুঁজে পাওয়া যায় না; গ্রুপে /id দিলে Chat ID পাওয়া যাবে।');
    }
    if (flow.step === 'destination') {
      let destination = text.trim();
      const publicLink = destination.match(/(?:https?:\/\/)?t\.me\/([A-Za-z0-9_]{5,})\/?$/i);
      if (publicLink) destination = '@' + publicLink[1];
      const job = sendJobs.get(flow.jobId);
      if (!job) { pendingSend.delete(key); return ctx.reply('Preview-এর মেয়াদ শেষ। /send দিয়ে আবার শুরু করো।'); }
      job.destination = destination;
      sendJobs.set(flow.jobId, job);
      const keyboard = new InlineKeyboard().text('✅ Send', `send:${flow.jobId}`).text('❌ Cancel', `sendcancel:${flow.jobId}`);
      pendingSend.delete(key);
      return ctx.reply(`এই মেসেজটি পাঠানোর জন্য প্রস্তুত।\nDestination: ${destination}\n\nপাঠাব?`, { reply_markup: keyboard });
    }
  }

  if (isPrivate(ctx) && !isCommand(text) && text) {
    try { return await aiReply(ctx, text, `private:${ctx.from.id}`); }
    catch (e) { console.error('AI error:', e.message); return ctx.reply('AI সেবায় এখন সমস্যা হচ্ছে। একটু পরে আবার চেষ্টা করো।'); }
  }

  if (isGroup(ctx)) {
    if (pendingSet.has(key) && !isCommand(text) && text) {
      const flow = pendingSet.get(key);
      if (flow.step === 'trigger') {
        flow.trigger = text.trim(); flow.step = 'reply'; pendingSet.set(key, flow);
        return ctx.reply('এই trigger-এর জন্য bot কী উত্তর দেবে? Reply text পাঠাও।');
      }
      if (flow.step === 'reply') {
        const list = db.customReplies[String(ctx.chat.id)] || [];
        const existing = list.findIndex(x => normalize(x.trigger) === normalize(flow.trigger));
        const item = { trigger: flow.trigger, reply: text.trim() };
        if (existing >= 0) list[existing] = item; else list.push(item);
        db.customReplies[String(ctx.chat.id)] = list;
        pendingSet.delete(key); await saveDb();
        return ctx.reply(`সেট করা হয়েছে!\nTrigger: ${item.trigger}\nReply: ${item.reply}`);
      }
    }
    if (isCommand(text)) return;
    const fixed = findCustom(ctx.chat.id, text) || findDefault(text);
    if (fixed) { await ctx.reply(fixed, { reply_parameters: { message_id: msg.message_id } }); await react(ctx); return; }
    const mentioned = (msg.entities || []).some(e => e.type === 'mention' && text.slice(e.offset, e.offset + e.length).toLowerCase() === `@${botInfo.username.toLowerCase()}`);
    const repliedToBot = msg.reply_to_message?.from?.id === botInfo.id;
    if ((mentioned || repliedToBot) && text) {
      const cleaned = text.replace(new RegExp(`@${botInfo.username}`, 'ig'), '').trim() || 'হ্যালো';
      try { await aiReply(ctx, cleaned, `group:${ctx.chat.id}:${ctx.from.id}`); }
      catch (e) { console.error('Group AI error:', e.message); await ctx.reply('AI সেবায় এখন সমস্যা হচ্ছে।', { reply_parameters: { message_id: msg.message_id } }); }
    }
    await react(ctx);
  }
});

bot.on('channel_post', async ctx => {
  if (Math.random() < 0.22) {
    const emoji = ['❤️', '👍', '🔥', '✨'][Math.floor(Math.random() * 4)];
    await ctx.api.setMessageReaction(ctx.chat.id, ctx.channelPost.message_id, [{ type: 'emoji', emoji }]).catch(() => {});
  }
});

bot.callbackQuery(/^send:(.+)$/, async ctx => {
  const id = ctx.match[1]; const job = sendJobs.get(id);
  if (!job || String(ctx.from.id) !== job.ownerId || !isOwner(ctx)) return ctx.answerCallbackQuery({ text: 'এই Send request আর বৈধ নয়।' });
  try {
    await ctx.api.copyMessage(job.destination, job.fromChatId, job.messageId);
    sendJobs.delete(id);
    await ctx.answerCallbackQuery({ text: 'পাঠানো হয়েছে!' });
    await ctx.editMessageText(`✅ মেসেজ পাঠানো হয়েছে।\nDestination: ${job.destination}`);
  } catch (e) {
    console.error('Send failed:', e.message);
    await ctx.answerCallbackQuery({ text: 'পাঠানো যায়নি। Bot গ্রুপে আছে কি না এবং Chat ID ঠিক কি না দেখো।', show_alert: true });
  }
});
bot.callbackQuery(/^sendcancel:(.+)$/, async ctx => {
  const id = ctx.match[1]; const job = sendJobs.get(id);
  if (job && String(ctx.from.id) === job.ownerId) sendJobs.delete(id);
  await ctx.answerCallbackQuery({ text: 'বাতিল করা হয়েছে।' });
  await ctx.editMessageText('❌ Send বাতিল করা হয়েছে।');
});

const app = express();
app.get('/', (_req, res) => res.status(200).send('Mim Jannat bot is running.'));
app.get('/health', (_req, res) => res.status(200).json({ ok: true, bot: 'Mim Jannat' }));
const server = app.listen(PORT, '0.0.0.0', () => console.log(`Health server listening on ${PORT}`));

(async () => {
  try {
    botInfo = await bot.api.getMe();
    await bot.api.deleteWebhook({ drop_pending_updates: false });
    console.log(`Starting Mim Jannat as @${botInfo.username}`);
    await bot.start({ onStart: () => console.log('Mim Jannat polling started.') });
  } catch (error) {
    console.error('Bot startup failed:', error);
    server.close();
    process.exit(1);
  }
})();

process.once('SIGINT', () => { bot.stop(); server.close(); });
process.once('SIGTERM', () => { bot.stop(); server.close(); });
