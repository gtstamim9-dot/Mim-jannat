'use strict';

// Central fail-closed permission service shared by every module.
module.exports = function createPermissionService({ ownerId }) {
  const OWNER_ID = String(ownerId);
  const isOwnerId = userId => userId != null && String(userId) === OWNER_ID;
  async function verifyGroupCreator(api, chatId, userId) {
    if (userId == null) return { allowed:false, verified:false, role:'unknown', error:new Error('Missing user ID') };
    try {
      const admins = await api.getChatAdministrators(chatId);
      const creator = admins.find(a => a && a.status === 'creator' && a.user && a.user.id != null);
      if (!creator) return { allowed:false, verified:false, role:'unknown', error:new Error('Telegram did not return a verifiable creator') };
      const allowed = String(creator.user.id) === String(userId);
      return { allowed, verified:true, role:allowed ? 'group_creator' : 'other', creatorId:String(creator.user.id) };
    } catch (error) {
      return { allowed:false, verified:false, role:'unknown', error };
    }
  }
  async function canManageChat(ctx, chatId) {
    if (ctx && ctx.from && isOwnerId(ctx.from.id)) return { allowed:true, verified:true, role:'bot_creator', error:null };
    if (!ctx || !ctx.from || chatId == null) return { allowed:false, verified:false, role:'unknown', error:new Error('Missing context') };
    const r = await verifyGroupCreator(ctx.api, chatId, ctx.from.id);
    return { ...r, error:r.error || null };
  }
  async function canManageCurrentGroup(ctx) {
    if (ctx && ctx.from && isOwnerId(ctx.from.id)) return { allowed:true, verified:true, role:'bot_creator', error:null };
    if (!ctx || !ctx.chat || !['group','supergroup'].includes(ctx.chat.type)) {
      return { allowed:false, verified:false, role:'unknown', error:new Error('Not a group chat') };
    }
    return canManageChat(ctx, ctx.chat.id);
  }
  return Object.freeze({ ownerId:OWNER_ID, isOwnerId, verifyGroupCreator, canManageChat, canManageCurrentGroup });
};
