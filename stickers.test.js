'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const createStickerReplier = require('../stickers');

const st = (id, emoji, extra = {}) => ({ file_id: 'f' + id, file_unique_id: 'u' + id, emoji, set_name: 'pack', type: 'regular', ...extra });
const apiWith = stickers => ({ calls: 0, async getStickerSet(name) { this.calls++; assert.equal(name, 'pack'); return { stickers }; } });

test('replies with a different sticker of the same pack and the same emoji', async () => {
  const api = apiWith([st(1, '😍'), st(2, '😍'), st(3, '😂'), st(4, '😍')]);
  const r = createStickerReplier({ random: () => 0 });
  const out = await r.choose(api, st(1, '😍'));
  assert.equal(out, 'f2');
});

test('falls back to any other sticker of the pack, then to the same sticker', async () => {
  const fresh = () => createStickerReplier({ random: () => 0 });
  assert.equal(await fresh().choose(apiWith([st(1, '😍'), st(3, '😂')]), st(1, '😍')), 'f3');
  assert.equal(await fresh().choose(apiWith([st(1, '😍')]), st(1, '😍')), 'f1');
  const broken = { async getStickerSet() { throw new Error('boom'); } };
  assert.equal(await createStickerReplier().choose(broken, st(9, '😍')), 'f9');
  assert.equal(await createStickerReplier().choose({}, { file_id: 'x', file_unique_id: 'y' }), 'x');
});

test('does not mix animated/video stickers with normal ones and caches the pack', async () => {
  const api = apiWith([st(1, '😍'), st(2, '😍', { is_animated: true }), st(3, '😍')]);
  const r = createStickerReplier({ random: () => 0 });
  assert.equal(await r.choose(api, st(1, '😍')), 'f3');
  await r.choose(api, st(1, '😍'));
  assert.equal(api.calls, 1);
});
