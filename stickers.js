'use strict';
// Private-chat sticker reply: when the user sends a sticker, the bot answers with a sticker of the same kind.
// "Same kind" = a different sticker from the same pack with the same emoji (same mood); if the pack has none with that emoji,
// any other sticker of the pack (same animated/video type); if the pack cannot be read, the same sticker is sent back.
const CACHE_MS = 6 * 3600 * 1000;
const CACHE_MAX = 200;

module.exports = function createStickerReplier({ random = Math.random, now = Date.now } = {}) {
  const cache = new Map(); // set_name -> { t, stickers }
  const pick = arr => arr[Math.floor(random() * arr.length)];
  const kind = s => `${Boolean(s.is_animated)}:${Boolean(s.is_video)}`;

  async function packOf(api, name) {
    let c = cache.get(name);
    if (!c || now() - c.t > CACHE_MS) {
      const set = await api.getStickerSet(name);
      c = { t: now(), stickers: Array.isArray(set && set.stickers) ? set.stickers : [] };
      cache.delete(name);
      cache.set(name, c);
      if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    }
    return c.stickers;
  }

  // Returns the file_id of the sticker to send back (never throws).
  async function choose(api, sticker) {
    if (!sticker) return null;
    try {
      if (sticker.set_name && (!sticker.type || sticker.type === 'regular')) {
        const pool = (await packOf(api, sticker.set_name)).filter(x => x.file_unique_id !== sticker.file_unique_id && kind(x) === kind(sticker));
        const sameEmoji = sticker.emoji ? pool.filter(x => x.emoji === sticker.emoji) : [];
        if (sameEmoji.length) return pick(sameEmoji).file_id;
        if (pool.length) return pick(pool).file_id;
      }
    } catch (e) { console.error('Sticker pack lookup failed, echoing the sticker:', e.message); }
    return sticker.file_id;
  }
  return { choose };
};
