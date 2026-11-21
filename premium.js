'use strict';
// v2.0 Premium add-on. Additive module: does not replace legacy handlers or database keys.
const { InlineKeyboard } = require('grammy');
const { hasLink, matchesFilter, matchesTrigger, renderTemplate, categoryOf, containsProfanity } = require('./moderation-utils');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const noop = () => {};
module.exports = function createPremium(deps) {
  const { bot, db, saveDb, pending, keyOf, isOwner, isPrivate, isGroup, extra, permissions } = deps;
  const hooks = deps.hooks || null; // when given, the moderation middleware is mounted by features.js BEFORE the Force-Join gate
  db.premium = db.premium && typeof db.premium === 'object' && !Array.isArray(db.premium) ? db.premium : { groups: {}, schedules: [], templates: {} };
  db.premium.groups = db.premium.groups && typeof db.premium.groups === 'object' && !Array.isArray(db.premium.groups) ? db.premium.groups : {};
  db.premium.schedules = Array.isArray(db.premium.schedules) ? db.premium.schedules : [];
  db.premium.templates = db.premium.templates && typeof db.premium.templates === 'object' && !Array.isArray(db.premium.templates) ? db.premium.templates : {};
  const persist = async () => {
    try { await saveDb(); return true; }
    catch(e) { console.error('[premium] database save:', e.message); return false; }
  };
  const cfgFor = id => {
    const k = String(id);
    db.premium.groups[k] ||= {};
    const c = db.premium.groups[k];
    const moderationDefaults = { links:false, badWords:false, spam:false, flood:false, forwards:false, contacts:false, files:false, media:false, photos:false, videos:false, animations:false, caps:false, emoji:false, suspicious:false };
    c.moderation = { ...moderationDefaults, ...(c.moderation && typeof c.moderation === 'object' ? c.moderation : {}) };
    c.filters = Array.isArray(c.filters) ? c.filters : [];
    c.warnings = c.warnings && typeof c.warnings === 'object' ? c.warnings : {};
    c.warningLimit = Number.isInteger(c.warningLimit) ? Math.max(1, Math.min(20, c.warningLimit)) : 3;
    c.logs = Array.isArray(c.logs) ? c.logs : [];
    c.autoReplies = Array.isArray(c.autoReplies) ? c.autoReplies : [];
    c.stats = { messages:0, deleted:0, joins:0, leaves:0, warnings:0, spam:0, links:0, filtered:0, mutes:0, bans:0, daily:{}, ...(c.stats && typeof c.stats === 'object' ? c.stats : {}) };
    c.stats.daily = c.stats.daily && typeof c.stats.daily === 'object' ? c.stats.daily : {};
    c.welcome = { enabled:false, text:'আসসালামু আলাইকুম {name}! 🌸 গ্রুপে স্বাগতম।', mediaType:'', fileId:'', caption:'', deleteAfter:0, buttons:[], ...(c.welcome && typeof c.welcome === 'object' ? c.welcome : {}) };
    c.goodbye = { enabled:false, text:'আল্লাহ হাফেজ {name}! 🌙', deleteAfter:0, ...(c.goodbye && typeof c.goodbye === 'object' ? c.goodbye : {}) };
    c.notices = c.notices !== false;           // short auto-deleting notice after a message is removed
    c.adminMod = c.adminMod === true;          // group admins (with Restrict-members right) may use moderation commands; default OFF
    c.adminExempt = c.adminExempt !== false;   // group admins are exempt (Group Creator and Bot Creator are always exempt)
    c.warnAction = ['mute','restrict'].includes(c.warnAction) ? c.warnAction : 'mute';
    c.warnMinutes = Number.isInteger(c.warnMinutes) ? Math.max(1, Math.min(10080, c.warnMinutes)) : 60;
    c.welcome.buttons = Array.isArray(c.welcome.buttons) ? c.welcome.buttons : [];
    return c;
  };
  const esc = s => String(s || '').replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
  const onoff = v => v ? 'ON ✅' : 'OFF ⛔';
  const safeText = m => String(m.text || m.caption || '');
  const log = (c, entry) => { c.logs.unshift({ at:Date.now(), ...entry }); c.logs = c.logs.slice(0,300); };
  const anonHint = ctx => (ctx.from && String(ctx.from.id) === '1087968824') ? ' (আপনি Anonymous Admin হিসেবে লিখছেন — "Remain Anonymous" বন্ধ করে আবার চেষ্টা করুন।)' : '';
  const ownerPerm = async (ctx, chatId) => {
    const r = await permissions.canManageChat(ctx, chatId);
    if (r.error) console.error(`[premium] permission verification failed for ${chatId}:`, r.error.message);
    return Boolean(r && r.allowed && r.verified);
  };
  // Moderation commands (/warn /unwarn /mute /unmute /ban /unban): Bot Creator and the group's real Creator always;
  // group admins with the "Restrict members" right ONLY when the Group Creator switched "Admin Moderation" ON (default OFF = old behaviour).
  // Fail-closed: if Telegram cannot verify the role (or the sender is an anonymous admin), access is denied.
  const modPerm = async (ctx, chatId) => {
    if (await ownerPerm(ctx, chatId)) return true;
    if (!ctx.from || String(ctx.from.id) === '1087968824') return false;
    if (cfgFor(chatId).adminMod !== true) return false;
    try { const m = await ctx.api.getChatMember(chatId, ctx.from.id); return m.status === 'creator' || (m.status === 'administrator' && m.can_restrict_members === true); }
    catch (e) { console.error('[premium] admin moderation check failed:', e.message); return false; }
  };
  // Role lookup with a short cache so busy groups do not trigger one Telegram API call per message.
  const roleCache = new Map();
  const memberStatus = async (ctx, chatId, userId) => {
    const key = chatId + ':' + userId, hit = roleCache.get(key);
    if (hit && Date.now() - hit.t < 45000) return hit.s;
    try { const m = await ctx.api.getChatMember(chatId, userId); roleCache.set(key, { s:m.status, t:Date.now() }); return m.status; }
    catch (e) { console.error('[premium] role verification failed:', e.message); return null; }
  };

  const getBotId = () => { try { const i = deps.getBotInfo && deps.getBotInfo(); return i ? String(i.id) : null; } catch (e) { return null; } };
  // Returns null when the target may be punished; otherwise the reason. Fail-closed: if Telegram cannot verify, nobody is punished.
  const protectTarget = async (ctx, targetId) => {
    if (permissions.isOwnerId(targetId)) return 'owner';
    const botId = getBotId();
    if (botId && String(targetId) === botId) return 'bot';
    try { const m = await ctx.api.getChatMember(ctx.chat.id, targetId); return ['creator','administrator'].includes(m.status) ? 'admin' : null; }
    catch (e) { console.error('[premium] target verification failed:', e.message); return 'unverified'; }
  };
  const protectMsg = r => r === 'unverified' ? 'এই সদস্যের পদ Telegram থেকে যাচাই করা যায়নি, তাই ভুল Punishment এড়াতে কাজটি করা হয়নি।' : 'Admin, Creator বা বটের মালিককে Punish করা যায় না।';
  const penalize = async (api, chatId, c, uid, type) => {
    const permissionsObj = type === 'restrict'
      ? { can_send_messages:true, can_send_audios:false, can_send_documents:false, can_send_photos:false, can_send_videos:false, can_send_video_notes:false, can_send_voice_notes:false, can_send_polls:false, can_send_other_messages:false, can_add_web_page_previews:false }
      : { can_send_messages:false };
    await api.restrictChatMember(chatId, Number(uid), { permissions:permissionsObj, until_date:Math.floor(Date.now()/1000) + c.warnMinutes * 60 });
  };
  const FILTER_ACTIONS = ['delete','warn','mute','restrict'];
  const filterKb = (id, c) => {
    const kb = new InlineKeyboard();
    c.filters.forEach((f,i) => kb.text(`${i+1}. ${categoryOf(f.value)==='profanity'?'🤬 ':categoryOf(f.value)==='link'?'🔗 ':''}${String(f.value).slice(0,16)} ${f.enabled!==false?'✅':'⛔'}`,`pr:filtertoggle:${id}:${i}`).text('🎯 '+(f.action||'delete'),`px:fa:${id}:${i}`).text('🗑️',`pr:filterdelete:${id}:${i}`).row());
    return kb.text('⬅️ Dashboard','pr:home:'+id);
  };
  const templateView = (uid, id) => {
    const t = db.premium.templates[String(uid)] || [];
    const kb = new InlineKeyboard();
    t.slice(0,20).forEach((x,i) => kb.text(`📤 ${i+1} পাঠাও`,`px:tplsend:${id}:${i}`).text(`🗑️ ${i+1}`,`px:tpldel:${id}:${i}`).row());
    kb.text('⬅️ Dashboard','pr:home:'+id);
    return { text:t.length ? '📋 Saved Templates\n\n'+t.slice(0,20).map((x,i)=>`${i+1}. ${x.name}: ${String(x.text).slice(0,120)}`).join('\n')+'\n\n📤 = এই গ্রুপে পাঠাও • 🗑️ = মুছো। নতুন Template: /template' : 'কোনো Template নেই। /template দিয়ে সংরক্ষণ করো।', kb };
  };
  // Sends a configured welcome/goodbye (text or photo/video, buttons, safe HTML placeholders). Falls back to plain text if HTML is rejected.
  const sendConfigured = async (api, chatId, w, users, chat, replyTo) => {
    const kb = new InlineKeyboard();
    for (const b of (w.buttons || [])) kb.url(b.label, b.url).row();
    const raw = (w.mediaType && w.fileId) ? (w.caption || w.text) : w.text;
    const base = {};
    if (replyTo) base.reply_parameters = { message_id:replyTo, allow_sending_without_reply:true };
    if ((w.buttons || []).length) base.reply_markup = kb;
    const attempt = (opts, text) => {
      if (w.mediaType === 'photo' && w.fileId) return api.sendPhoto(chatId, w.fileId, { ...opts, caption:text });
      if (w.mediaType === 'video' && w.fileId) return api.sendVideo(chatId, w.fileId, { ...opts, caption:text });
      return api.sendMessage(chatId, text, opts);
    };
    try { return await attempt({ ...base, parse_mode:'HTML' }, renderTemplate(raw, users, chat, true)); }
    catch (e) { if (e && e.error_code && e.error_code !== 400) throw e; return attempt(base, renderTemplate(raw, users, chat, false)); }
  };
  const dashboard = (id, title='Group') => {
    const c = cfgFor(id), m = c.moderation;
    const kb = new InlineKeyboard()
      .text('✉️ Message Settings','pr:msg:'+id).text('🛡 Moderation','pr:mod:'+id).row()
      .text('🔗 Link Protection','pr:links:'+id).text('🤬 Bad Words','pr:words:'+id).row()
      .text('🚫 Anti-Spam','pr:spam:'+id).text('⚠️ Warning System','pr:warn:'+id).row()
      .text('🌸 Welcome','pr:welcome:'+id).text('💬 Auto Reply','pr:reply:'+id).row()
      .text('⏰ Automation','pr:auto:'+id).text('📊 Statistics','pr:stats:'+id).row()
      .text('⚙️ Advanced Settings','pr:advanced:'+id);
    return { text:`✨ PREMIUM GROUP DASHBOARD\n👑 Bot Creator: GTS Tarek\n${title}\n\nপ্রতিটি সেটিং শুধু এই গ্রুপে কার্যকর হবে।\n\nModeration: ${Object.values(m).filter(Boolean).length}/${Object.keys(m).length} enabled`, kb };
  };
  async function show(ctx, id, view) {
    await ctx.answerCallbackQuery().catch(noop);
    const c = cfgFor(id); let text='', kb = new InlineKeyboard().text('⬅️ Dashboard','pr:home:'+id);
    if (view === 'mod' || view === 'links' || view === 'spam') {
      const keys = view === 'links' ? ['links','suspicious'] : view === 'spam' ? ['spam','flood','forwards','contacts','files','media','photos','videos','animations','caps','emoji'] : Object.keys(c.moderation);
      const labels = {links:'Auto Delete Links',badWords:'Bad Words Filter',spam:'Spam Detection',flood:'Anti-Flood',forwards:'Anti-Forward',contacts:'Anti-Contact Sharing',files:'Anti-File',media:'Legacy Anti Media',photos:'Anti-Photo',videos:'Anti-Video',animations:'Anti-Animation',caps:'Anti-Caps',emoji:'Anti-Excessive Emoji',suspicious:'Suspicious Link Filter'};
      text = '🛡️ Moderation Controls\nপ্রতিটি নিয়ম আলাদাভাবে চালু/বন্ধ করো।\n\n' + keys.map(k=>`${labels[k]}: ${onoff(c.moderation[k])}`).join('\n');
      keys.forEach(k=>kb.text(`${labels[k]} ${c.moderation[k]?'🔴 OFF':'🟢 ON'}`,`pr:toggle:${id}:${k}`).row());
      kb.text('➕ Add Custom Word','pr:addword:'+id).text('📋 Filter List','pr:list:'+id).row();
    } else if (view === 'words') {
      text = '🤬 Custom Word Filters\nশব্দ যোগ, মুছতে বা ON/OFF করতে নিচের বাটন ব্যবহার করো।';
      kb.text('➕ Add Word','pr:addword:'+id).text('📋 View Filters','pr:list:'+id).row().text('🗑️ Remove Word','pr:delword:'+id);
    } else if (view === 'warn') {
      text = `⚠️ Warning System\nWarning Limit: ${c.warningLimit}\nLimit পূর্ণ হলে: ${c.warnAction === 'restrict' ? 'Restrict (শুধু Text)' : 'Mute'} — ${c.warnMinutes} মিনিট\nWarning আছে এমন সদস্য: ${Object.values(c.warnings).filter(n=>n>0).length}\n\nকমান্ড: /warn /unwarn /warnings (সদস্যের মেসেজে Reply করে)`;
      kb.text('➖ Limit','px:wl:'+id+':dec').text(`Limit: ${c.warningLimit}`,'px:wl:'+id+':noop').text('➕ Limit','px:wl:'+id+':inc').row()
        .text(`Action: ${c.warnAction === 'restrict' ? 'Restrict' : 'Mute'}`,'px:wa:'+id).text(`⏱ ${c.warnMinutes} মিনিট`,'px:wm:'+id).row()
        .text('📜 Warning History','pr:history:'+id).row();
    } else if (view === 'welcome') {
      text = `🌸 Welcome Settings\nStatus: ${onoff(c.welcome.enabled)}\nText: ${c.welcome.text}\nMedia: ${c.welcome.mediaType || 'None'}\nButtons: ${c.welcome.buttons.length}\nAuto delete: ${c.welcome.deleteAfter ? c.welcome.deleteAfter+'s' : 'OFF'}\nPlaceholders: {name} {username} {mention} {group}`;
      kb.text(c.welcome.enabled?'🔴 Turn OFF':'🟢 Turn ON','pr:welcometoggle:'+id).row().text('✏️ Edit Text','pr:welcometext:'+id).text('🖼️ Set Media','pr:welcomemedia:'+id).row().text('👁️ Preview','pr:welcomeview:'+id).text('🔘 Buttons','px:wbtn:'+id).row().text('⏱ Auto Delete','px:wdel:'+id).text('👋 Goodbye','px:bye:'+id);
    } else if (view === 'reply') {
      text = '💬 Custom Auto Replies\n' + (c.autoReplies.length ? c.autoReplies.map((x,i)=>`${i+1}. ${x.trigger} → ${x.reply} (${onoff(x.enabled!==false)})`).join('\n') : 'এখনো কোনো Auto Reply নেই।');
      kb.text('➕ Add Reply','pr:addreply:'+id).text('🗑️ Delete Reply','pr:delreply:'+id).row();
    } else if (view === 'auto') {
      text = '⏰ Automation\nScheduled announcements চালু করতে /schedule ব্যবহার করো।\nSchedules: '+db.premium.schedules.filter(x=>String(x.chatId)===String(id)).length;
      kb.text('➕ Schedule Message','pr:schedule:'+id).text('📋 Schedule List','px:sl:'+id).row();
    } else if (view === 'stats') {
      const s=c.stats;const sum=n=>{let t=0;for(let i=0;i<n;i++){const k=new Date(Date.now()-i*86400000).toISOString().slice(0,10);t+=s.daily[k]||0;}return t;};
      text=`📊 Group Statistics\nMessages: ${s.messages} (আজ ${sum(1)} • ৭ দিন ${sum(7)} • ৩০ দিন ${sum(30)})\nNew members: ${s.joins}\nLeft members: ${s.leaves}\nWarnings: ${s.warnings}\nMutes/Restrictions: ${s.mutes}\nBans: ${s.bans}\nDeleted messages: ${s.deleted}\nFiltered words: ${s.filtered}\nLinks removed: ${s.links}\nSpam events: ${s.spam}\nModeration logs: ${c.logs.length}\n\nনোট: সংখ্যাগুলো বট এই গ্রুপে সক্রিয় হওয়ার পর থেকে গণনা করা।`;
      kb.text('📜 Moderation History','pr:history:'+id).row();
    } else if (view === 'advanced') {
      text=`⚙️ Advanced Settings\nBot Creator ও এই গ্রুপের Creator সবসময় exemption পাবেন (লিংক, গালি ইত্যাদি কিছুতেই মেসেজ মুছবে না)।\nAdmin exemption: ${onoff(c.adminExempt)}\nমুছে ফেলার নোটিশ: ${onoff(c.notices)}\nAdmin Moderation (Admin-রা /warn /mute /ban পারবেন): ${onoff(c.adminMod)}\n\nBot-কে Admin করে "Delete messages" (ও Mute/Ban-এর জন্য "Restrict members") permission দিতে হবে, নাহলে moderation কাজ করবে না।`;
      kb.text(`Admin Exemption ${c.adminExempt?'🔴 OFF':'🟢 ON'}`,'pr:advtoggle:'+id+':adminExempt').row().text(`Admin Moderation ${c.adminMod?'🔴 OFF':'🟢 ON'}`,'pr:advtoggle:'+id+':adminMod').row().text(`মুছে ফেলার নোটিশ ${c.notices?'🔴 OFF':'🟢 ON'}`,'pr:advtoggle:'+id+':notices').row().text('🧹 Clear Moderation Logs','pr:clearlogs:'+id).row();
    } else {
      text='✉️ Message Builder\nবর্তমানে /send ও /baton-এর বিদ্যমান Preview + Button workflow অক্ষত আছে। Premium templates সংরক্ষণ: /template';
      kb.text('📋 Saved Templates','pr:templates:'+id).row();
    }
    return ctx.editMessageText(text,{reply_markup:kb}).catch(async e=>{ if(!/not modified/i.test(e.message||'')) { console.error('[premium] panel edit:',e.message); await ctx.reply(text,{reply_markup:kb}).catch(noop); } });
  }
  async function openSelection(ctx) {
    if (isGroup(ctx)) {
      if (!await ownerPerm(ctx,ctx.chat.id)) return ctx.reply('এই Dashboard শুধু Bot Creator অথবা এই গ্রুপের Creator ব্যবহার করতে পারবেন।');
      const v=dashboard(ctx.chat.id,ctx.chat.title); return ctx.reply(v.text,{reply_markup:v.kb});
    }
    if (!isPrivate(ctx)) return;
    const ids=[];
    for (const [id,g] of Object.entries(db.groups||{})) {
      if(g.active===false) continue;
      if(await ownerPerm(ctx,id)) ids.push({id,title:g.title||id});
    }
    if(!ids.length) return ctx.reply('তোমার Creator access থাকা কোনো registered group পাওয়া যায়নি।');
    const kb=new InlineKeyboard();
    ids.slice(0,80).forEach(g=>kb.text('👥 '+String(g.title).slice(0,45),'pr:select:'+g.id).row());
    return ctx.reply('👑 Premium Group Dashboard\nBot Creator: GTS Tarek\nযে গ্রুপের Premium Settings পরিচালনা করতে চাও সেটি Select করো।',{reply_markup:kb});
  }
  bot.command('premium', openSelection);
  bot.callbackQuery(/^pr:(.+)$/, async ctx => {
    const p=ctx.match[1].split(':'); const action=p[0], id=p[1];
    if(!id || !await ownerPerm(ctx,id)) return ctx.answerCallbackQuery({text:'🚫 এই গ্রুপের Settings পরিবর্তনের অনুমতি নেই।',show_alert:true});
    const c=cfgFor(id);
    if(action==='select'){ const v=dashboard(id,(db.groups[id]||{}).title||id); await ctx.answerCallbackQuery(); return ctx.editMessageText(v.text,{reply_markup:v.kb}).catch(noop); }
    if(action==='home'){ await ctx.answerCallbackQuery(); const v=dashboard(id,(db.groups[id]||{}).title||id); return ctx.editMessageText(v.text,{reply_markup:v.kb}).catch(noop); }
    if(action==='toggle') { const k=p[2]; if(!(k in c.moderation)) return ctx.answerCallbackQuery({text:'Unknown setting',show_alert:true}); c.moderation[k]=!c.moderation[k]; await persist(); return show(ctx,id,'mod'); }
    if(action==='advtoggle'){ const k=p[2]; if(!['adminExempt','notices','adminMod'].includes(k)) return ctx.answerCallbackQuery({text:'Unknown setting',show_alert:true}); c[k]=!c[k]; await persist(); return show(ctx,id,'advanced'); }
    if(action==='welcometoggle'){ c.welcome.enabled=!c.welcome.enabled; await persist(); return show(ctx,id,'welcome'); }
    if(action==='welcomeview'){ await ctx.answerCallbackQuery(); try{ await sendConfigured(ctx.api,ctx.chat.id,c.welcome,[ctx.from],{title:(db.groups[id]||{}).title||id}); }catch(e){ console.error('[premium] welcome preview:',e.message); await ctx.reply('Preview পাঠানো যায়নি। Text/Button পরীক্ষা করো।'); } return; }
    if(action==='addword'||action==='delword'||action==='addreply'||action==='delreply'||action==='welcometext'||action==='welcomemedia'||action==='schedule'){
      await ctx.answerCallbackQuery(); const flow={type:'premium_'+action,chatId:id,userId:String(ctx.from.id)}; pending.set(keyOf(ctx),flow);
      const prompts={addword:'যে নিষিদ্ধ শব্দটি যোগ করতে চাও পাঠাও।\n💡 "গালি" লিখলে সব ধরনের গালি, "লিংক" লিখলে সব ধরনের লিংক মুছে যাবে।',delword:'যে Filter নম্বরটি মুছতে চাও পাঠাও।',addreply:'Trigger শব্দটি পাঠাও।\nএকাধিক Trigger: hi|hello\nশব্দের অংশ মেলাতে: *শব্দ*',delreply:'যে Auto Reply নম্বরটি মুছতে চাও পাঠাও।',welcometext:'নতুন Welcome Text পাঠাও। {name} দিলে সদস্যের নাম বসবে।',welcomemedia:'একটি Photo অথবা Video পাঠাও।',schedule:'Announcement-এর Text পাঠাও। এরপর সময় দাও: YYYY-MM-DD HH:mm (বাংলাদেশ সময়)।'};
      return ctx.reply(prompts[action]+'\nবাতিল: /cancel');
    }
    if(action==='list'){ await ctx.answerCallbackQuery(); return ctx.reply(c.filters.length?'Filter List\n✅/⛔ চাপলে ON/OFF • 🎯 চাপলে Action বদলায় (delete → warn → mute → restrict) • 🗑️ = মুছো\nনোট: শব্দ পুরো শব্দ হিসেবে মেলে। শব্দের অংশ মেলাতে *শব্দ* লিখো।':'কোনো Custom Filter নেই।',{reply_markup:filterKb(id,c)}); }
    if(action==='history'){ await ctx.answerCallbackQuery(); return ctx.reply(c.logs.slice(0,30).map(x=>`${new Date(x.at).toLocaleString('en-GB',{timeZone:'Asia/Dhaka'})} | ${x.action} | ${x.userId||''} | ${x.reason||''}`).join('\n')||'কোনো Moderation Log নেই।'); }
    if(action==='filtertoggle'){const i=Number(p[2]);if(!c.filters[i])return ctx.answerCallbackQuery({text:'Filter পাওয়া যায়নি'});c.filters[i].enabled=c.filters[i].enabled===false;await persist();await ctx.answerCallbackQuery({text:'Filter status updated'});return ctx.editMessageReplyMarkup({reply_markup:filterKb(id,c)}).catch(noop);}
    if(action==='filterdelete'){const i=Number(p[2]);if(!c.filters[i])return ctx.answerCallbackQuery({text:'Filter পাওয়া যায়নি'});c.filters.splice(i,1);await persist();await ctx.answerCallbackQuery({text:'Filter মুছে ফেলা হয়েছে'});return ctx.editMessageReplyMarkup({reply_markup:filterKb(id,c)}).catch(noop);}
    if(action==='clearlogs'){ c.logs=[]; await persist(); await ctx.answerCallbackQuery({text:'Logs cleared'}); return show(ctx,id,'advanced'); }
    if(action==='warncfg'){ return show(ctx,id,'warn'); }
    if(action==='templates'){ await ctx.answerCallbackQuery(); const v=templateView(ctx.from.id,id); return ctx.reply(v.text,{reply_markup:v.kb}); }
    const map={mod:'mod',links:'links',spam:'spam',words:'words',warn:'warn',welcome:'welcome',reply:'reply',auto:'auto',stats:'stats',advanced:'advanced',msg:'msg'};
    if(map[action]) return show(ctx,id,map[action]);
    return ctx.answerCallbackQuery({text:'এই অপশনটি পাওয়া যায়নি।',show_alert:true});
  });

  // Premium conversational setup flows, isolated from existing pending flow types.
  bot.on('message', async (ctx,next)=>{
    const flow=pending.get(keyOf(ctx)); if(!flow || !String(flow.type||'').startsWith('premium_') || (ctx.message.text||'').startsWith('/')) return next();
    if(!await ownerPerm(ctx,flow.chatId)){pending.delete(keyOf(ctx));return ctx.reply('🚫 Permission নেই।');}
    const c=cfgFor(flow.chatId), t=safeText(ctx.message).trim();
    if(flow.type==='premium_addword') { if(!t)return ctx.reply('শব্দটি Text হিসেবে পাঠাও।'); const cat=categoryOf(t); c.filters.push({value:t.slice(0,200),enabled:true,action:'delete'}); const wasOff=!c.moderation.badWords; c.moderation.badWords=true; log(c,{action:'filter_add',userId:ctx.from.id,reason:t}); pending.delete(keyOf(ctx)); await persist();
      const note=cat==='profanity'?'🤬 এটি "গালি" ক্যাটাগরি হিসেবে ধরা হয়েছে — যেকোনো ধরনের গালি/অশ্লীল শব্দ (বাংলা, Banglish, English; বানান ঘুরিয়ে লিখলেও) স্বয়ংক্রিয়ভাবে মুছে যাবে।':cat==='link'?'🔗 এটি "লিংক" ক্যাটাগরি হিসেবে ধরা হয়েছে — যেকোনো ধরনের লিংক মুছে যাবে। Bot Creator ও গ্রুপ Creator লিংক দিতে পারবেন।':'নোট: শব্দটি পুরো শব্দ হিসেবে মেলে। শব্দের অংশ মেলাতে *শব্দ* লিখো।';
      return ctx.reply('✅ Filter যোগ হয়েছে।\n'+note+(wasOff?'\n(Bad Words Filter স্বয়ংক্রিয়ভাবে ON করা হয়েছে।)':'')); }
    if(flow.type==='premium_delword') { const i=Number(t)-1; if(!Number.isInteger(i)||i<0||i>=c.filters.length)return ctx.reply('সঠিক Filter নম্বর দাও।'); const f=c.filters.splice(i,1)[0]; pending.delete(keyOf(ctx)); await persist(); return ctx.reply('🗑️ Filter মুছে ফেলা হয়েছে: '+f.value); }
    if(flow.type==='premium_addreply') { if(!t)return ctx.reply('Trigger পাঠাও।'); flow.trigger=t;flow.type='premium_addreply_text';pending.set(keyOf(ctx),flow);return ctx.reply('এখন Auto Reply-এর উত্তর পাঠাও।'); }
    if(flow.type==='premium_addreply_text') { if(!t)return ctx.reply('উত্তরটি Text হিসেবে পাঠাও।'); c.autoReplies.push({trigger:flow.trigger,reply:t,enabled:true});pending.delete(keyOf(ctx));await persist();return ctx.reply('✅ Auto Reply সংরক্ষিত হয়েছে।'); }
    if(flow.type==='premium_delreply') { const i=Number(t)-1;if(!Number.isInteger(i)||i<0||i>=c.autoReplies.length)return ctx.reply('সঠিক নম্বর দাও।');c.autoReplies.splice(i,1);pending.delete(keyOf(ctx));await persist();return ctx.reply('🗑️ Auto Reply মুছে ফেলা হয়েছে।'); }
    if(flow.type==='premium_welcometext') { c.welcome.text=t.slice(0,1000);pending.delete(keyOf(ctx));await persist();return ctx.reply('✅ Welcome Text সংরক্ষিত হয়েছে।'); }
    if(flow.type==='premium_welcomemedia') { const ph=ctx.message.photo?.at(-1);const v=ctx.message.video;if(!ph&&!v)return ctx.reply('Photo অথবা Video পাঠাও।');c.welcome.mediaType=ph?'photo':'video';c.welcome.fileId=ph?ph.file_id:v.file_id;c.welcome.caption=ctx.message.caption||c.welcome.text;pending.delete(keyOf(ctx));await persist();return ctx.reply('✅ Welcome Media সংরক্ষিত হয়েছে।'); }
    if(flow.type==='premium_schedule') { if(!t)return ctx.reply('Announcement Text পাঠাও।');flow.text=t;flow.type='premium_schedule_time';pending.set(keyOf(ctx),flow);return ctx.reply('সময় পাঠাও: YYYY-MM-DD HH:mm (বাংলাদেশ সময়)।'); }
    if(flow.type==='premium_schedule_time') { const m=t.match(/^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d)$/);if(!m)return ctx.reply('Format: YYYY-MM-DD HH:mm');const yy=+m[1],mm=+m[2],dd=+m[3],hh=+m[4],mi=+m[5];const check=new Date(Date.UTC(yy,mm-1,dd,hh,mi));if(check.getUTCFullYear()!==yy||check.getUTCMonth()!==mm-1||check.getUTCDate()!==dd||hh>23||mi>59)return ctx.reply('সঠিক তারিখ ও সময় দাও: YYYY-MM-DD HH:mm');const at=Date.UTC(yy,mm-1,dd,hh-6,mi);if(at<Date.now()+30000)return ctx.reply('ভবিষ্যতের সময় দাও।');if(db.premium.schedules.some(x=>String(x.chatId)===String(flow.chatId)&&x.at===at&&x.text===flow.text&&['pending','sending','sent'].includes(x.status||'pending')))return ctx.reply('এই একই Announcement আগে Schedule করা হয়েছে।');
    db.premium.schedules.push({id:Date.now()+'_'+ctx.from.id,chatId:flow.chatId,text:flow.text,at,nextAt:at,createdBy:String(ctx.from.id),status:'pending',attempts:0});pending.delete(keyOf(ctx));await persist();return ctx.reply('⏰ Scheduled announcement সংরক্ষিত হয়েছে।'); }
    return next();
  });

  // Rich message composer: copies Telegram's original message so formatting/media are preserved.
  bot.command('pmsg', async ctx=>{
    if(!isPrivate(ctx))return ctx.reply('/pmsg শুধু Private Chat-এ ব্যবহার করো।');
    const ids=[];for(const [id,g] of Object.entries(db.groups||{})){if(g.active===false)continue;if(await ownerPerm(ctx,id))ids.push({id,title:g.title||id});}
    if(isOwner(ctx))for(const [id,g] of Object.entries(db.groups||{}))if(g.active!==false&&!ids.some(x=>x.id===id))ids.push({id,title:g.title||id});
    if(!ids.length)return ctx.reply('তোমার পরিচালনার অনুমতি থাকা কোনো Group পাওয়া যায়নি।');
    const kb=new InlineKeyboard();ids.slice(0,80).forEach(g=>kb.text('👥 '+String(g.title).slice(0,40),'pm:target:'+g.id).row());
    return ctx.reply('যে গ্রুপে Premium Message পাঠাতে চাও সেটি বেছে নাও।',{reply_markup:kb});
  });
  bot.callbackQuery(/^pm:(.+)$/,async ctx=>{
    const [action,id]=ctx.match[1].split(':');if(action==='callbackinfo')return ctx.answerCallbackQuery({text:'Mim Jannat Premium Button 🌸'});if(!id||!await ownerPerm(ctx,id))return ctx.answerCallbackQuery({text:'Permission denied',show_alert:true});
    if(action==='target'){pending.set(keyOf(ctx),{type:'premium_pmsg_content',chatId:id,userId:String(ctx.from.id),buttons:[]});await ctx.answerCallbackQuery();return ctx.reply('এখন Text/Photo/Video/Document/Audio/Voice মেসেজটি পাঠাও। Formatting ও Caption অক্ষত থাকবে।');}
    if(action==='yes'||action==='no'){const f=pending.get(keyOf(ctx));if(!f||f.type!=='premium_pmsg_buttons')return ctx.answerCallbackQuery({text:'Session expired',show_alert:true});await ctx.answerCallbackQuery();if(action==='no')return previewPremiumMessage(ctx,f);f.type='premium_pmsg_label';pending.set(keyOf(ctx),f);return ctx.reply('Button-এর নাম পাঠাও।');}
    if(action==='url'||action==='callback'){const f=pending.get(keyOf(ctx));if(!f||f.type!=='premium_pmsg_kind')return ctx.answerCallbackQuery({text:'Session expired',show_alert:true});await ctx.answerCallbackQuery();f.buttonType=action;f.type=action==='url'?'premium_pmsg_url':'premium_pmsg_more';if(action==='callback'){f.buttons.push({label:f.label,type:'callback'});pending.set(keyOf(ctx),f);return ctx.reply('Callback Button যোগ হয়েছে। আরও Button যোগ করবে?',{reply_markup:new InlineKeyboard().text('➕ হ্যাঁ','pm:yes:'+id).text('➡️ পাঠাও','pm:no:'+id)});}pending.set(keyOf(ctx),f);return ctx.reply('Button-এর URL পাঠাও (https:// অথবা t.me/ দিয়ে শুরু)।');}
    if(action==='send'){const f=pending.get(keyOf(ctx));if(!f||f.type!=='premium_pmsg_buttons'||!f.previewed||String(f.chatId)!==String(id))return ctx.answerCallbackQuery({text:'Preview-এর মেয়াদ শেষ। /pmsg দিয়ে আবার শুরু করো।',show_alert:true});await ctx.answerCallbackQuery();return sendPremiumMessage(ctx,f);}
    if(action==='undo'){const f=pending.get(keyOf(ctx));if(!f||!f.buttons)return ctx.answerCallbackQuery({text:'Session expired',show_alert:true});f.buttons.pop();f.previewed=false;await ctx.answerCallbackQuery({text:'শেষ Button সরানো হয়েছে'});return previewPremiumMessage(ctx,f);}
    if(action==='cancel'){pending.delete(keyOf(ctx));await ctx.answerCallbackQuery({text:'বাতিল'});return ctx.editMessageText('❌ Premium Message বাতিল করা হয়েছে।').catch(noop);}
    return ctx.answerCallbackQuery({text:'Unknown action'});
  });
  async function previewPremiumMessage(ctx,f){
    const kb=new InlineKeyboard();for(const b of f.buttons){kb.url(b.label,b.url).row();}
    try{await ctx.api.copyMessage(ctx.chat.id,ctx.chat.id,f.messageId,f.buttons.length?{reply_markup:kb}:{});}
    catch(e){console.error('[premium] preview failed:',e.message);pending.delete(keyOf(ctx));return ctx.reply('Preview তৈরি করা যায়নি। /pmsg দিয়ে আবার চেষ্টা করো।');}
    f.type='premium_pmsg_buttons';f.previewed=true;pending.set(keyOf(ctx),f);
    const ctl=new InlineKeyboard().text('✅ Confirm & Send','pm:send:'+f.chatId).text('❌ Cancel','pm:cancel:'+f.chatId).row().text('➕ আরও Button','pm:yes:'+f.chatId);
    if(f.buttons.length)ctl.text('↩️ শেষ Button বাদ','pm:undo:'+f.chatId);
    return ctx.reply(`👆 এটাই Preview। Destination: ${(db.groups[f.chatId]||{}).title||f.chatId}\nঠিক থাকলে Confirm চাপো।`,{reply_markup:ctl});
  }
  async function sendPremiumMessage(ctx,f){
    const kb=new InlineKeyboard();for(const b of f.buttons){if(b.type==='callback')kb.text(b.label,'pm:callbackinfo');else kb.url(b.label,b.url);kb.row();}
    try{await ctx.api.copyMessage(f.chatId,ctx.chat.id,f.messageId,f.buttons.length?{reply_markup:kb}:{});pending.delete(keyOf(ctx));await ctx.reply('✅ Premium Message পাঠানো হয়েছে।');}
    catch(e){console.error('[premium] message send:',e.message);await ctx.reply('মেসেজ পাঠানো যায়নি। Bot-কে Group-এ থাকতে হবে এবং Send Messages permission থাকতে হবে।');}
  }
  bot.callbackQuery('pm:callbackinfo',async ctx=>ctx.answerCallbackQuery({text:'এই Button-এর callback action configure করা হয়নি।',show_alert:true}));
  bot.on('message',async(ctx,next)=>{
    const f=pending.get(keyOf(ctx));if(!f||!String(f.type||'').startsWith('premium_pmsg')||(ctx.message.text||'').startsWith('/'))return next();
    if(!await ownerPerm(ctx,f.chatId)){pending.delete(keyOf(ctx));return ctx.reply('Permission নেই।');}
    const text=safeText(ctx.message).trim();
    if(f.type==='premium_pmsg_content'){f.messageId=ctx.message.message_id;f.type='premium_pmsg_buttons';pending.set(keyOf(ctx),f);return ctx.reply('মেসেজের সঙ্গে Button যুক্ত করবে?',{reply_markup:new InlineKeyboard().text('হ্যাঁ, Button যোগ করব','pm:yes:'+f.chatId).text('না, সরাসরি পাঠাও','pm:no:'+f.chatId)});}
    if(f.type==='premium_pmsg_label'){if(!text)return ctx.reply('Button-এর নাম Text হিসেবে পাঠাও।');f.label=text.slice(0,64);f.type='premium_pmsg_url';pending.set(keyOf(ctx),f);return ctx.reply('Button-এর URL পাঠাও (https:// অথবা t.me/ দিয়ে শুরু)।');}
    if(f.type==='premium_pmsg_url'){if(!/^https?:\/\//i.test(text)&&!/^t\.me\//i.test(text))return ctx.reply('সঠিক URL পাঠাও।');f.buttons.push({label:f.label,type:'url',url:/^t\.me\//i.test(text)?'https://'+text:text});f.previewed=false;f.type='premium_pmsg_buttons';pending.set(keyOf(ctx),f);return ctx.reply('Button যোগ হয়েছে। আরও Button যোগ করবে?',{reply_markup:new InlineKeyboard().text('➕ হ্যাঁ','pm:yes:'+f.chatId).text('➡️ পাঠাও','pm:no:'+f.chatId)});}
    return next();
  });
  bot.command('template',async ctx=>{if(!isPrivate(ctx))return;pending.set(keyOf(ctx),{type:'premium_template',userId:String(ctx.from.id)});return ctx.reply('যে Text Template সংরক্ষণ করতে চাও পাঠাও।');});
  bot.on('message',async(ctx,next)=>{const f=pending.get(keyOf(ctx));if(!f||f.type!=='premium_template'||(ctx.message.text||'').startsWith('/'))return next();const text=safeText(ctx.message).trim();if(!text)return ctx.reply('Text Template পাঠাও।');const uid=String(ctx.from.id);db.premium.templates[uid]||=[];db.premium.templates[uid].push({name:'Template '+(db.premium.templates[uid].length+1),text:text.slice(0,4000),createdAt:Date.now()});pending.delete(keyOf(ctx));await persist();return ctx.reply('✅ Template সংরক্ষিত হয়েছে।');});

  // Warning commands are group-scoped; target must be the replied-to member.
  bot.command('warn', async ctx=>{
    if(!isGroup(ctx)||!ctx.msg.reply_to_message?.from)return ctx.reply('সদস্যের মেসেজে Reply করে /warn দাও।');
    if(!await modPerm(ctx,ctx.chat.id))return ctx.reply('🚫 এই কমান্ড শুধু Bot Creator বা এই গ্রুপের Creator ব্যবহার করতে পারবেন।'+anonHint(ctx));
    const target=ctx.msg.reply_to_message.from;
    const prot=await protectTarget(ctx,target.id);if(prot)return ctx.reply(protectMsg(prot));
    const c=cfgFor(ctx.chat.id),uid=String(target.id);
    c.warnings[uid]=(c.warnings[uid]||0)+1;c.stats.warnings++;log(c,{action:'warning',userId:uid,reason:safeText(ctx.msg)});await persist();
    await ctx.reply(`⚠️ Warning ${c.warnings[uid]}/${c.warningLimit}`);
    if(c.warnings[uid]>=c.warningLimit){
      try{await penalize(ctx.api,ctx.chat.id,c,uid,c.warnAction);c.stats.mutes++;log(c,{action:'auto_'+c.warnAction,userId:uid,reason:'warning limit reached'});await persist();await ctx.reply(`🔇 Warning limit পূর্ণ হয়েছে — ${c.warnAction==='restrict'?'Restrict':'Mute'} (${c.warnMinutes} মিনিট) করা হয়েছে।`);}
      catch(e){console.error('[premium] auto punishment failed:',e.message);log(c,{action:'auto_punish_failed',userId:uid,reason:e.description||e.message});await persist();await ctx.reply('Punishment প্রয়োগ করা যায়নি। বটকে Admin বানিয়ে "Restrict members" permission দাও।');}
    }
  });
  bot.command('unwarn', async ctx=>{if(!isGroup(ctx)||!ctx.msg.reply_to_message?.from)return ctx.reply('সদস্যের মেসেজে Reply করে /unwarn দাও।');if(!await modPerm(ctx,ctx.chat.id))return ctx.reply('🚫 এই কমান্ড শুধু Bot Creator বা এই গ্রুপের Creator ব্যবহার করতে পারবেন।'+anonHint(ctx));const c=cfgFor(ctx.chat.id),uid=String(ctx.msg.reply_to_message.from.id);delete c.warnings[uid];log(c,{action:'unwarn',userId:uid});await persist();return ctx.reply('✅ Warning count reset হয়েছে।');});
  bot.command('mute', async ctx=>{
    if(!isGroup(ctx)||!ctx.msg.reply_to_message?.from)return ctx.reply('সদস্যের মেসেজে Reply করে /mute 10 দাও (মিনিট)।');
    if(!await modPerm(ctx,ctx.chat.id))return ctx.reply('🚫 এই কমান্ড শুধু Bot Creator বা এই গ্রুপের Creator ব্যবহার করতে পারবেন।'+anonHint(ctx));
    const n=Number((ctx.match||'10').replace(/\D/g,''))||10;const target=ctx.msg.reply_to_message.from;
    const prot=await protectTarget(ctx,target.id);if(prot)return ctx.reply(protectMsg(prot));
    try{await ctx.api.restrictChatMember(ctx.chat.id,target.id,{permissions:{can_send_messages:false},until_date:Math.floor(Date.now()/1000)+Math.min(n,10080)*60});const c=cfgFor(ctx.chat.id);c.stats.mutes++;log(c,{action:'mute',userId:String(target.id),reason:n+'m'});await persist();await ctx.reply(`🔇 ${Math.min(n,10080)} মিনিটের জন্য Mute করা হয়েছে।`);}
    catch(e){console.error('[premium] mute failed:',e.message);await ctx.reply('Mute করা যায়নি। বটকে Admin বানিয়ে "Restrict members" permission দাও।');}
  });
  bot.command('unmute', async ctx=>{if(!isGroup(ctx)||!ctx.msg.reply_to_message?.from)return ctx.reply('সদস্যের মেসেজে Reply করে /unmute দাও।');if(!await modPerm(ctx,ctx.chat.id))return ctx.reply('🚫 এই কমান্ড শুধু Bot Creator বা এই গ্রুপের Creator ব্যবহার করতে পারবেন।'+anonHint(ctx));try{await ctx.api.restrictChatMember(ctx.chat.id,ctx.msg.reply_to_message.from.id,{permissions:{can_send_messages:true,can_send_audios:true,can_send_documents:true,can_send_photos:true,can_send_videos:true,can_send_video_notes:true,can_send_voice_notes:true,can_send_polls:true,can_send_other_messages:true,can_add_web_page_previews:true}});await ctx.reply('✅ Unmute করা হয়েছে।');}catch(e){await ctx.reply('Unmute করা যায়নি।');}});

  bot.command(['gban','ban'],async ctx=>{
    if(!isGroup(ctx)||!ctx.msg.reply_to_message?.from)return ctx.reply('সদস্যের মেসেজে Reply করে /ban অথবা /ban 10 (মিনিট) দাও।');
    if(!await modPerm(ctx,ctx.chat.id))return ctx.reply('🚫 এই কমান্ড শুধু Bot Creator বা এই গ্রুপের Creator ব্যবহার করতে পারবেন।'+anonHint(ctx));
    const target=ctx.msg.reply_to_message.from;const prot=await protectTarget(ctx,target.id);if(prot)return ctx.reply(protectMsg(prot));
    const raw=(ctx.match||'').trim();const n=raw?Math.max(1,Number(raw.replace(/\D/g,''))||1):0;
    try{await ctx.api.banChatMember(ctx.chat.id,target.id,n?{until_date:Math.floor(Date.now()/1000)+Math.min(n,365*24*60)*60}:{});const c=cfgFor(ctx.chat.id);c.stats.bans++;log(c,{action:n?'temporary_ban':'ban',userId:String(target.id)});await persist();return ctx.reply(n?`⛔ ${n} মিনিটের Ban দেওয়া হয়েছে।`:'⛔ সদস্যকে Ban করা হয়েছে।');}
    catch(e){console.error('[premium] ban failed:',e.message);return ctx.reply('Ban করা যায়নি। বটকে Admin বানিয়ে "Ban users" permission দাও।');}
  });
  bot.command(['ungban','unban'],async ctx=>{if(!isGroup(ctx)||!ctx.msg.reply_to_message?.from)return ctx.reply('সদস্যের মেসেজে Reply করে /ungban দাও।');if(!await modPerm(ctx,ctx.chat.id))return ctx.reply('🚫 এই কমান্ড শুধু Bot Creator বা এই গ্রুপের Creator ব্যবহার করতে পারবেন।'+anonHint(ctx));try{await ctx.api.unbanChatMember(ctx.chat.id,ctx.msg.reply_to_message.from.id,{only_if_banned:true});log(cfgFor(ctx.chat.id),{action:'unban',userId:String(ctx.msg.reply_to_message.from.id)});await persist();return ctx.reply('✅ Unban করা হয়েছে।');}catch(e){return ctx.reply('Unban করা যায়নি।');}});

  // Moderation middleware: Bot Creator/Group Creator (and, by default, admins) exempt, independent per-group switches, audited actions.
  // Built-in smart detection: "Bad Words" removes any Bangla/Banglish/English abuse; a custom filter named "গালি" or "লিংক" acts on the whole category.
  const recent = new Map();
  const sweep = setInterval(() => { const now = Date.now(); for (const [k, v] of recent) { const last = Array.isArray(v) && v.length ? (typeof v[v.length-1] === 'number' ? v[v.length-1] : v[v.length-1].t) : 0; if (now - last > 60000) recent.delete(k); } for (const [k, v] of roleCache) if (now - v.t > 120000) roleCache.delete(k); }, 300000); sweep.unref?.();
  const REASON_TEXT = { link:'লিংক দেওয়া', suspicious_link:'সন্দেহজনক লিংক দেওয়া', profanity:'গালি/অশালীন ভাষা ব্যবহার', custom_filter:'নিষিদ্ধ শব্দ ব্যবহার', forward:'Forward করা', contact:'Contact শেয়ার', file:'ফাইল পাঠানো', media:'মিডিয়া পাঠানো', photo:'ছবি পাঠানো', video:'ভিডিও পাঠানো', animation:'GIF পাঠানো', caps:'অতিরিক্ত বড় হাতের লেখা', excessive_emoji:'অতিরিক্ত Emoji ব্যবহার', flood:'দ্রুত বার বার মেসেজ করা', repeated_message:'একই মেসেজ বার বার পাঠানো' };
  const noticeAt = new Map(), permNoticeAt = new Map();
  async function notifyRemoved(ctx, c, uid, reason, deleted) {
    try {
      const now = Date.now(), id = ctx.chat.id;
      if (!deleted) { // the bot could not delete: tell the group admins once in a while what is missing
        if (now - (permNoticeAt.get(id) || 0) < 600000) return;
        permNoticeAt.set(id, now);
        await ctx.api.sendMessage(id, '⚠️ একটি নিয়মভঙ্গকারী মেসেজ মুছতে পারিনি। বটকে Admin করে "Delete messages" permission দিন, তাহলে Moderation পুরোপুরি কাজ করবে।');
        return;
      }
      if (c.notices === false) return;
      const nk = id + ':' + uid;
      if (now - (noticeAt.get(nk) || 0) < 20000) return; // do not spam the group when someone posts many violations
      noticeAt.set(nk, now);
      const name = esc([ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ') || 'সদস্য');
      const sent = await ctx.api.sendMessage(id, `⚠️ <a href="tg://user?id=${Number(uid)}">${name}</a>, এই গ্রুপে ${REASON_TEXT[reason] || 'এই ধরনের মেসেজ'} নিষেধ। 🌸`, { parse_mode:'HTML' });
      setTimeout(() => ctx.api.deleteMessage(id, sent.message_id).catch(noop), 8000).unref?.();
    } catch (e) { console.error('[premium] removal notice failed:', e.message); }
  }
  const moderate = async(ctx,next)=>{
    const msg = ctx.message || ctx.editedMessage;
    if(!msg || !isGroup(ctx)) return next();
    const id=String(ctx.chat.id), c=cfgFor(id);
    if(msg.new_chat_members) { c.stats.joins += msg.new_chat_members.length; persist(); return next(); }
    if(msg.left_chat_member) { c.stats.leaves++; persist(); return next(); }
    if(!ctx.from || ctx.from.is_bot) return next();
    const uid=String(ctx.from.id), text=safeText(msg), m=c.moderation;
    if(ctx.message){c.stats.messages++;const day=new Date().toISOString().slice(0,10);c.stats.daily[day]=(c.stats.daily[day]||0)+1;const dk=Object.keys(c.stats.daily);if(dk.length>70)dk.sort().slice(0,dk.length-62).forEach(k=>delete c.stats.daily[k]);}
    // Exemptions: Bot Creator and the group's real Creator always; admins unless "Admin Exemption" is switched OFF.
    // If Telegram cannot verify the member's role, nothing is deleted (fail-safe: never moderate a group admin by mistake).
    let role = isOwner(ctx) ? 'creator' : await memberStatus(ctx,ctx.chat.id,ctx.from.id);
    if(role === null) return next();
    if(role === 'creator' || (role === 'administrator' && c.adminExempt !== false)) { if(c.stats.messages%25===0)persist(); return next(); }
    const now=Date.now(), key=id+':'+uid, arr=(recent.get(key)||[]).filter(t=>now-t<10000);arr.push(now);recent.set(key,arr);
    const same=String(msg.text||msg.caption||'').toLowerCase();const repeatKey=key+':repeat';const prev=recent.get(repeatKey)||[];prev.push({t:now,s:same});recent.set(repeatKey,prev.filter(x=>now-x.t<30000).slice(-6));
    let reason='';
    let matchedFilter=null, matchedCat=null;
    if(m.links&&hasLink(msg))reason='link';
    if(!reason&&m.suspicious&&/(bit\.ly|tinyurl\.com|cutt\.ly|grabify|iplogger)/i.test(text))reason='suspicious_link';
    if(!reason&&m.badWords){
      matchedFilter=c.filters.find(f=>{
        if(f.enabled===false)return false;
        const cat=categoryOf(f.value);
        if(cat==='link')return hasLink(msg);
        if(cat==='profanity')return Boolean(text)&&Boolean(containsProfanity(text));
        return matchesFilter(text,f.value);
      })||null;
      if(matchedFilter){reason='custom_filter';matchedCat=categoryOf(matchedFilter.value);}
      else if(text&&containsProfanity(text))reason='profanity';
    }
    if(!reason&&m.forwards&&msg.forward_origin)reason='forward';
    if(!reason&&m.contacts&&msg.contact)reason='contact';
    if(!reason&&m.files&&(msg.document||msg.audio||msg.voice))reason='file';
    if(!reason&&m.media&&(msg.photo||msg.video||msg.animation))reason='media';
    if(!reason&&m.photos&&msg.photo)reason='photo';
    if(!reason&&m.videos&&msg.video)reason='video';
    if(!reason&&m.animations&&msg.animation)reason='animation';
    if(!reason&&m.caps&&text.length>=12&&((text.replace(/[^A-Z]/g,'').length/Math.max(1,text.replace(/[^A-Za-z]/g,'').length))>.75))reason='caps';
    if(!reason&&m.emoji&&(Array.from(text).filter(ch=>/\p{Extended_Pictographic}/u.test(ch)).length>8))reason='excessive_emoji';
    if(!reason&&m.flood&&arr.length>7)reason='flood';
    if(!reason&&m.spam&&prev.filter(x=>x.s&&x.s===same).length>=3)reason='repeated_message';
    if(reason){
      const logReason = reason==='custom_filter' ? (matchedCat ? 'category:'+matchedCat : 'custom_filter') : reason;
      if(reason==='custom_filter' && matchedFilter && ['warn','mute','restrict'].includes(matchedFilter.action)) {
        // The offending message is always removed; then only the configured action is applied to its author.
        let deleted=false;
        try{await ctx.api.deleteMessage(ctx.chat.id,msg.message_id);c.stats.deleted++;deleted=true;}catch(e){console.error('[premium] delete failed:',e.message);log(c,{action:'delete_failed',userId:uid,reason:e.description||e.message});}
        c.stats.filtered++; if(matchedCat==='link')c.stats.links++;
        if(matchedFilter.action==='warn') {
          c.warnings[uid]=(c.warnings[uid]||0)+1;c.stats.warnings++;
          log(c,{action:'filter_warning',userId:uid,reason:String(matchedFilter.value)});
          await persist();
          await ctx.reply(`⚠️ এই গ্রুপের Filter অনুযায়ী Warning দেওয়া হয়েছে (${c.warnings[uid]}/${c.warningLimit})।`).catch(e=>console.error('[premium] warning notice:',e.message));
          if(c.warnings[uid]>=c.warningLimit) {
            try { await penalize(ctx.api,ctx.chat.id,c,uid,c.warnAction); c.stats.mutes++; log(c,{action:'auto_'+c.warnAction,userId:uid,reason:'warning limit reached'}); await persist(); }
            catch(e) { console.error('[premium] automatic punishment failed:',e.message); log(c,{action:'auto_punish_failed',userId:uid,reason:e.description||e.message}); await persist(); }
          }
        } else {
          try { await penalize(ctx.api,ctx.chat.id,c,uid,matchedFilter.action); c.stats.mutes++; log(c,{action:'filter_'+matchedFilter.action,userId:uid,reason:String(matchedFilter.value)}); }
          catch(e) { console.error('[premium] filter punishment failed:',e.message); log(c,{action:'filter_punish_failed',userId:uid,reason:e.description||e.message}); }
          await persist();
        }
        if(!deleted) await notifyRemoved(ctx,c,uid,matchedCat==='link'?'link':matchedCat==='profanity'?'profanity':reason,false);
        return;
      }
      let deleted=false;
      try{await ctx.api.deleteMessage(ctx.chat.id,msg.message_id);deleted=true;c.stats.deleted++;if(['flood','repeated_message','suspicious_link'].includes(reason))c.stats.spam++;if(reason==='custom_filter'||reason==='profanity')c.stats.filtered++;if(reason==='link'||reason==='suspicious_link'||matchedCat==='link')c.stats.links++;log(c,{action:'delete',userId:uid,reason:logReason});await persist();}
      catch(e){console.error('[premium] delete failed:',e.message);log(c,{action:'delete_failed',userId:uid,reason:e.description||e.message});await persist();}
      await notifyRemoved(ctx,c,uid,matchedCat==='link'?'link':matchedCat==='profanity'?'profanity':reason,deleted);
      return;
    }
    const auto=c.autoReplies.find(x=>x.enabled!==false&&matchesTrigger(x.trigger,text));if(auto){await ctx.reply(auto.reply,{reply_parameters:{message_id:msg.message_id}}).catch(e=>console.error('[premium] auto reply:',e.message));if(c.stats.messages%25===0)persist();return;}
    if(c.stats.messages%25===0)persist();
    return next();
  };
  // Mounted before the Force-Join gate when features.js provides the hook, so a message that mentions the bot can never skip moderation.
  if (hooks) hooks.moderate = moderate; else bot.use(moderate);

  // Scheduled announcements survive restarts because their due timestamps live in the existing JSON DB.
  let scheduleBusy=false;
  // A job is persisted as "sending" before the Telegram API call. If the process
  // crashes in that narrow window, it is marked "uncertain" on restart rather
  // than blindly resent (which could duplicate an announcement).
  for (const job of db.premium.schedules) {
    if (job.status === 'sending') { job.status = 'uncertain'; job.lastError = 'Process stopped while delivery was in progress; manual review required.'; }
  }
  const timer=setInterval(async()=>{
    if(scheduleBusy)return;
    scheduleBusy=true;
    try {
      const now=Date.now();
      const due=db.premium.schedules.filter(x=>(!x.status||x.status==='pending') && (x.nextAt||x.at)<=now);
      for(const job of due) {
        job.status='sending';
        const armed = await persist();
        if (!armed) { job.status='pending'; job.nextAt=Date.now()+60000; continue; }
        try {
          await bot.api.sendMessage(job.chatId,job.text);
          job.status='sent'; job.sentAt=Date.now();
          log(cfgFor(job.chatId),{action:'scheduled_announcement',userId:job.createdBy});
        } catch(e) {
          job.attempts=(job.attempts||0)+1;
          job.lastError=String(e.description||e.message||'Telegram send failed').slice(0,500);
          if(job.attempts>=5) job.status='failed';
          else { job.status='pending'; job.nextAt=Date.now()+Math.min(60,2**job.attempts)*60*1000; }
          console.error('[premium] scheduled send failed:',job.lastError);
        }
        await persist();
        await sleep(100);
      }
    } finally { scheduleBusy=false; }
  },15000);timer.unref?.();
  return { cfgFor, dashboard, openSelection, show, filterKb, protectTarget, sendConfigured, templateView, ownerPerm, FILTER_ACTIONS, onShutdown(){clearInterval(timer);clearInterval(sweep);} };
};
