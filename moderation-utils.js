'use strict';

function messageText(message) {
  return String((message && (message.text || message.caption)) || '');
}

const TLDS = 'com|net|org|io|me|co|info|app|dev|xyz|bd|in|pk|uk|us|ly|gl|link|click|top|site|online|store|shop|live|club|vip|bio|cc|tv|fm|to|ws|biz|pro|cloud|tech|page|one|ru|cn|de|eu|ai|gg|ml|ga|tk|cf|gq|icu|fun|space|website|world|today|news|email|xxx|porn|sex|bet|win|casino|games|game|chat|group|social|network|zone|digital|media|blog';
// Bare domains ("example.com") are only recognised for TLDs that are not ordinary words, so a missing space after a full stop
// ("ok.Me too", "yes.In my opinion", "Hello.Today") is not mistaken for a link. Explicit forms (http://, www., t.me, tg://) always match.
const BARE_TLDS = 'com|net|org|io|info|biz|xyz|bd|pk|uk|ly|gl|cc|click|cloud|tech|dev|ru|cn|eu|gg|ml|ga|tk|cf|gq|icu|xxx|porn|sex|casino|bet|vip|club|tv|ws';
const TEXT_LINK_RE = new RegExp(
  '(?:https?:\\/\\/|www\\.|tg:\\/\\/|ftp:\\/\\/)\\S+' +
  '|(?:^|[\\s(\\[<])(?:t|telegram)\\s?\\.\\s?me\\s?\\/\\s?\\S+' +
  '|(?:^|[^\\p{L}\\p{N}@.-])(?:[\\p{L}][\\p{L}\\p{M}\\p{N}-]*\\.)+(?:' + BARE_TLDS + ')(?![\\p{L}\\p{N}-])(?:\\/\\S*)?', 'iu');

const DOT_WORD_RE = new RegExp('\\s+(?:dot|ডট)\\s+(?=(?:' + TLDS + ')(?![a-z]))', 'gi');
// Undo common tricks used to dodge link filters: "example [dot] com", "hxxp://", "t . me / x", full-width dots.
function deobfuscate(text) {
  return String(text || '')
    .normalize('NFKC')
    .replace(/[​-‍⁠﻿]/g, '')
    .replace(/[。｡．·•]/g, '.')
    .replace(/\s*[\[\(\{<]\s*(?:dot|\.)\s*[\]\)\}>]\s*/gi, '.')
    .replace(DOT_WORD_RE, '.')
    .replace(/h[x]{2}p(s?)/gi, 'http$1')
    .replace(/\s*:\s*\/\s*\/\s*/g, '://');
}

// True when the message carries any kind of link: URL / hidden text link entity, inline-button URL,
// bare domain (example.com), t.me / telegram.me / tg:// links, even if slightly obfuscated.
function hasLink(message) {
  if (!message) return false;
  const entities = [
    ...(Array.isArray(message.entities) ? message.entities : []),
    ...(Array.isArray(message.caption_entities) ? message.caption_entities : [])
  ];
  if (entities.some(entity => entity && ['url', 'text_link'].includes(entity.type))) return true;
  const rows = message.reply_markup && Array.isArray(message.reply_markup.inline_keyboard) ? message.reply_markup.inline_keyboard : [];
  if (rows.some(row => Array.isArray(row) && row.some(b => b && b.url))) return true;
  const text = messageText(message);
  return TEXT_LINK_RE.test(text) || TEXT_LINK_RE.test(deobfuscate(text));
}

// A custom filter whose text is only a category word ("গালি", "লিংক", "link", "abuse" ...) or a short sentence
// containing one ("কেউ গালি দিলে ডিলিট") acts on the whole category instead of that exact word.
const CATEGORY_WORDS = {
  link: ['লিংক', 'লিঙ্ক', 'লিন্ক', 'লিঙ্', 'link', 'links', 'url', 'urls', 'ইউআরএল', 'ওয়েবসাইট', 'website'],
  profanity: ['গালি', 'গালাগালি', 'গালাগাল', 'অশ্লীল', 'অশ্লিল', 'অশালীন', 'খারাপ কথা', 'বাজে কথা', 'বাজে ভাষা', 'খারাপ ভাষা', 'gali', 'galagali', 'gaali', 'abuse', 'abusive', 'swear', 'swearing', 'profanity', 'badword', 'badwords', 'bad word', 'bad words', 'vulgar']
};
function categoryOf(value) {
  const v = String(value == null ? '' : value).normalize('NFKC').toLocaleLowerCase('en-US').replace(/[​-‍﻿]/g, '').trim();
  if (!v || v.startsWith('*')) return null; // *word* = explicit "contains" filter, never a category
  const hit = cat => CATEGORY_WORDS[cat].some(w => {
    if (/^[a-z ]+$/.test(w)) return new RegExp('(?:^|[^a-z])' + w.replace(/ /g, '\\s+') + '(?![a-z])').test(v);
    return v.includes(w);
  });
  if (hit('profanity')) return 'profanity';
  if (hit('link')) return 'link';
  return null;
}

const strip = s => String(s == null ? '' : s).normalize('NFKC').toLocaleLowerCase('en-US').replace(/[\u200B-\u200D\uFEFF]/g, '');
const escapeRegex = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Custom word filter. Default = whole-word match (fewer false positives).
// Wrap the word in *stars* (e.g. *spam*) to match it anywhere inside a word.
function matchesFilter(text, word) {
  const t = strip(text);
  let w = strip(word).trim();
  if (!w) return false;
  if (w.length > 2 && w.startsWith('*') && w.endsWith('*')) {
    w = w.slice(1, -1).trim();
    return Boolean(w) && t.includes(w);
  }
  const body = escapeRegex(w).replace(/\s+/g, '\\s+');
  return new RegExp('(?<![\\p{L}\\p{M}\\p{N}_])' + body + '(?![\\p{L}\\p{M}\\p{N}_])', 'u').test(t);
}

// Auto-reply trigger. "hi|hello" = several triggers (exact, case-insensitive); "*word*" = contains.
function matchesTrigger(trigger, text) {
  const t = strip(text).replace(/\s+/g, ' ').trim();
  return String(trigger == null ? '' : trigger).split('|').map(s => s.trim()).filter(Boolean).some(part => {
    const contains = part.length > 2 && part.startsWith('*') && part.endsWith('*');
    const w = strip(contains ? part.slice(1, -1) : part).replace(/\s+/g, ' ').trim();
    if (!w) return false;
    return contains ? t.includes(w) : t === w;
  });
}

const escHtml = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const displayName = u => [u && u.first_name, u && u.last_name].filter(Boolean).join(' ') || 'বন্ধু';

// Renders {name} {username} {mention} {group}. html=true -> safe Telegram HTML (mention is a real tap-able mention).
function renderTemplate(text, users, chat, html = true) {
  const list = (Array.isArray(users) ? users : [users]).filter(Boolean);
  const esc = html ? escHtml : (s => String(s == null ? '' : s));
  const names = list.map(displayName).map(esc).join(', ') || 'বন্ধু';
  const usernames = list.map(u => u.username ? '@' + esc(u.username) : esc(displayName(u))).join(', ') || names;
  const mentions = list.map(u => html ? `<a href="tg://user?id=${Number(u.id)}">${escHtml(displayName(u))}</a>` : displayName(u)).join(', ') || names;
  const group = esc(chat && chat.title || '');
  const map = { name: names, username: usernames, mention: mentions, group };
  return esc(String(text == null ? '' : text)).replace(/\{(name|username|mention|group)\}/g, (_m, k) => map[k]);
}

const { containsProfanity } = require('./profanity');

module.exports = { messageText, hasLink, matchesFilter, matchesTrigger, renderTemplate, escHtml, categoryOf, containsProfanity };
