'use strict';
// v2.0 Premium add-on. Additive module: does not replace legacy handlers or database keys.
const { InlineKeyboard } = require('grammy');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const noop = () => {};
module.exports = function createPremium(deps) {
  const { bot, db, saveDb, pending, keyOf, isOwner, isPrivate, isGroup, extra } = deps;
  db.premium = db.premium && typeof db.premium === 'object' ? db.premium : { groups: {}, schedules: [], templates: {} };
  db.premium.groups = db.premium.groups || {};
  db.premium.schedules = Array.isArray(db.premium.schedules) ? db.premium.schedules : [];
  db.premium.templates = db.premium.templates || {};
  const persist = () => saveDb().catch(e => console.error('[premium] database save:', e.message));
  const cfgFor = id => {
    const k = String(id);
    db.premium.groups[k] ||= {};
    const c = db.premium.groups[k];
    c.moderation ||= { links:false, badWords:false, spam:false, flood:false, forwards:false, contacts:false, files:false, media:false, caps:false, emoji:false, suspicious:false };
    c.filters ||= []; c.warnings ||= {}; c.logs ||= []; c.autoReplies ||= []; c.stats ||= { messages:0, deleted:0, joins:0, warnings:0, spam:0, daily:{} };
    c.welcome ||= { enabled:false, text:'আসসালামু আলাইকুম {name}! 🌸 গ্রুপে স্বাগতম।', mediaType:'', fileId:'', caption:'', deleteAfter:0, buttons:[] };
    return c;
  };
  const esc = s => String(s || '').replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
  const onoff = v => v ? 'ON ✅' : 'OFF ⛔';
  const safeText = m => String(m.text || m.caption || '');
  const log = (c, entry) => { c.logs.unshift({ at:Date.now(), ...entry }); c.logs = c.logs.slice(0,300); };
  const ownerPerm = async (ctx, chatId) => {
    if (isOwner(ctx)) return true;
    const r = await extra.canManageChat(ctx, chatId);
    return Boolean(r && r.allowed);
  };
  const isAdmin = async (ctx, chatId, userId) => {
    try { const m = await ctx.api.getChatMember(chatId, userId); return ['creator','administrator'].includes(m.status); }
    catch (_) { return false; }
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
    return { text:`✨ PREMIUM GROUP DASHBOARD\n${title}\n\nপ্রতিটি সেটিং শুধু এই গ্রুপে কার্যকর হবে।\n\nModeration: ${Object.values(m).filter(Boolean).length}/${Object.keys(m).length} enabled`, kb };
  };
  async function show(ctx, id, view) {
    await ctx.answerCallbackQuery().catch(noop);
    const c = cfgFor(id); let text='', kb = new InlineKeyboard().text('⬅️ Dashboard','pr:home:'+id);
    if (view === 'mod' || view === 'links' || view === 'spam') {
      const keys = view === 'links' ? ['links','suspicious'] : view === 'spam' ? ['spam','flood','forwards','contacts','files','media','caps','emoji'] : Object.keys(c.moderation);
      const labels = {links:'Auto Delete Links',badWords:'Bad Words Filter',spam:'Spam Detection',flood:'Anti-Flood',forwards:'Anti-Forward',contacts:'Anti-Contact Sharing',files:'Anti-File',media:'Anti Photo/Video',caps:'Anti-Caps',emoji:'Anti-Excessive Emoji',suspicious:'Suspicious Link Filter'};
      text = '🛡️ Moderation Controls\nপ্রতিটি নিয়ম আলাদাভাবে চালু/বন্ধ করো।\n\n' + keys.map(k=>`${labels[k]}: ${onoff(c.moderation[k])}`).join('\n');
      keys.forEach(k=>kb.text(`${labels[k]} ${c.moderation[k]?'🔴 OFF':'🟢 ON'}`,`pr:toggle:${id}:${k}`).row());
      kb.text('➕ Add Custom Word','pr:addword:'+id).text('📋 Filter List','pr:list:'+id).row();
    } else if (view === 'words') {
      text = '🤬 Custom Word Filters\nশব্দ যোগ, মুছতে বা ON/OFF করতে নিচের বাটন ব্যবহার করো।';
      kb.text('➕ Add Word','pr:addword:'+id).text('📋 View Filters','pr:list:'+id).row().text('🗑️ Remove Word','pr:delword:'+id);
    } else if (view === 'warn') {
      text = `⚠️ Warning System\nWarning count সংরক্ষিত: ${Object.keys(c.warnings).length} members\nDefault action: 3 warnings হলে 1 hour mute.`;
      kb.text('⚙️ Threshold & Action','pr:warncfg:'+id).text('📜 Warning History','pr:history:'+id).row();
    } else if (view === 'welcome') {
      text = `🌸 Welcome Settings\nStatus: ${onoff(c.welcome.enabled)}\nText: ${c.welcome.text}\nMedia: ${c.welcome.mediaType || 'None'}\nAuto delete: ${c.welcome.deleteAfter || 0}s`;
      kb.text(c.welcome.enabled?'🔴 Turn OFF':'🟢 Turn ON','pr:welcometoggle:'+id).row().text('✏️ Edit Text','pr:welcometext:'+id).text('🖼️ Set Media','pr:welcomemedia:'+id).row().text('👁️ Preview','pr:welcomeview:'+id);
    } else if (view === 'reply') {
      text = '💬 Custom Auto Replies\n' + (c.autoReplies.length ? c.autoReplies.map((x,i)=>`${i+1}. ${x.trigger} → ${x.reply} (${onoff(x.enabled!==false)})`).join('\n') : 'এখনো কোনো Auto Reply নেই।');
      kb.text('➕ Add Reply','pr:addreply:'+id).text('🗑️ Delete Reply','pr:delreply:'+id).row();
    } else if (view === 'auto') {
      text = '⏰ Automation\nScheduled announcements চালু করতে /schedule ব্যবহার করো।\nSchedules: '+db.premium.schedules.filter(x=>String(x.chatId)===String(id)).length;
      kb.text('➕ Schedule Message','pr:schedule:'+id).row();
    } else if (view === 'stats') {
      const s=c.stats; text=`📊 Group Statistics\nMessages: ${s.messages}\nDeleted: ${s.deleted}\nNew members: ${s.joins}\nWarnings: ${s.warnings}\nSpam events: ${s.spam}\nModeration logs: ${c.logs.length}`;
      kb.text('📜 Moderation History','pr:history:'+id).row();
    } else if (view === 'advanced') {
      text='⚙️ Advanced Settings\nAdmin ও Creator স্বয়ংক্রিয়ভাবে exemption পাবে। Bot-এর প্রয়োজনীয় permission না থাকলে moderation action কাজ করবে না।';
      kb.text('🧹 Clear Moderation Logs','pr:clearlogs:'+id).row();
    } else {
      text='✉️ Message Builder\nবর্তমানে /send ও /baton-এর বিদ্যমান Preview + Button workflow অক্ষত আছে। Premium templates সংরক্ষণ: /template';
      kb.text('📋 Saved Templates','pr:templates:'+id).row();
    }
    return ctx.editMessageText(text,{reply_markup:kb}).catch(async e=>{ if(!/not modified/i.test(e.message||'')) { console.error('[premium] panel edit:',e.message); await ctx.reply(text,{reply_markup:kb}).catch(noop); } });
  }
  bot.command('premium', async ctx => {
    if (isGroup(ctx)) {
      if (!await ownerPerm(ctx,ctx.chat.id)) return ctx.reply('এই Dashboard শুধু Bot Creator অথবা এই গ্রুপের Creator ব্যবহার করতে পারবেন।');
      const v=dashboard(ctx.chat.id,ctx.chat.title); return ctx.reply(v.text,{reply_markup:v.kb});
    }
    if (!isPrivate(ctx)) return;
    const ids=[];
    for (const [id,g] of Object.entries(db.groups||{})) { if(g.active===false) continue; if(await ownerPerm(ctx,id)) ids.push({id,title:g.title||id}); }
    if(isOwner(ctx)) for(const [id,g] of Object.entries(db.groups||{})) if(g.active!==false&&!ids.some(x=>x.id===id)) ids.push({id,title:g.title||id});
    if(!ids.length) return ctx.reply('তোমার Creator access থাকা কোনো registered group পাওয়া যায়নি।');
    const kb=new InlineKeyboard(); ids.slice(0,80).forEach(g=>kb.text('👥 '+String(g.title).slice(0,45),'pr:select:'+g.id).row());
    return ctx.reply('যে গ্রুপের Premium Settings পরিচালনা করতে চাও সেটি Select করো।',{reply_markup:kb});
  });
  bot.callbackQuery(/^pr:(.+)$/, async ctx => {
    const p=ctx.match[1].split(':'); const action=p[0], id=p[1];
    if(!id || !await ownerPerm(ctx,id)) return ctx.answerCallbackQuery({text:'🚫 এই গ্রুপের Settings পরিবর্তনের অনুমতি নেই।',show_alert:true});
    const c=cfgFor(id);
    if(action==='select'){ const v=dashboard(id,(db.groups[id]||{}).title||id); await ctx.answerCallbackQuery(); return ctx.editMessageText(v.text,{reply_markup:v.kb}).catch(noop); }
    if(action==='home'){ await ctx.answerCallbackQuery(); const v=dashboard(id,(db.groups[id]||{}).title||id); return ctx.editMessageText(v.text,{reply_markup:v.kb}).catch(noop); }
    if(action==='toggle') { const k=p[2]; if(!(k in c.moderation)) return ctx.answerCallbackQuery({text:'Unknown setting',show_alert:true}); c.moderation[k]=!c.moderation[k]; await persist(); return show(ctx,id,'mod'); }
    if(action==='welcometoggle'){ c.welcome.enabled=!c.welcome.enabled; await persist(); return show(ctx,id,'welcome'); }
    if(action==='welcomeview'){ await ctx.answerCallbackQuery(); return ctx.reply(c.welcome.text.replaceAll('{name}','বন্ধু')); }
    if(action==='addword'||action==='delword'||action==='addreply'||action==='delreply'||action==='welcometext'||action==='welcomemedia'||action==='schedule'){
      await ctx.answerCallbackQuery(); const flow={type:'premium_'+action,chatId:id,userId:String(ctx.from.id)}; pending.set(keyOf(ctx),flow);
      const prompts={addword:'যে নিষিদ্ধ শব্দটি যোগ করতে চাও পাঠাও।',delword:'যে Filter নম্বরটি মুছতে চাও পাঠাও।',addreply:'Trigger শব্দটি পাঠাও।',delreply:'যে Auto Reply নম্বরটি মুছতে চাও পাঠাও।',welcometext:'নতুন Welcome Text পাঠাও। {name} দিলে সদস্যের নাম বসবে।',welcomemedia:'একটি Photo অথবা Video পাঠাও।',schedule:'Announcement-এর Text পাঠাও। এরপর সময় দাও: YYYY-MM-DD HH:mm (বাংলাদেশ সময়)।'};
      return ctx.reply(prompts[action]+'\nবাতিল: /cancel');
    }
    if(action==='list'){ await ctx.answerCallbackQuery(); const kb=new InlineKeyboard();c.filters.forEach((f,i)=>kb.text(`${i+1}. ${String(f.value).slice(0,24)} ${f.enabled!==false?'ON':'OFF'}`,`pr:filtertoggle:${id}:${i}`).text('🗑️',`pr:filterdelete:${id}:${i}`).row());return ctx.reply(c.filters.length?'Filter List — বাম বাটনে ON/OFF, 🗑️ দিয়ে Delete।':'কোনো Custom Filter নেই।',{reply_markup:kb}); }
    if(action==='history'){ await ctx.answerCallbackQuery(); return ctx.reply(c.logs.slice(0,30).map(x=>`${new Date(x.at).toLocaleString('en-GB',{timeZone:'Asia/Dhaka'})} | ${x.action} | ${x.userId||''} | ${x.reason||''}`).join('\n')||'কোনো Moderation Log নেই।'); }
    if(action==='filtertoggle'){const i=Number(p[2]);if(!c.filters[i])return ctx.answerCallbackQuery({text:'Filter পাওয়া যায়নি'});c.filters[i].enabled=c.filters[i].enabled===false;await persist();await ctx.answerCallbackQuery({text:'Filter status updated'});const kb=new InlineKeyboard();c.filters.forEach((f,j)=>kb.text(`${j+1}. ${String(f.value).slice(0,24)} ${f.enabled!==false?'ON':'OFF'}`,`pr:filtertoggle:${id}:${j}`).text('🗑️',`pr:filterdelete:${id}:${j}`).row());return ctx.editMessageReplyMarkup({reply_markup:kb}).catch(noop);}
    if(action==='filterdelete'){const i=Number(p[2]);if(!c.filters[i])return ctx.answerCallbackQuery({text:'Filter পাওয়া যায়নি'});c.filters.splice(i,1);await persist();await ctx.answerCallbackQuery({text:'Filter deleted'});return ctx.editMessageText('Filter মুছে ফেলা হয়েছে।').catch(noop);}
    if(action==='clearlogs'){ c.logs=[]; await persist(); await ctx.answerCallbackQuery({text:'Logs cleared'}); return show(ctx,id,'advanced'); }
    if(action==='warncfg'){ await ctx.answerCallbackQuery(); return ctx.reply('Warning rule: 3 warnings = 1 hour mute. সদস্যকে Reply করে /warn অথবা /unwarn ব্যবহার করো।'); }
    if(action==='templates'){ await ctx.answerCallbackQuery(); const t=db.premium.templates[String(ctx.from.id)]||[]; return ctx.reply(t.length?t.map((x,i)=>`${i+1}. ${x.name}: ${x.text}`).join('\n'):'কোনো Template নেই।'); }
    const map={mod:'mod',links:'links',spam:'spam',words:'words',warn:'warn',welcome:'welcome',reply:'reply',auto:'auto',stats:'stats',advanced:'advanced',msg:'msg'};
    if(map[action]) return show(ctx,id,map[action]);
    return ctx.answerCallbackQuery({text:'এই অপশনটি পাওয়া যায়নি।',show_alert:true});
  });

  // Premium conversational setup flows, isolated from existing pending flow types.
  bot.on('message', async (ctx,next)=>{
    const flow=pending.get(keyOf(ctx)); if(!flow || !String(flow.type||'').startsWith('premium_') || (ctx.message.text||'').startsWith('/')) return next();
    if(!await ownerPerm(ctx,flow.chatId)){pending.delete(keyOf(ctx));return ctx.reply('🚫 Permission নেই।');}
    const c=cfgFor(flow.chatId), t=safeText(ctx.message).trim();
    if(flow.type==='premium_addword') { if(!t)return ctx.reply('শব্দটি Text হিসেবে পাঠাও।'); c.filters.push({value:t,enabled:true,action:'delete'}); log(c,{action:'filter_add',userId:ctx.from.id,reason:t}); pending.delete(keyOf(ctx)); await persist(); return ctx.reply('✅ Custom Filter যোগ হয়েছে।'); }
    if(flow.type==='premium_delword') { const i=Number(t)-1; if(!Number.isInteger(i)||i<0||i>=c.filters.length)return ctx.reply('সঠিক Filter নম্বর দাও।'); const f=c.filters.splice(i,1)[0]; pending.delete(keyOf(ctx)); await persist(); return ctx.reply('🗑️ Filter মুছে ফেলা হয়েছে: '+f.value); }
    if(flow.type==='premium_addreply') { if(!t)return ctx.reply('Trigger পাঠাও।'); flow.trigger=t;flow.type='premium_addreply_text';pending.set(keyOf(ctx),flow);return ctx.reply('এখন Auto Reply-এর উত্তর পাঠাও।'); }
    if(flow.type==='premium_addreply_text') { if(!t)return ctx.reply('উত্তরটি Text হিসেবে পাঠাও।'); c.autoReplies.push({trigger:flow.trigger,reply:t,enabled:true});pending.delete(keyOf(ctx));await persist();return ctx.reply('✅ Auto Reply সংরক্ষিত হয়েছে।'); }
    if(flow.type==='premium_delreply') { const i=Number(t)-1;if(!Number.isInteger(i)||i<0||i>=c.autoReplies.length)return ctx.reply('সঠিক নম্বর দাও।');c.autoReplies.splice(i,1);pending.delete(keyOf(ctx));await persist();return ctx.reply('🗑️ Auto Reply মুছে ফেলা হয়েছে।'); }
    if(flow.type==='premium_welcometext') { c.welcome.text=t.slice(0,1000);pending.delete(keyOf(ctx));await persist();return ctx.reply('✅ Welcome Text সংরক্ষিত হয়েছে।'); }
    if(flow.type==='premium_welcomemedia') { const ph=ctx.message.photo?.at(-1);const v=ctx.message.video;if(!ph&&!v)return ctx.reply('Photo অথবা Video পাঠাও।');c.welcome.mediaType=ph?'photo':'video';c.welcome.fileId=ph?ph.file_id:v.file_id;c.welcome.caption=ctx.message.caption||c.welcome.text;pending.delete(keyOf(ctx));await persist();return ctx.reply('✅ Welcome Media সংরক্ষিত হয়েছে।'); }
    if(flow.type==='premium_schedule') { if(!t)return ctx.reply('Announcement Text পাঠাও।');flow.text=t;flow.type='premium_schedule_time';pending.set(keyOf(ctx),flow);return ctx.reply('সময় পাঠাও: YYYY-MM-DD HH:mm (বাংলাদেশ সময়)।'); }
    if(flow.type==='premium_schedule_time') { const m=t.match(/^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d)$/);if(!m)return ctx.reply('Format: YYYY-MM-DD HH:mm');const at=Date.UTC(+m[1],+m[2]-1,+m[3],+m[4]-6,+m[5]);if(at<Date.now()+30000)return ctx.reply('ভবিষ্যতের সময় দাও।');db.premium.schedules.push({id:Date.now()+'_'+ctx.from.id,chatId:flow.chatId,text:flow.text,at,createdBy:String(ctx.from.id)});pending.delete(keyOf(ctx));await persist();return ctx.reply('⏰ Scheduled announcement সংরক্ষিত হয়েছে।'); }
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
    if(action==='yes'||action==='no'){const f=pending.get(keyOf(ctx));if(!f||f.type!=='premium_pmsg_buttons')return ctx.answerCallbackQuery({text:'Session expired',show_alert:true});await ctx.answerCallbackQuery();if(action==='no')return sendPremiumMessage(ctx,f);f.type='premium_pmsg_label';pending.set(keyOf(ctx),f);return ctx.reply('Button-এর নাম পাঠাও।');}
    if(action==='url'||action==='callback'){const f=pending.get(keyOf(ctx));if(!f||f.type!=='premium_pmsg_kind')return ctx.answerCallbackQuery({text:'Session expired',show_alert:true});await ctx.answerCallbackQuery();f.buttonType=action;f.type=action==='url'?'premium_pmsg_url':'premium_pmsg_more';if(action==='callback'){f.buttons.push({label:f.label,type:'callback'});pending.set(keyOf(ctx),f);return ctx.reply('Callback Button যোগ হয়েছে। আরও Button যোগ করবে?',{reply_markup:new InlineKeyboard().text('➕ হ্যাঁ','pm:yes:'+id).text('➡️ পাঠাও','pm:no:'+id)});}pending.set(keyOf(ctx),f);return ctx.reply('Button-এর URL পাঠাও (https:// অথবা t.me/ দিয়ে শুরু)।');}
    return ctx.answerCallbackQuery({text:'Unknown action'});
  });
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
    if(f.type==='premium_pmsg_label'){if(!text)return ctx.reply('Button-এর নাম Text হিসেবে পাঠাও।');f.label=text.slice(0,64);f.type='premium_pmsg_kind';pending.set(keyOf(ctx),f);return ctx.reply('Button-এর ধরন বেছে নাও।',{reply_markup:new InlineKeyboard().text('🌐 URL Button','pm:url:'+f.chatId).text('⚡ Callback Button','pm:callback:'+f.chatId)});}
    if(f.type==='premium_pmsg_url'){if(!/^https?:\/\//i.test(text)&&!/^t\.me\//i.test(text))return ctx.reply('সঠিক URL পাঠাও।');f.buttons.push({label:f.label,type:'url',url:/^t\.me\//i.test(text)?'https://'+text:text});f.type='premium_pmsg_buttons';pending.set(keyOf(ctx),f);return ctx.reply('Button যোগ হয়েছে। আরও Button যোগ করবে?',{reply_markup:new InlineKeyboard().text('➕ হ্যাঁ','pm:yes:'+f.chatId).text('➡️ পাঠাও','pm:no:'+f.chatId)});}
    return next();
  });
  bot.command('template',async ctx=>{if(!isPrivate(ctx))return;pending.set(keyOf(ctx),{type:'premium_template',userId:String(ctx.from.id)});return ctx.reply('যে Text Template সংরক্ষণ করতে চাও পাঠাও।');});
  bot.on('message',async(ctx,next)=>{const f=pending.get(keyOf(ctx));if(!f||f.type!=='premium_template'||(ctx.message.text||'').startsWith('/'))return next();const text=safeText(ctx.message).trim();if(!text)return ctx.reply('Text Template পাঠাও।');const uid=String(ctx.from.id);db.premium.templates[uid]||=[];db.premium.templates[uid].push({name:'Template '+(db.premium.templates[uid].length+1),text:text.slice(0,4000),createdAt:Date.now()});pending.delete(keyOf(ctx));await persist();return ctx.reply('✅ Template সংরক্ষিত হয়েছে।');});

  // Warning commands are group-scoped; target must be the replied-to member.
  bot.command('warn', async ctx=>{if(!isGroup(ctx)||!ctx.msg.reply_to_message?.from)return ctx.reply('সদস্যের মেসেজে Reply করে /warn দাও।');if(!await ownerPerm(ctx,ctx.chat.id))return;const c=cfgFor(ctx.chat.id),uid=String(ctx.msg.reply_to_message.from.id);c.warnings[uid]=(c.warnings[uid]||0)+1;c.stats.warnings++;log(c,{action:'warning',userId:uid,reason:safeText(ctx.msg)});await persist();await ctx.reply(`⚠️ Warning ${c.warnings[uid]}/3`);if(c.warnings[uid]>=3){try{await ctx.api.restrictChatMember(ctx.chat.id,Number(uid),{permissions:{can_send_messages:false},until_date:Math.floor(Date.now()/1000)+3600});log(c,{action:'auto_mute',userId:uid,reason:'3 warnings'});await persist();}catch(e){await ctx.reply('Mute করা যায়নি। Bot Admin permission যাচাই করো।');}}});
  bot.command('unwarn', async ctx=>{if(!isGroup(ctx)||!ctx.msg.reply_to_message?.from)return ctx.reply('সদস্যের মেসেজে Reply করে /unwarn দাও।');if(!await ownerPerm(ctx,ctx.chat.id))return;const c=cfgFor(ctx.chat.id),uid=String(ctx.msg.reply_to_message.from.id);delete c.warnings[uid];await persist();return ctx.reply('✅ Warning count reset হয়েছে।');});
  bot.command('mute', async ctx=>{if(!isGroup(ctx)||!ctx.msg.reply_to_message?.from)return ctx.reply('সদস্যের মেসেজে Reply করে /mute 10m দাও।');if(!await ownerPerm(ctx,ctx.chat.id))return;const n=Number((ctx.match||'10').replace(/\D/g,''))||10;const uid=ctx.msg.reply_to_message.from.id;try{await ctx.api.restrictChatMember(ctx.chat.id,uid,{permissions:{can_send_messages:false},until_date:Math.floor(Date.now()/1000)+Math.min(n,10080)*60});await ctx.reply(`🔇 ${n} মিনিটের জন্য Mute করা হয়েছে।`);}catch(e){await ctx.reply('Mute করা যায়নি। Bot Admin permission যাচাই করো।');}});
  bot.command('unmute', async ctx=>{if(!isGroup(ctx)||!ctx.msg.reply_to_message?.from)return ctx.reply('সদস্যের মেসেজে Reply করে /unmute দাও।');if(!await ownerPerm(ctx,ctx.chat.id))return;try{await ctx.api.restrictChatMember(ctx.chat.id,ctx.msg.reply_to_message.from.id,{permissions:{can_send_messages:true,can_send_audios:true,can_send_documents:true,can_send_photos:true,can_send_videos:true,can_send_video_notes:true,can_send_voice_notes:true,can_send_polls:true,can_send_other_messages:true,can_add_web_page_previews:true}});await ctx.reply('✅ Unmute করা হয়েছে।');}catch(e){await ctx.reply('Unmute করা যায়নি।');}});

  bot.command('gban',async ctx=>{if(!isGroup(ctx)||!ctx.msg.reply_to_message?.from)return ctx.reply('সদস্যের মেসেজে Reply করে /gban অথবা /gban 10m দাও।');if(!await ownerPerm(ctx,ctx.chat.id))return;const raw=(ctx.match||'').trim();const n=raw?Math.max(1,Number(raw.replace(/\D/g,''))||1):0;try{await ctx.api.banChatMember(ctx.chat.id,ctx.msg.reply_to_message.from.id,n?{until_date:Math.floor(Date.now()/1000)+Math.min(n,365*24*60)*60}:{});log(cfgFor(ctx.chat.id),{action:n?'temporary_ban':'ban',userId:String(ctx.msg.reply_to_message.from.id)});await persist();return ctx.reply(n?`⛔ ${n} মিনিটের Ban দেওয়া হয়েছে।`:'⛔ সদস্যকে Ban করা হয়েছে।');}catch(e){return ctx.reply('Ban করা যায়নি। Bot Admin permission যাচাই করো।');}});
  bot.command('ungban',async ctx=>{if(!isGroup(ctx)||!ctx.msg.reply_to_message?.from)return ctx.reply('সদস্যের মেসেজে Reply করে /ungban দাও।');if(!await ownerPerm(ctx,ctx.chat.id))return;try{await ctx.api.unbanChatMember(ctx.chat.id,ctx.msg.reply_to_message.from.id,{only_if_banned:true});log(cfgFor(ctx.chat.id),{action:'unban',userId:String(ctx.msg.reply_to_message.from.id)});await persist();return ctx.reply('✅ Unban করা হয়েছে।');}catch(e){return ctx.reply('Unban করা যায়নি।');}});

  // Moderation middleware: admin/creator exemption, independent per-group switches, audited actions.
  const recent = new Map();
  bot.use(async(ctx,next)=>{
    if(!ctx.message||!isGroup(ctx)||!ctx.from||ctx.from.is_bot||ctx.message.new_chat_members||ctx.message.left_chat_member)return next();
    const id=String(ctx.chat.id), c=cfgFor(id), msg=ctx.message, uid=String(ctx.from.id), text=safeText(msg), m=c.moderation;
    c.stats.messages++;const day=new Date().toISOString().slice(0,10);c.stats.daily[day]=(c.stats.daily[day]||0)+1;
    if(msg.new_chat_members)c.stats.joins+=msg.new_chat_members.length;
    if(isOwner(ctx)||await isAdmin(ctx,ctx.chat.id,ctx.from.id)) { if(c.stats.messages%25===0)persist(); return next(); }
    const now=Date.now(), key=id+':'+uid, arr=(recent.get(key)||[]).filter(t=>now-t<10000);arr.push(now);recent.set(key,arr);
    const same=String(msg.text||msg.caption||'').toLowerCase();const repeatKey=key+':repeat';const prev=recent.get(repeatKey)||[];prev.push({t:now,s:same});recent.set(repeatKey,prev.filter(x=>now-x.t<30000).slice(-6));
    let reason='';
    if(m.links&&/(https?:\/\/|www\.|t\.me\/|@[A-Za-z0-9_]{5,})/i.test(text))reason='link';
    if(!reason&&m.suspicious&&/(bit\.ly|tinyurl\.com|cutt\.ly|grabify|iplogger)/i.test(text))reason='suspicious_link';
    if(!reason&&m.badWords&&c.filters.some(f=>f.enabled!==false&&text.toLowerCase().includes(String(f.value).toLowerCase())))reason='custom_filter';
    if(!reason&&m.forwards&&msg.forward_origin)reason='forward';
    if(!reason&&m.contacts&&msg.contact)reason='contact';
    if(!reason&&m.files&&(msg.document||msg.audio||msg.voice))reason='file';
    if(!reason&&m.media&&(msg.photo||msg.video||msg.animation))reason='media';
    if(!reason&&m.caps&&text.length>=12&&((text.replace(/[^A-Z]/g,'').length/Math.max(1,text.replace(/[^A-Za-z]/g,'').length))>.75))reason='caps';
    if(!reason&&m.emoji&&(Array.from(text).filter(ch=>/\p{Extended_Pictographic}/u.test(ch)).length>8))reason='excessive_emoji';
    if(!reason&&m.flood&&arr.length>7)reason='flood';
    if(!reason&&m.spam&&prev.filter(x=>x.s&&x.s===same).length>=3)reason='repeated_message';
    if(reason){
      try{await ctx.api.deleteMessage(ctx.chat.id,msg.message_id);c.stats.deleted++;if(['flood','repeated_message','suspicious_link'].includes(reason))c.stats.spam++;log(c,{action:'delete',userId:uid,reason});await persist();}
      catch(e){console.error('[premium] delete failed:',e.message);log(c,{action:'delete_failed',userId:uid,reason:e.description||e.message});await persist();}
      return;
    }
    const auto=c.autoReplies.find(x=>x.enabled!==false&&x.trigger.toLowerCase()===text.trim().toLowerCase());if(auto){await ctx.reply(auto.reply,{reply_parameters:{message_id:msg.message_id}}).catch(e=>console.error('[premium] auto reply:',e.message));if(c.stats.messages%25===0)persist();return;}
    if(c.stats.messages%25===0)persist();
    return next();
  });

  // Scheduled announcements survive restarts because their due timestamps live in the existing JSON DB.
  let scheduleBusy=false;
  const timer=setInterval(async()=>{if(scheduleBusy)return;scheduleBusy=true;try{const now=Date.now(),due=db.premium.schedules.filter(x=>x.at<=now);for(const job of due){try{await bot.api.sendMessage(job.chatId,job.text);log(cfgFor(job.chatId),{action:'scheduled_announcement',userId:job.createdBy});}catch(e){console.error('[premium] scheduled send failed:',e.message);}db.premium.schedules=db.premium.schedules.filter(x=>x.id!==job.id);await persist();await sleep(60);}}finally{scheduleBusy=false;}},15000);timer.unref?.();
  return { cfgFor, dashboard, onShutdown(){clearInterval(timer);} };
};
