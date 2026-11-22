'use strict';
// Built-in smart abuse / profanity detector (Bangla, Banglish and English).
// Additive module: it does not replace the custom word filters, it works together with them.
//  - Bangla spelling variants are folded (ী/ি, ূ/ু, ণ/ন, শ/ষ/স ...), so common misspellings are still caught.
//  - Latin text tolerates repeated letters (fuuuck), separators (f.u.c.k / f u c k) and symbols (f*ck, sh!t, @ss).
//  - "Weak" words (short or ambiguous) match only as whole words (with common suffixes) to avoid false positives
//    such as "class", "assam", "হারাম" (religious term) or "চোদ্দ" (fourteen).

const ZERO_WIDTH = /[​-‍⁠﻿]/g;

// ---- Bangla folding (applied to both the message and the word list) ----
function foldBangla(s) {
  return s.replace(/ী/g, 'ি').replace(/ূ/g, 'ু').replace(/ণ/g, 'ন').replace(/[ষশ]/g, 'স').replace(/ৎ/g, 'ত');
}
const prep = s => foldBangla(String(s == null ? '' : s).normalize('NFKC').toLowerCase().replace(ZERO_WIDTH, '')).replace(/\s+/g, ' ').trim();

// ---- word lists ----
// STRONG: unambiguous, matched anywhere inside a word when long (>=6 chars), otherwise at the start of a word.
// WEAK:   matched only as a whole word, optionally followed by a common suffix.
const EN_STRONG = ['fuck', 'motherfuck', 'cocksucker', 'asshole', 'dumbass', 'jackass', 'dickhead', 'bullshit', 'bitch', 'faggot', 'nigger', 'whore', 'sonofabitch', 'son of a bitch', 'scumbag', 'cunt'];
const EN_WEAK = ['shit', 'ass', 'dick', 'pussy', 'slut', 'bastard', 'nigga', 'retard', 'idiot', 'moron', 'wanker', 'twat', 'fck', 'fuk', 'stfu'];

const BL_STRONG = ['madarchod', 'madarchud', 'madarchot', 'madarchoud', 'bokachoda', 'bokachuda', 'bokacoda', 'bokachod', 'behenchod', 'bhenchod', 'benchod', 'bhosdike', 'bhosdika', 'chutiya', 'chutiye', 'chutmarani', 'chudmarani', 'chodmarani', 'khankirpola', 'khankirchele', 'haramjada', 'haramzada', 'haramjadi', 'haramkhor', 'kuttarbaccha', 'kuttarbacha', 'kuttar bacha', 'kuttar baccha', 'shuorerbaccha', 'shuorer bacha', 'shuorer baccha', 'shuorer bachha', 'gandmara', 'magirpola', 'magirchele', 'magir pola', 'maderchod', 'bhosdi', 'randirpola', 'randir pola'];
const BL_WEAK = ['chudi', 'chuda', 'chudbo', 'chudmu', 'chudish', 'chudchi', 'chudte', 'chude', 'chudan', 'chudanir', 'chodna', 'chodon', 'chodi', 'choda', 'chodbo', 'magi', 'khanki', 'beshya', 'beshsha', 'bessha', 'harami', 'kutta', 'kuttar', 'shuor', 'shuar', 'gandu', 'gaandu', 'gaand', 'gand', 'baal', 'baaler', 'baler', 'lauda', 'lawra', 'lund', 'loda', 'bhosda', 'bhosri', 'chutia', 'shala', 'saala', 'dhemna', 'dhemni', 'jaroj', 'jarooj', 'bejonma', 'bejanma', 'fakyu', 'fakyou'];

const BN_STRONG = ['মাদারচোদ', 'মাদারচুদ', 'মাদার চোদ', 'বোকাচোদ', 'বোকাচুদ', 'চুদমারানি', 'চোদমারানি', 'চুতমারানি', 'চুতিয়া', 'খানকি', 'খানকির', 'হারামি', 'হারামজাদ', 'হারামখোর', 'কুত্তা', 'কুত্তার', 'কুকুরের বাচ্চা', 'সুয়োর', 'সুওর', 'সুয়র', 'গান্ডু', 'বেজন্মা', 'বেজন্ম', 'ঢেমনা', 'ঢেমনি', 'লাওড়া', 'লওড়া', 'লউড়া', 'লাউড়া', 'বেস্যা', 'বেশ্যা', 'রান্ডি', 'মাগিরপোলা', 'মাগির পোলা', 'মাগির ছেলে', 'চুদ'];
const BN_WEAK = ['মাগি', 'বাল', 'সালা', 'চোদা', 'চোদন', 'চোদনা', 'পোদ', 'জারজ', 'বান্দির', 'বান্দি', 'হিজড়া', 'হারামির', 'ফাকিং', 'ফাক ইউ'];

// ---- regex compilation ----
const LEFT = '(?<![\\p{L}\\p{M}\\p{N}_])';
const RIGHT = '(?![\\p{L}\\p{M}\\p{N}_])';
const SUF_EN = '(?:s|es|z|y|ty|ing|ed|er|ers|head|face|hole)?';
const SUF_BL = '(?:r|er|ra|der|ke|ta|ti|gulo|guli|pola|chele|bacha|bachha)?';
const SUF_BN = '(?:ের|র|রে|কে|রা|দের|টা|টি|গুলো|গুলা|ে)?';
// Letter classes that tolerate common symbol / number substitutions and "*" censoring.
const LEET = { a: '[a@4*]', e: '[e3*]', i: '[i1!|*]', o: '[o0*]', u: '[uv*]', s: '[s$5]', t: '[t7]', l: '[l1]', c: '[c(]', b: '[b8]', g: '[g9]' };
const escapeRe = ch => ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function latinPattern(word, loose) {
  const parts = [];
  for (const ch of word.replace(/\s+/g, '')) {
    const cls = LEET[ch] || escapeRe(ch);
    parts.push(cls + '+');
  }
  // Separators between letters are only allowed for long (unambiguous) words: f.u.c.k, f u c k
  return parts.join(loose ? '[^\\p{L}\\p{N}]{0,2}' : '');
}
function bengaliPattern(word) { return escapeRe(prep(word)).replace(/ /g, '\\s*'); }

const isBangla = w => /[ঀ-৿]/.test(w);
const entries = [];
function add(list, weak, suffix) {
  for (const raw of list) {
    const bn = isBangla(raw);
    let source;
    const strongLong = !weak && raw.replace(/\s+/g, '').length >= 6;
    if (bn) {
      const body = bengaliPattern(raw);
      source = weak ? LEFT + body + SUF_BN + RIGHT : (strongLong ? body : LEFT + body);
    } else {
      const body = latinPattern(raw, !weak && strongLong);
      source = weak ? LEFT + body + suffix + RIGHT : (strongLong ? body : LEFT + body);
    }
    entries.push({ word: raw, bn, weak, need: Math.ceil(raw.replace(/\s+/g, '').length / 2), re: new RegExp(source, 'iu') });
  }
}
add(EN_STRONG, false, SUF_EN); add(EN_WEAK, true, SUF_EN);
add(BL_STRONG, false, SUF_BL); add(BL_WEAK, true, SUF_BL);
add(BN_STRONG, false, SUF_BN); add(BN_WEAK, true, SUF_BN);


// Returns the matched word-list entry (string) or null.
function containsProfanity(text) {
  const t0 = prep(text);
  if (!t0) return null;
  // Tokens like "f u c k" / "f . u . c . k" (single letters) are joined first.
  const t = t0.replace(/(?<![a-z0-9])(?:[a-z][\s.\-_*]+){2,}[a-z](?![a-z0-9])/g, m => m.replace(/[\s.\-_*]+/g, ''));
  for (const e of entries) {
    const m = e.re.exec(t);
    if (!m) continue;
    if (!e.bn) {
      const letters = (m[0].match(/[a-z]/gi) || []).length;
      if (letters < e.need) continue; // e.g. "455" must not look like "ass"
    }
    return e.word;
  }
  return null;
}

module.exports = { containsProfanity, prepareForProfanity: prep, WORD_COUNT: entries.length };
