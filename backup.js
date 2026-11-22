'use strict';
// Permanent memory for hosts with a temporary disk (e.g. Render Free).
// The whole database is copied to the Bot Creator's private chat as bot-data.json (and pinned). When the bot starts with an
// empty disk, it downloads the pinned file and restores everything: settings, Force Join channels, filters, warnings, schedules, AI memory.
// Nothing is deleted automatically except the previous backup message (it is replaced by the newer one).
const crypto = require('crypto');
const zlib = require('zlib');
const { InputFile } = require('grammy');

const MIN_INTERVAL_MS = 60 * 1000; // at most one backup per minute (was 5 min; shutdown and /backup still save immediately) (only when something changed)
const FIRST_DELAY_MS = 15 * 1000;
const FILE_NAME = 'bot-data.json.gz';       // gzip: ~10x smaller, so it stays far below Telegram's 20 MB bot download limit
const LEGACY_FILE_NAME = 'bot-data.json';   // older backups (plain JSON) can still be restored
const WARN_BYTES = 15 * 1024 * 1024;        // getFile cannot download files above 20 MB, so warn early

module.exports = function createBackup({ bot, db, ownerId, token }) {
  const api = bot.api;
  let timer = null, dirty = false, lastAt = 0, lastHash = '', busy = false, lastError = '';

  const snapshot = () => {
    const { backupMsgId, backupAt, ...rest } = db; // the backup bookkeeping itself is not part of the change detection
    return JSON.stringify({ ...rest, backupMsgId, backupAt });
  };
  const hashOf = () => { const { backupMsgId, backupAt, ...rest } = db; return crypto.createHash('sha1').update(JSON.stringify(rest)).digest('hex'); };

  async function restore() {
    try {
      const chat = await api.getChat(ownerId);
      const doc = chat && chat.pinned_message && chat.pinned_message.document;
      if (!doc || ![FILE_NAME, LEGACY_FILE_NAME].includes(doc.file_name)) return { ok: false, reason: 'পিন করা কোনো Backup পাওয়া যায়নি' };
      const f = await api.getFile(doc.file_id);
      const res = await fetch(`https://api.telegram.org/file/bot${token}/${f.file_path}`, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) return { ok: false, reason: `Backup ডাউনলোড ব্যর্থ (HTTP ${res.status})` };
      const raw = Buffer.from(await res.arrayBuffer());
      const data = JSON.parse((doc.file_name === FILE_NAME ? zlib.gunzipSync(raw) : raw).toString('utf8'));
      if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, reason: 'Backup ফাইল সঠিক নয়' };
      return { ok: true, data };
    } catch (e) { console.error('Backup restore failed:', e.message); return { ok: false, reason: e.message }; }
  }

  async function flush(force) {
    if (busy) return false;
    if (!force && !dirty) return false;
    busy = true;
    try {
      const h = hashOf();
      if (!force && h === lastHash) { dirty = false; return false; }
      const caption = `🗂 MIM JANNAT BOT — স্বয়ংক্রিয় Backup\n${new Date().toLocaleString('en-GB', { timeZone: 'Asia/Dhaka' })} (বাংলাদেশ সময়)\nএই ফাইলটি মুছবেন না — বট রিস্টার্ট হলে এখান থেকেই সব ডেটা ফিরে আসে।`;
      const old = db.backupMsgId;
      const payload = zlib.gzipSync(Buffer.from(snapshot(), 'utf8'));
      if (payload.length > WARN_BYTES) await api.sendMessage(ownerId, `⚠️ Backup ফাইল ${(payload.length / 1048576).toFixed(1)} MB হয়েছে। Telegram ২০ MB-র বেশি ফাইল ডাউনলোড করতে দেয় না, তাই সীমা পার হলে স্বয়ংক্রিয় Restore কাজ করবে না। পুরোনো AI স্মৃতি পরিষ্কার করুন বা Persistent Disk নিন।`).catch(() => {});
      const sent = await api.sendDocument(ownerId, new InputFile(payload, FILE_NAME), { caption, disable_notification: true });
      await api.pinChatMessage(ownerId, sent.message_id, { disable_notification: true }).catch(e => console.error('Backup pin failed:', e.message));
      db.backupMsgId = sent.message_id; db.backupAt = Date.now();
      if (old && old !== sent.message_id) { // keep the chat tidy: the previous backup is no longer needed
        await api.unpinChatMessage(ownerId, { message_id: old }).catch(() => {});
        await api.deleteMessage(ownerId, old).catch(() => {});
      }
      lastHash = h; lastAt = Date.now(); dirty = false; lastError = '';
      return true;
    } catch (e) { lastError = e.message; console.error('Backup failed:', e.message); return false; }
    finally { busy = false; }
  }

  function markDirty() {
    dirty = true;
    if (timer) return;
    const wait = Math.max(FIRST_DELAY_MS, lastAt + MIN_INTERVAL_MS - Date.now());
    timer = setTimeout(async () => { timer = null; await flush(false); if (dirty) markDirty(); }, wait);
    timer.unref?.();
  }

  const status = () => lastAt ? `শেষ Backup: ${new Date(lastAt).toLocaleString('en-GB', { timeZone: 'Asia/Dhaka' })}` : `Backup এখনো হয়নি${lastError ? ' (ত্রুটি: ' + lastError + ')' : ''}`;
  return { restore, flush, markDirty, status };
};
