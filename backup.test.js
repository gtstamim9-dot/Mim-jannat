'use strict';
try { require.resolve('grammy'); } catch (e) {
  const Module = require('module'); const orig = Module._resolveFilename; const fake = require.resolve('./_grammy-stub.js');
  Module._resolveFilename = function (request, ...rest) { return request === 'grammy' ? fake : orig.call(this, request, ...rest); };
}
const test = require('node:test');
const assert = require('node:assert/strict');
const createBackup = require('../backup');

function mock() {
  const log = []; let nextId = 100; let pinned = null; const files = {};
  const api = {
    async sendDocument(chat, file, o) { const m = { message_id: nextId++, document: { file_id: 'f' + nextId, file_name: file.filename } }; files[m.document.file_id] = file.data.toString(); log.push(['send', m.message_id]); return m; },
    async pinChatMessage(chat, id) { pinned = Object.values(files).length ? { message_id: id, document: { file_id: 'f' + (id + 1), file_name: 'bot-data.json' } } : null; log.push(['pin', id]); return true; },
    async unpinChatMessage(chat, o) { log.push(['unpin', o.message_id]); return true; },
    async deleteMessage(chat, id) { log.push(['delete', id]); return true; },
    async getChat() { return { pinned_message: pinned }; },
    async getFile(id) { return { file_path: id }; }
  };
  return { api, log, files };
}

test('backup: sends + pins the database, replaces the previous backup, and restore reads it back', async () => {
  const { api, log, files } = mock();
  const db = { ownerId: '1', premium: { groups: { 5: { filters: [{ value: 'গালি' }] } } }, forceJoin: { channels: [{ id: -1, title: 'X' }] } };
  const b = createBackup({ bot: { api }, db, ownerId: 1, token: 'T' });
  assert.equal(await b.flush(false), false || await Promise.resolve(false)); // nothing marked dirty yet
  assert.equal(await b.flush(true), true);
  assert.ok(log.some(x => x[0] === 'pin'));
  const firstId = db.backupMsgId; assert.ok(firstId);
  db.forceJoin.channels.push({ id: -2, title: 'Y' });
  assert.equal(await b.flush(true), true);
  assert.ok(log.some(x => x[0] === 'delete' && x[1] === firstId), 'old backup message removed');
  // restore: downloader returns the stored file content
  global.fetch = async url => ({ ok: true, status: 200, text: async () => files[String(url).split('/').pop()] });
  const r = await b.restore();
  assert.equal(r.ok, true);
  assert.equal(r.data.forceJoin.channels.length, 2);
  assert.equal(r.data.premium.groups[5].filters[0].value, 'গালি');
});

test('backup: unchanged data is not re-sent; no pinned file means a clear reason', async () => {
  const { api, log } = mock();
  const db = { a: 1 };
  const b = createBackup({ bot: { api }, db, ownerId: 1, token: 'T' });
  await b.flush(true); const n = log.filter(x => x[0] === 'send').length;
  b.markDirty(); await b.flush(false);
  assert.equal(log.filter(x => x[0] === 'send').length, n);
  const empty = createBackup({ bot: { api: { ...api, getChat: async () => ({}) } }, db, ownerId: 1, token: 'T' });
  const r = await empty.restore(); assert.equal(r.ok, false); assert.ok(r.reason);
});
