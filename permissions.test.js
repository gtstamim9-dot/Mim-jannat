'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const createPermissionService = require('../permissions');

const OWNER = '7926785649';

test('Bot Creator gets global permission without a group API lookup', async () => {
  const p = createPermissionService({ ownerId: OWNER });
  const ctx = { from:{ id:Number(OWNER) }, api:{ getChatAdministrators(){ throw new Error('must not be called'); } } };
  const result = await p.canManageChat(ctx, -100123);
  assert.equal(result.allowed, true);
  assert.equal(result.role, 'bot_creator');
});

test('only Telegram status=creator is accepted as Group Creator', async () => {
  const p = createPermissionService({ ownerId: OWNER });
  const api = { async getChatAdministrators(){ return [
    { status:'administrator', user:{ id:111 } },
    { status:'creator', user:{ id:222 } }
  ]; } };
  assert.equal((await p.verifyGroupCreator(api, -1001, 222)).allowed, true);
  assert.equal((await p.verifyGroupCreator(api, -1001, 111)).allowed, false);
});

test('API failure is fail-closed and unverified', async () => {
  const p = createPermissionService({ ownerId: OWNER });
  const result = await p.verifyGroupCreator({ async getChatAdministrators(){ throw new Error('API unavailable'); } }, -1001, 222);
  assert.equal(result.allowed, false);
  assert.equal(result.verified, false);
  assert.ok(result.error);
});

test('missing user identity is never granted access', async () => {
  const p = createPermissionService({ ownerId: OWNER });
  const result = await p.verifyGroupCreator({ async getChatAdministrators(){ return [{status:'creator',user:{id:222}}]; } }, -1001, null);
  assert.equal(result.allowed, false);
  assert.equal(result.verified, false);
});
