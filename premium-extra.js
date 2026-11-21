'use strict';
// v2.1 additive module (prefix "px:"): warning settings, filter actions, welcome buttons/auto-delete, goodbye,
// schedule manager, template send/delete, /schedule, /warnings, /health. Does not replace any legacy handler or data key.
const { InlineKeyboard } = require('grammy');
const fs = require('fs');

module.exports = function createPremiumExtra(deps) {
  const { bot, db, saveDb, pending, keyOf, isOwner, isPrivate, isGroup, permissions, premium, getBotInfo, startedAt, dbFile } = deps;
  const healthInfo = typeof deps.healthInfo === 'function' ? deps.healthInfo : () => '';
  const noop = () => {};
  const persist = async () => { try { await saveDb(); return true; } catch (e) { console.error('[px] database save failed:', e.message); return false; } };
  const perm = async (ctx, chatId) => {
    const r = await permissions.canManageChat(ctx, chatId);
    if (r.error) console.error(`[px] permission verification failed for ${chatId}:`, r.error.message);
    return Boolean(r && r.allowed && r.verified);
  };
  const fmtTime = ms => new Date(ms).toLocaleString('en-GB', { timeZone:'Asia/Dhaka' });
  const STATUS = { pending:'⏳ অপেক্ষমাণ', sending:'📤 পাঠানো হচ্ছে', sent:'✅ পাঠানো হয়েছে', failed:'❌ ব্যর্থ', paused:'⏸ Pause', uncertain:'⚠️ অনিশ্চিত' };
  const DELETE_STEPS = [0, 30, 60, 300, 3600];
  const MINUTE_STEPS = [10, 60, 360, 1440, 10080];

  // ---- schedule manager ----
  const jobsOf = id => db.premium.schedules.filter(x => String(x.chatId) === String(id));
  function scheduleView(id) {
    const jobs = jobsOf(id).sort((a, b) => (a.at || 0) - (b.at || 0)).slice(-12);
    const kb = new InlineKeyboard();
    let text = `📋 Scheduled Messages — ${(db.groups[String(id)] || {}).title || id}\n(সময় বাংলাদেশ সময়ে)\n\n`;
    if (!jobs.length) text += 'কোনো Schedule নেই। "➕ Schedule Message" দিয়ে তৈরি করো।';
    jobs.forEach((j, i) => {
      const st = j.status || 'pending';
      text += `${i + 1}. ${fmtTime(j.nextAt || j.at)} — ${STATUS[st] || st}\n   ${String(j.text).slice(0, 60)}${j.lastError ? '\n   ⚠️ ' + String(j.lastError).slice(0, 80) : ''}\n`;
      const row = [];
      if (st === 'pending') kb.text(`⏸ ${i + 1}`, `px:sp:${id}:${j.id}`);
      else if (st === 'paused') kb.text(`▶️ ${i + 1}`, `px:sp:${id}:${j.id}`);
      else if (st === 'uncertain') kb.text(`🔁 আবার পাঠাও ${i + 1}`, `px:sr:${id}:${j.id}`);
      if (st !== 'sending') kb.text(`🗑 ${i + 1}`, `px:sd:${id}:${j.id}`);
      kb.row();
    });
    if (jobs.some(j => j.status === 'uncertain')) text += '\n⚠️ "অনিশ্চিত" মানে বট বন্ধ হওয়ার সময় পাঠানো হয়েছিল কি না নিশ্চিত নয়। গ্রুপে মেসেজটি আছে কি না দেখে তারপর "আবার পাঠাও" চাপো (ডুপ্লিকেট হতে পারে)।';
    kb.text('➕ Schedule Message', 'pr:schedule:' + id).row().text('🔄 Refresh', 'px:sl:' + id).text('⬅️ Automation', 'pr:auto:' + id);
    return { text, kb };
  }

  function goodbyeView(id) {
    const c = premium.cfgFor(id), g = c.goodbye;
    const kb = new InlineKeyboard()
      .text(g.enabled ? '🔴 Turn OFF' : '🟢 Turn ON', 'px:byetoggle:' + id).row()
      .text('✏️ Edit Text', 'px:byetext:' + id).text(`⏱ Auto Delete: ${g.deleteAfter ? g.deleteAfter + 's' : 'OFF'}`, 'px:byedel:' + id).row()
      .text('⬅️ Welcome', 'pr:welcome:' + id);
    return { text: `👋 Goodbye Message\nStatus: ${g.enabled ? 'ON ✅' : 'OFF ⛔'}\nText: ${g.text}\nPlaceholders: {name} {username} {mention} {group}`, kb };
  }

  bot.callbackQuery(/^px:(.+)$/, async ctx => {
    const p = ctx.match[1].split(':');
    const action = p[0], id = p[1];
    if (!id || !/^-?\d+$/.test(id) || !await perm(ctx, id)) return ctx.answerCallbackQuery({ text: '🚫 এই গ্রুপের Settings পরিবর্তনের অনুমতি নেই।', show_alert: true });
    const c = premium.cfgFor(id);
    const edit = async v => { await ctx.answerCallbackQuery().catch(noop); return ctx.editMessageText(v.text, { reply_markup: v.kb }).catch(e => { if (!/not modified/i.test(e.message || '')) console.error('[px] edit:', e.message); }); };

    if (action === 'wl') {
      if (p[2] === 'inc') c.warningLimit = Math.min(20, c.warningLimit + 1);
      else if (p[2] === 'dec') c.warningLimit = Math.max(1, c.warningLimit - 1);
      else return ctx.answerCallbackQuery({ text: `বর্তমান Warning Limit: ${c.warningLimit}` });
      if (!await persist()) return ctx.answerCallbackQuery({ text: 'সংরক্ষণ করা যায়নি। Render Logs দেখো।', show_alert: true });
      return premium.show(ctx, id, 'warn');
    }
    if (action === 'wa') { c.warnAction = c.warnAction === 'mute' ? 'restrict' : 'mute'; if (!await persist()) return ctx.answerCallbackQuery({ text: 'সংরক্ষণ করা যায়নি।', show_alert: true }); return premium.show(ctx, id, 'warn'); }
    if (action === 'wm') { const i = MINUTE_STEPS.indexOf(c.warnMinutes); c.warnMinutes = MINUTE_STEPS[(i + 1) % MINUTE_STEPS.length]; if (!await persist()) return ctx.answerCallbackQuery({ text: 'সংরক্ষণ করা যায়নি।', show_alert: true }); return premium.show(ctx, id, 'warn'); }
    if (action === 'fa') {
      const i = Number(p[2]); const f = c.filters[i];
      if (!f) return ctx.answerCallbackQuery({ text: 'Filter পাওয়া যায়নি', show_alert: true });
      const acts = premium.FILTER_ACTIONS; f.action = acts[(Math.max(0, acts.indexOf(f.action || 'delete')) + 1) % acts.length];
      if (!await persist()) return ctx.answerCallbackQuery({ text: 'সংরক্ষণ করা যায়নি।', show_alert: true });
      await ctx.answerCallbackQuery({ text: `Action: ${f.action}` });
      return ctx.editMessageReplyMarkup({ reply_markup: premium.filterKb(id, c) }).catch(noop);
    }
    if (action === 'wdel') {
      const i = DELETE_STEPS.indexOf(c.welcome.deleteAfter || 0); c.welcome.deleteAfter = DELETE_STEPS[(i + 1) % DELETE_STEPS.length];
      if (!await persist()) return ctx.answerCallbackQuery({ text: 'সংরক্ষণ করা যায়নি।', show_alert: true });
      return premium.show(ctx, id, 'welcome');
    }
    if (action === 'wbtn') {
      await ctx.answerCallbackQuery();
      const kb = new InlineKeyboard().text('➕ Button যোগ', 'px:wbtnadd:' + id).text('🧹 সব Button মুছো', 'px:wbtnclr:' + id).row().text('⬅️ Welcome', 'pr:welcome:' + id);
      return ctx.editMessageText(`🔘 Welcome Buttons (${c.welcome.buttons.length}/6)\n\n` + (c.welcome.buttons.map((b, i) => `${i + 1}. ${b.label} → ${b.url}`).join('\n') || 'কোনো Button নেই।'), { reply_markup: kb }).catch(noop);
    }
    if (action === 'wbtnadd') {
      if (c.welcome.buttons.length >= 6) return ctx.answerCallbackQuery({ text: 'সর্বোচ্চ ৬টি Button।', show_alert: true });
      pending.set(keyOf(ctx), { type: 'px_wbtn', chatId: id, userId: String(ctx.from.id) });
      await ctx.answerCallbackQuery();
      return ctx.reply('Button এভাবে পাঠাও:\nনাম | https://লিংক\nযেমন: Join Telegram | https://t.me/yourchannel\nবাতিল: /cancel');
    }
    if (action === 'wbtnclr') { c.welcome.buttons = []; if (!await persist()) return ctx.answerCallbackQuery({ text: 'সংরক্ষণ করা যায়নি।', show_alert: true }); await ctx.answerCallbackQuery({ text: 'মুছে ফেলা হয়েছে' }); return premium.show(ctx, id, 'welcome'); }
    if (action === 'bye') return edit(goodbyeView(id));
    if (action === 'byetoggle') { c.goodbye.enabled = !c.goodbye.enabled; if (!await persist()) return ctx.answerCallbackQuery({ text: 'সংরক্ষণ করা যায়নি।', show_alert: true }); return edit(goodbyeView(id)); }
    if (action === 'byedel') { const i = DELETE_STEPS.indexOf(c.goodbye.deleteAfter || 0); c.goodbye.deleteAfter = DELETE_STEPS[(i + 1) % DELETE_STEPS.length]; if (!await persist()) return ctx.answerCallbackQuery({ text: 'সংরক্ষণ করা যায়নি।', show_alert: true }); return edit(goodbyeView(id)); }
    if (action === 'byetext') { pending.set(keyOf(ctx), { type: 'px_byetext', chatId: id, userId: String(ctx.from.id) }); await ctx.answerCallbackQuery(); return ctx.reply('নতুন Goodbye Text পাঠাও। Placeholder: {name} {username} {mention} {group}\nবাতিল: /cancel'); }
    if (action === 'sl') return edit(scheduleView(id));
    if (action === 'sp' || action === 'sd' || action === 'sr') {
      const job = db.premium.schedules.find(x => x.id === p[2] && String(x.chatId) === String(id));
      if (!job) return ctx.answerCallbackQuery({ text: 'Schedule পাওয়া যায়নি।', show_alert: true });
      const st = job.status || 'pending';
      if (st === 'sending') return ctx.answerCallbackQuery({ text: 'এখন পাঠানো হচ্ছে — একটু পরে চেষ্টা করো।', show_alert: true });
      if (action === 'sp') {
        if (st === 'pending') job.status = 'paused';
        else if (st === 'paused') { job.status = 'pending'; if ((job.nextAt || job.at) < Date.now()) job.nextAt = Date.now() + 30000; }
        else return ctx.answerCallbackQuery({ text: 'এই অবস্থায় Pause/Resume করা যায় না।', show_alert: true });
      } else if (action === 'sd') {
        db.premium.schedules.splice(db.premium.schedules.indexOf(job), 1);
      } else {
        if (st !== 'uncertain') return ctx.answerCallbackQuery({ text: 'শুধু "অনিশ্চিত" Schedule আবার পাঠানো যায়।', show_alert: true });
        job.status = 'pending'; job.attempts = 0; job.lastError = ''; job.nextAt = Date.now() + 30000;
      }
      if (!await persist()) return ctx.answerCallbackQuery({ text: 'সংরক্ষণ করা যায়নি। Render Logs দেখো।', show_alert: true });
      return edit(scheduleView(id));
    }
    if (action === 'tplsend' || action === 'tpldel') {
      const list = db.premium.templates[String(ctx.from.id)] || []; const t = list[Number(p[2])];
      if (!t) return ctx.answerCallbackQuery({ text: 'Template পাওয়া যায়নি।', show_alert: true });
      if (action === 'tpldel') { list.splice(Number(p[2]), 1); if (!await persist()) return ctx.answerCallbackQuery({ text: 'সংরক্ষণ করা যায়নি।', show_alert: true }); return edit(premium.templateView(ctx.from.id, id)); }
      try { await ctx.api.sendMessage(id, t.text); await ctx.answerCallbackQuery({ text: '✅ পাঠানো হয়েছে' }); }
      catch (e) { console.error('[px] template send:', e.message); await ctx.answerCallbackQuery({ text: 'পাঠানো যায়নি। বট গ্রুপে আছে ও Send permission আছে কি না দেখো।', show_alert: true }); }
      return;
    }
    return ctx.answerCallbackQuery({ text: 'এই অপশনটি পাওয়া যায়নি।', show_alert: true });
  });

  // Conversational flows (isolated "px_" types)
  bot.on('message', async (ctx, next) => {
    const flow = pending.get(keyOf(ctx));
    if (!flow || !String(flow.type || '').startsWith('px_') || (ctx.message.text || '').startsWith('/')) return next();
    if (!await perm(ctx, flow.chatId)) { pending.delete(keyOf(ctx)); return ctx.reply('🚫 Permission নেই।'); }
    const c = premium.cfgFor(flow.chatId), t = String(ctx.message.text || '').trim();
    if (flow.type === 'px_byetext') {
      if (!t) return ctx.reply('Text হিসেবে পাঠাও।');
      c.goodbye.text = t.slice(0, 1000); pending.delete(keyOf(ctx));
      if (!await persist()) return ctx.reply('❌ সংরক্ষণ করা যায়নি। Render Logs ও Disk দেখো।');
      return ctx.reply('✅ Goodbye Text সংরক্ষিত হয়েছে।');
    }
    if (flow.type === 'px_wbtn') {
      const m = t.match(/^(.{1,40}?)\s*\|\s*(\S+)$/);
      if (!m) return ctx.reply('এভাবে পাঠাও: নাম | https://লিংক');
      let url = m[2]; if (/^t\.me\//i.test(url)) url = 'https://' + url;
      if (!/^https?:\/\/\S+\.\S+/i.test(url)) return ctx.reply('সঠিক URL দাও (https:// অথবা t.me/ দিয়ে শুরু)।');
      if (c.welcome.buttons.length >= 6) { pending.delete(keyOf(ctx)); return ctx.reply('সর্বোচ্চ ৬টি Button।'); }
      c.welcome.buttons.push({ label: m[1].trim(), url }); pending.delete(keyOf(ctx));
      if (!await persist()) return ctx.reply('❌ সংরক্ষণ করা যায়নি। Render Logs ও Disk দেখো।');
      return ctx.reply(`✅ Button যোগ হয়েছে (মোট ${c.welcome.buttons.length}টি)। Preview দেখতে Welcome মেনুতে 👁️ চাপো।`);
    }
    return next();
  });

  // Goodbye message
  bot.on('message:left_chat_member', async (ctx, next) => {
    const m = ctx.message.left_chat_member;
    if (m && !m.is_bot && isGroup(ctx)) {
      const c = premium.cfgFor(ctx.chat.id);
      if (c.goodbye.enabled) {
        try {
          const sent = await premium.sendConfigured(ctx.api, ctx.chat.id, { text: c.goodbye.text, buttons: [] }, [m], ctx.chat, null);
          if (c.goodbye.deleteAfter > 0) setTimeout(() => ctx.api.deleteMessage(ctx.chat.id, sent.message_id).catch(noop), Math.min(c.goodbye.deleteAfter, 86400) * 1000).unref?.();
        } catch (e) { console.error('[px] goodbye failed:', e.message); }
      }
    }
    return next();
  });

  // /schedule — group: this group's list; private: pick a group first.
  bot.command('schedule', async ctx => {
    if (isGroup(ctx)) {
      if (!await perm(ctx, ctx.chat.id)) return ctx.reply('এই কমান্ড শুধু Bot Creator বা এই গ্রুপের প্রকৃত Creator ব্যবহার করতে পারবেন।');
      const v = scheduleView(ctx.chat.id); return ctx.reply(v.text, { reply_markup: v.kb });
    }
    if (isPrivate(ctx)) return premium.openSelection(ctx);
  });

  // /warnings — creator can reply to a member; everyone else only sees their own count.
  bot.command('warnings', async ctx => {
    if (!isGroup(ctx)) return ctx.reply('/warnings গ্রুপে ব্যবহার করো।');
    const c = premium.cfgFor(ctx.chat.id);
    const reply = ctx.msg.reply_to_message && ctx.msg.reply_to_message.from;
    let target = ctx.from;
    if (reply && String(reply.id) !== String(ctx.from.id)) {
      if (!await perm(ctx, ctx.chat.id)) return ctx.reply('অন্যের Warning দেখতে পারবেন শুধু Bot Creator বা এই গ্রুপের Creator।');
      target = reply;
    }
    const n = c.warnings[String(target.id)] || 0;
    return ctx.reply(`⚠️ ${[target.first_name, target.last_name].filter(Boolean).join(' ') || 'সদস্য'} — Warning: ${n}/${c.warningLimit}`);
  });

  // /health — Bot Creator only.
  bot.command('health', async ctx => {
    if (!isOwner(ctx)) return ctx.reply('এই কমান্ড শুধু Bot Creator ব্যবহার করতে পারবেন।');
    let size = '—'; try { size = Math.round(fs.statSync(dbFile).size / 1024) + ' KB'; } catch (e) { size = 'পড়া যায়নি'; }
    const up = Math.floor((Date.now() - startedAt) / 60000);
    const groups = Object.values(db.groups || {}).filter(g => g && g.active !== false).length;
    const sched = db.premium.schedules;
    const bi = getBotInfo();
    return ctx.reply([`✅ MIM JANNAT BOT সচল`, `Bot: @${bi ? bi.username : '—'}`, `Uptime: ${Math.floor(up / 60)} ঘণ্টা ${up % 60} মিনিট`, `Active Groups: ${groups}`,
      `Schedules — অপেক্ষমাণ: ${sched.filter(x => !x.status || x.status === 'pending').length}, অনিশ্চিত: ${sched.filter(x => x.status === 'uncertain').length}, ব্যর্থ: ${sched.filter(x => x.status === 'failed').length}`,
      `Database: ${dbFile}\nSize: ${size}`, healthInfo(), '', '⚠️ Render Free plan-এ Persistent Disk ছাড়া এই ফাইল Redeploy/Restart-এ মুছে যেতে পারে।'].join('\n'));
  });

  return { scheduleView, goodbyeView };
};
