MIM JANNAT BOT — STABILITY UPDATE
=================================

এই ZIP-এ আসল .env বা কোনো API Secret নেই। BOT_TOKEN এবং OPENROUTER_API_KEY শুধু Render-এর Environment-এ রাখবে।

প্রয়োজনীয় Environment Variables:
- BOT_TOKEN
- OPENROUTER_API_KEY

OWNER পরিচয়:
- নির্দিষ্ট Owner Telegram ID কোডে স্থির করা আছে: 7926785649
- /start প্রথম যে ব্যক্তি করবে সে আর Owner হয়ে যাবে না।
- অন্য কেউ /start করলেও Owner-এর কমান্ড ব্যবহার করতে পারবে না।
- Group Creator আলাদা পরিচয়: Telegram API দিয়ে গ্রুপের creator status যাচাই হয়।
- Creator যাচাই করতে Telegram API error হলে সেটিকে ভুলভাবে “তুমি Creator নও” বলা হবে না; Render Logs-এ error থাকবে।
- Group Creator যাচাই নির্ভরযোগ্য করতে বটকে গ্রুপে Admin করে রাখবে।

DEPLOY:
1) ZIP extract করে ভেতরের ফাইলগুলো GitHub repository-র root-এ upload করো।
2) আসল .env upload করবে না। .env.example নিরাপদ।
3) Render Build Command: npm install
4) Render Start Command: npm start
5) Render Environment-এ BOT_TOKEN ও OPENROUTER_API_KEY যোগ করো।
6) একই BOT_TOKEN দিয়ে একটিমাত্র bot instance চালাবে। একই সময়ে অন্য কোথাও polling চালাবে না এবং webhook/polling একসঙ্গে চালাবে না।
7) Deploy শেষে Owner account (ID 7926785649) থেকে বটের Private Chat-এ /start পাঠাও।

RESPONSE / STABILITY CHANGES:
- grammY runner ব্যবহার করে update processing concurrent করা হয়েছে; একটি AI request আটকে থাকলেও অন্য ব্যবহারকারীর update তার জন্য অপেক্ষা করবে না।
- একই ব্যবহারকারীর একই chat-এর message order বজায় থাকে, যাতে /set বা /baton-এর ধাপ গুলিয়ে না যায়।
- OpenRouter request-এর 25 সেকেন্ড timeout আছে; API আটকে থাকলে অনির্দিষ্ট সময় ঝুলে থাকবে না।
- Telegram update error, polling failure, AI failure এবং storage failure log হবে।
- JSON save queue error হলে পরের save আর স্থায়ীভাবে বন্ধ হয়ে থাকবে না।
- Database file atomic temp-file rename দিয়ে লেখা হয়।
- আগের সব মূল ফিচার রাখা হয়েছে: Private AI, Group mention/reply AI, fixed replies, custom /set /list /del, /send, /baton, /welcome, /help, /id, join welcome এবং reactions।

PERSISTENT STORAGE — খুব গুরুত্বপূর্ণ:
কোডের default data path: ./data/bot-data.json
Render Free Web Service-এ service ১৫ মিনিট inbound traffic না পেলে sleep করে; আবার চালু হতে প্রায় এক মিনিট লাগতে পারে। Free service-এর local filesystem ephemeral, এবং Free Web Service-এ Persistent Disk যোগ করা যায় না। তাই Render Free-তে শুধু কোড দিয়ে ২৪/৭ online থাকা বা local data স্থায়ী রাখার নিশ্চয়তা দেওয়া সম্ভব নয়।
সূত্র: https://render.com/docs/free

যদি Render-এ ২৪/৭ online এবং local JSON data স্থায়ী রাখতে চাও, তাহলে এমন always-on paid service ব্যবহার করতে হবে যেখানে Persistent Disk যোগ করা যায়:
- Dashboard → Service → Disks
- Mount Path: /opt/render/project/src/data
- DATA_DIR environment variable না দিলে কোড নিজে এই default path ব্যবহার করবে।

Persistent Disk না থাকলে redeploy/restart/spin-down-এ local data হারাতে পারে। আগে থেকে custom replies/welcome settings থাকলে deploy-এর আগে backup নাও। নতুন build-এর প্রথম deploy-এ পুরোনো disk path না থাকলে database আবার default থেকে তৈরি হবে।

COMMANDS
========
/start — Private Chat-এ বট চালু; নির্দিষ্ট Owner ID ছাড়া কেউ Owner হবে না।
/help — ক্লিকযোগ্য বাংলা Help menu।
/id — বর্তমান Chat ID ও নিজের Telegram ID।
/send — Owner-এর Private Chat-এ text/photo/video/voice/document বেছে নিয়ে destination দিয়ে preview, Send/Cancel।
/baton — Owner-এর Private Chat-এ message, button label, URL, destination, sender label দিয়ে preview ও Send/Cancel।
/welcome — Owner-এর Private Chat-এ Welcome Message edit, Preview, Confirm, ON/OFF।
/set — Group-এ Trigger ও Reply তৈরি; নির্দিষ্ট Bot Owner অথবা ওই Group-এর Creator ব্যবহার করতে পারবেন।
/list — ওই গ্রুপের Custom Reply তালিকা।
/del 1 — তালিকার নির্দিষ্ট Reply মুছবে।
/cancel — চলমান setup বাতিল।

FEATURE NOTES
=============
- Private Chat-এ সাধারণ text লিখলে OpenRouter AI উত্তর দেয়।
- Group-এ শুধু বটকে @mention করলে অথবা বটের message-এ Reply করলে AI উত্তর দেয়।
- Hi/Hello/সালাম/কেমন আছো ইত্যাদি fixed trigger reply এবং custom trigger reply চালু আছে।
- নতুন সদস্য যোগ হলে Welcome Message পাঠায় (ON থাকলে)।
- Group/channel reaction best-effort; Telegram permission/API support না থাকলে নাও হতে পারে।
- /send ও /baton destination group-এ বট আগে থেকে থাকতে হবে এবং message পাঠানোর permission থাকতে হবে।
- /baton-এ Owner-এর পক্ষ থেকে বাছলে Owner attribution text আলাদা করে যাবে; Telegram Bot API দিয়ে ব্যক্তিগত user account-এর হয়ে মেসেজ পাঠানো যায় না।
- OpenRouter API key-তে model access/usage থাকতে হবে। Default model: openai/gpt-4o-mini.

TEST STATUS
===========
এই package-এর JavaScript syntax check (`node --check`) এবং ZIP integrity check সফল হয়েছে। বাস্তব Telegram/Render deployment এবং live AI API end-to-end test এই পরিবেশ থেকে করা সম্ভব নয়; deploy করার পর Render Logs দেখে live test করতে হবে।


v1.5 — CREATOR চেনা ও MENTION REPLY FIX
=======================================
- Group Creator এখন getChatAdministrators দিয়ে যাচাই হয় (আগের চেয়ে নির্ভরযোগ্য)। ব্যর্থ হলে getChatMember fallback আছে।
- Creator "Anonymous Admin" হিসেবে লিখলে: গ্রুপে Anonymous Admin একমাত্র Creator হলে চেনা যাবে। একাধিক Anonymous Admin থাকলে Telegram পরিচয় দেখায় না — তখন "Remain Anonymous" বন্ধ করে কমান্ড দিতে হবে।
- বটকে গ্রুপে Admin করে রাখো (এতে বট গ্রুপের সব মেসেজ পায় এবং Admin তালিকা পড়তে পারে)।
- /id এখন বলে দেয় তুমি বটের Owner কি না, এবং গ্রুপে Creator/সাধারণ সদস্য কি না — এটা দিয়ে নিজে পরীক্ষা করো।
- Owner ID ভুল হলে Render Environment-এ OWNER_ID=তোমার_আসল_ID দিলে সেটি ব্যবহার হবে (না দিলে আগের 7926785649)। নিজের ID জানতে বটকে Private-এ /id দাও।
- গ্রুপে শুধু @বট mention করলে (সাথে কিছু না লিখলেও) বট reply দেবে। "@বট hi" বা "@বট কেমন আছো" লিখলে fixed reply, অন্য কথায় AI reply; AI সমস্যা করলেও বট চুপ থাকবে না।


v1.6 — আগের কথা মনে রাখা, মানুষের মতো কথা, সব মেসেজে React, বাটনের রঙ
=====================================================================
- প্রতিজন ব্যবহারকারীর কথোপকথন আলাদা করে মনে রাখা হয় (Private: ব্যবহারকারী অনুযায়ী; Group: গ্রুপ + ব্যবহারকারী অনুযায়ী)। আগের ৩০টি মেসেজ সংরক্ষিত থাকে, AI-কে শেষ ২৪টি দেখানো হয়।
- Hi / কেমন আছো-র মতো fixed reply-ও এখন মেমোরিতে জমা হয়, তাই AI একই প্রশ্ন (যেমন "কেমন আছো?") বারবার করে না। কথোপকথন চলতে থাকলে (২০ মিনিটের মধ্যে) default fixed greeting বাদ দিয়ে AI প্রসঙ্গ ধরে উত্তর দেয়। /set দিয়ে বানানো Custom Reply সবসময় আগের মতোই কাজ করে।
- AI-এর পরিচয়/কথার ধরন আপডেট: নাম Mim Jannat, মেয়ে, বয়স ১৬, ভাষা রাজশাহী, বাড়ি রাজশাহী → গোদাগাড়ী → সারাংপুর পুলিশ পাড়া, স্রষ্টা আল্লাহ। ধরন: ইসলামিক + কিউট + মিষ্টি, ছোট ছোট স্বাভাবিক বাক্য।
- গ্রুপের প্রতিটি মেসেজে (এবং Channel post-এ) এখন React দেয়। আগে ✨ ইমোজি Telegram-এর allowed তালিকায় না থাকায় React ব্যর্থ হতো; এখন শুধু allowed ইমোজি ব্যবহার হয়। বটকে গ্রুপে Admin রাখলে ভালো।
- /baton: প্রতিটি বাটন যোগ করার সময় রঙ বেছে নেওয়া যায় — 🔵 নীল, 🟢 সবুজ, 🔴 লাল, ⚪ ডিফল্ট। (Telegram শুধু এই ৩টি রঙ দেয়; পুরোনো অ্যাপে রঙ দেখা যায় না।)
- আগের সব ফিচার (/set /list /del /send /baton /welcome /help /id, Owner/Creator যাচাই, join welcome, runner, storage) অপরিবর্তিত।
- মেমোরি স্থায়ী রাখতে Persistent Disk লাগবে (উপরের PERSISTENT STORAGE অংশ দেখো)।


v1.8 — BOT CREATOR / GROUP CREATOR / FORCE JOIN / /All BROADCAST / GROUP-WISE SETTINGS
======================================================================================
নতুন ফিচার আলাদা মডিউলে (features.js) যোগ হয়েছে; আগের সব ফিচার ও Database ঠিক আছে। পুরোনো bot-data.json যেমন আছে তেমনই ব্যবহার হয়, নতুন অংশ (users, groups, groupSettings, forceJoin) নিজে তৈরি হয়।

১) BOT CREATOR (Owner ID 7926785649): সব ফিচার, /All, যেকোনো গ্রুপের সেটিংস, Force Join থেকে মুক্ত। Owner ID/Token/API Key শুধু Render Environment-এ; বটের ভেতর থেকে কেউ বদলাতে পারে না।

২) GROUP CREATOR (Telegram API দিয়ে যাচাই — প্রতিবার সার্ভারে):
- গ্রুপে: /set /list /del /settings /welcome /id /help /cancel।
- Private Chat-এ: /send ও /baton — শুধু নিজের তৈরি গ্রুপে পাঠানো যায় (destination ও Send চাপার সময় দুবার যাচাই)। অন্য গ্রুপ বা Channel-এ পাঠানো যায় না।
- /welcome — গ্রুপে লিখলে ওই গ্রুপের নিজস্ব Welcome (Edit/Preview/Confirm/ON-OFF/ডিফল্টে ফেরা)। Private Chat-এ লিখলে নিজের গ্রুপ বেছে নেওয়া যায়।
- /settings — গ্রুপে: AI Reply, Auto Reply, Reactions, Welcome আলাদাভাবে ON/OFF। সব ডিফল্ট ON (আগের মতো)।
- /All ও Owner-এর Global Settings ব্যবহার করতে পারে না।
- Owner-এর Private Chat-এ /welcome আগের মতোই সব গ্রুপের ডিফল্ট Welcome বদলায়; কোনো গ্রুপের নিজস্ব Welcome থাকলে সেটি অগ্রাধিকার পায়।

৩) /All (শুধু Owner, Private Chat): মেসেজ পাঠাও → Button চাই কি না (Yes/No) → Button নাম, URL, রঙ → Preview → Send All / Cancel।
- যায়: বটকে /start করা (বা Private-এ লিখেছে এমন) সব User + বট যেসব গ্রুপে আছে সেসব গ্রুপ।
- সীমা: যে User কখনো বটের Private Chat শুরু করেনি তাকে Telegram বট দিয়ে মেসেজ পাঠাতে দেয় না। Channel-এ যায় না, শুধু গ্রুপে যায়।
- Rate limit মেনে ধাপে ধাপে (প্রায় ১৮/সেকেন্ড), 429 হলে retry-after অপেক্ষা। চলার সময় ⛔ Cancel Broadcast বাটন। শেষে Report: Total, Sent, Failed, Blocked/Unreachable।
- Broadcast চলার সময় বটের অন্য কাজ চালু থাকে। বট Restart হলে চলমান Broadcast থেমে যায় (আবার /All দিতে হবে)।

৪) FORCE JOIN: Owner Private Chat-এ /channels → ➕ Channel যোগ (@username/লিংক/ID; Private Channel হলে ওই Channel-এর একটি পোস্ট Forward করে Invite Link দাও)। বটকে আগে ওই Channel-এ Admin করতে হবে, নইলে যোগ হবে না।
- Channel না থাকলে বা OFF থাকলে Force Join কাজ করে না (আগের মতো)।
- ব্যবহারকারী Private Chat-এ যেকোনো কিছু করলে, বা গ্রুপে বটের কমান্ড/মেনশন/বটের মেসেজে Reply করলে Membership যাচাই হয় (প্রতি ২০ সেকেন্ডে সর্বোচ্চ একবার)। Channel ছাড়লে আবার Lock।
- গ্রুপে সাধারণ কথাবার্তার Auto Reply ও Reaction-এ Join লাগে না (প্রতি মেসেজে API যাচাই এড়াতে)।
- "Anonymous Admin" হিসেবে লেখা মেসেজে ব্যবহারকারী চেনা যায় না, তাই তাদের Force Join যাচাই হয় না।
- Telegram API সাময়িক সমস্যা করলে ভালো যাচাইয়ের ১০ মিনিট পর্যন্ত ব্যবহার চলে; Channel-এ বট Admin না থাকলে Owner-কে জানানো হয়।

৫) STABILITY: AI timeout/429/5xx/network error-এ ১ বার স্বয়ংক্রিয় retry; Database save ব্যর্থ হলে Logs-এ "Database save FAILED"; একই BOT_TOKEN-এ ২য় polling হলে "409 Conflict" স্পষ্ট Log হয় এবং process Restart না করে ২০ সেকেন্ড পরপর ১০ বার আবার চেষ্টা করে।

নতুন কমান্ড: /All, /channels, /settings। /help-তে নতুন বিভাগ যোগ হয়েছে।

TEST STATUS (v1.8): node --check (index.js, features.js) সফল; grammY-এর নকল (mock) পরিবেশে ৪৭টি পরীক্ষা পাস (Owner/Creator অনুমতি, /All শুধু Owner, Force Join Lock/Unlock/Leave, Broadcast Report, গ্রুপ-ভিত্তিক Welcome/Settings, আগের /set /list /id /baton)। আসল Telegram, Render ও OpenRouter-এ লাইভ টেস্ট এই পরিবেশ থেকে সম্ভব হয়নি — Deploy করে Logs দেখে পরীক্ষা করো।


v1.9 — MASTER ADMIN PANEL / GROUP OWNER PANEL / BAN / GLOBAL SETTINGS
====================================================================
নতুন কোড আলাদা ফাইলে (panels.js) আছে। আগের সব ফিচার ও Database যেমন ছিল তেমন; নতুন অংশ (banned, globalSettings, গ্রুপের creator/lastActive) নিজে তৈরি হয়, পুরোনো ডেটা Reset হয় না।

১) BOT CREATOR (স্থায়ী): ID 7926785649 কোডে স্থির। Render-এর OWNER_ID environment variable এখন আর কাজ করে না (দিলে Logs-এ সতর্কতা আসবে)। বটের ভেতর থেকে কেউ Owner বদলাতে পারে না।

২) MASTER ADMIN PANEL — Private Chat-এ /admin (শুধু Bot Creator; অন্য কেউ ঢুকতে পারে না, বানানো বাটন চাপলেও সার্ভার আবার যাচাই করে):
- 📊 Dashboard: মোট ইউজার, এ পর্যন্ত মোট গ্রুপ, বর্তমানে বট যুক্ত গ্রুপ, সক্রিয় গ্রুপ (গত ৭ দিনে মেসেজ হয়েছে)।
- 📈 Statistics: নতুন/সক্রিয় ইউজার, Block/Ban সংখ্যা, গ্রুপ পরিসংখ্যান, Global সেটিংসের অবস্থা, Uptime।
- 👥 User Management: ইউজারের তালিকা (পেজ), বিস্তারিত তথ্য, ID/@username দিয়ে খোঁজা, Ban/Unban, AI মেমোরি মুছা।
- 🏠 Group Management: সব গ্রুপ — নাম, Group ID, Creator (নাম/ID), সেটিংস। যেকোনো গ্রুপে ⚙️ সেটিংস পরিবর্তন, Welcome Edit, Custom Reply যোগ/মুছা, Creator Refresh।
- 🚫 Ban / Unban: যেকোনো numeric ID (বটের ইউজার হলে @username-ও) Ban করা যায়। Ban করা ইউজারের Private, Group (Command/Mention/Auto Reply/Reaction) ও বাটন — সব বন্ধ। Private-এ সে Ban-এর নোটিশ পায় (মিনিটে ১ বার), গ্রুপে বট চুপ থাকে। Bot Creator-কে Ban করা যায় না।
- ⚙️ Global Settings: AI Reply, Auto Reply, Reactions, Member Welcome — সব গ্রুপ/ইউজারের জন্য ON/OFF (Global বন্ধ থাকলে কোনো Group Creator চালু করতে পারে না; Bot Creator Private-এ AI ব্যবহার করতে পারে)। 🛠 Maintenance Mode: ON করলে শুধু Bot Creator বট ব্যবহার করতে পারে।
- 📢 Broadcast: আগের /All-এর একই প্রক্রিয়া। 🔒 Force Join: আগের /channels প্যানেল।
- /settings (Bot Creator-এর Private Chat): বট যে সব গ্রুপে আছে সেগুলোর তালিকা → একটি বেছে সেই গ্রুপের সেটিংস পরিবর্তন।

৩) GROUP OWNER PANEL — Private Chat-এ /panel বা /settings:
- Telegram API (getChatAdministrators) দিয়ে প্রকৃত Creator যাচাই; নাম/Username দেখে নয়। শুধু ওই ব্যক্তির নিজের গ্রুপগুলো (যেখানে বট আছে) দেখায়। একাধিক গ্রুপ থাকলে সব দেখায়।
- গ্রুপ বাছলে: AI Reply / Auto Reply / Reactions / Welcome ON-OFF, Welcome Edit-Preview-Confirm-ডিফল্ট, 💬 Custom Replies (যোগ/মুছা), ℹ️ Group Info (সদস্য সংখ্যা, বটের অবস্থা)।
- প্রতিটি বাটন চাপার সময় সার্ভার আবার Telegram থেকে ওই নির্দিষ্ট গ্রুপের Creator যাচাই করে (পুরোনো ক্যাশ বা বাটন লুকানোর ওপর নির্ভর করে না)। Creator বদলে গেলে আগের Creator সঙ্গে সঙ্গে অ্যাক্সেস হারায়।
- Creator পারবে না: Master Panel, অন্য গ্রুপ, Global Ban, /All, Global Settings, Bot Token/API Key/Database/Hosting।
- গ্রুপে /set /list /del /settings /welcome আগের মতোই চলে। Private Chat-এ /send ও /baton শুধু নিজের গ্রুপে।
- Bot API সীমাবদ্ধতা: Telegram কোনো ইউজারের সব গ্রুপের তালিকা দেয় না। তাই বট শুধু সেই গ্রুপগুলোই চেনে যেখানে বট আছে এবং যেখানে বট অন্তত একবার আপডেট পেয়েছে (বটকে গ্রুপে যোগ/Admin করলে বা কেউ মেসেজ দিলে)। নতুন গ্রুপ প্যানেলে না এলে গ্রুপে /id লিখে তারপর /panel-এ 🔄 চাপো।
- Creator কে — এই তথ্য ২৪ ঘণ্টা পর্যন্ত মনে রাখা হয়; তবে অ্যাক্সেস সবসময় লাইভ যাচাই হয়। গ্রুপের মালিকানা বদলালে নতুন Creator তালিকায় না দেখলে 🔄 Refresh চাপলেই হবে।
- "যে গ্রুপে বট যুক্ত করেছে এবং প্রকৃত Creator" — এখানে শর্ত হলো ওই গ্রুপে বট আছে এবং ব্যক্তি Telegram-এ প্রকৃত Creator (বট অন্য কেউ যোগ করলেও Creator পারবে, যেমন v1.8-এও ছিল)।

৪) প্রতি গ্রুপের ডেটা আলাদা: Settings, Welcome, Auto Reply, AI Setting ও Custom Replies গ্রুপ ID অনুযায়ী আলাদা জমা হয়। এক গ্রুপ বদলালে অন্য গ্রুপ বদলায় না।

TEST STATUS (v1.9): node --check (index.js, features.js, panels.js) সফল; ZIP integrity সফল; grammY-এর নকল (mock) পরিবেশে ১৩৬টি পরীক্ষা পাস — Master Panel অ্যাক্সেস (জাল বাটনসহ), Dashboard সংখ্যা, Ban/Unban (Private/Group/Command/বাটন), Creator শুধু নিজের গ্রুপ দেখা, অন্য গ্রুপের বাটন আক্রমণ বন্ধ, Private /settings, গ্রুপ-ভিত্তিক আলাদা সেটিংস/Welcome/Custom Reply, Global Settings ও Maintenance, Creator বদল, Telegram API error-এ ভুল "Creator নও" না বলা, পুরোনো Database অক্ষত, পুরোনো /set /list /send /All /Force Join। আসল Telegram, Render ও OpenRouter-এ লাইভ টেস্ট এই পরিবেশ থেকে সম্ভব হয়নি — Deploy করে Logs দেখে পরীক্ষা করো।

v2.0 — ADDITIVE PREMIUM MODULES
================================
- নতুন premium.js module যোগ হয়েছে। পুরোনো index.js/features.js/panels.js-এর মূল feature handlers বাদ বা rename করা হয়নি।
- Database migration additive: db.premium namespace না থাকলে তৈরি হয়; পুরোনো customReplies, conversations, welcome, users, groups, groupSettings, forceJoin, banned ও globalSettings key মুছে/রিসেট করা হয় না।
- /premium — Group Creator গ্রুপে, Bot Creator Private-এ নিজের/সব registered group select করে Premium Dashboard খুলতে পারবেন। প্রতিটি callback-এ server-side permission পুনরায় যাচাই হয়।
- /pmsg — Private Chat থেকে group select করে Text/Photo/Video/Document/Audio/Voice message copy, formatting/caption preservation, একাধিক URL/Callback button (প্রতি button আলাদা row) ও send/cancel flow। Callback button press-এ confirmation toast দেখায়।
- /template — text template সংরক্ষণ; Dashboard → Message Settings → Saved Templates-এ দেখা যাবে।
- Moderation toggles: links, suspicious links, custom words, spam/repeated message, flood, forwards, contacts, files, photo/video, caps ও excessive emoji। Admin/Creator/বট Owner exemption আছে। Delete permission না থাকলে log-এ failure লেখা হয়।
- Custom word/link phrase filter add/list/toggle/delete।
- /warn (reply), /unwarn (reply), /mute (reply, মিনিট), /unmute (reply), /gban (reply, ঐচ্ছিক মিনিট), /ungban (reply)। 3 warnings হলে 1 hour mute চেষ্টা করে।
- Premium welcome: Dashboard থেকে ON/OFF, text edit, photo/video set, preview; {name} token support। Auto-delete field database schema-তে reserved, Dashboard-এ timer edit এখনও নেই।
- Group-wise auto reply add/delete/list।
- /schedule workflow: Dashboard → Automation থেকে text এবং Bangladesh local time (YYYY-MM-DD HH:mm) দিয়ে scheduled announcement। Job JSON DB-তে থাকে এবং restart-এর পরও due হলে পাঠানোর চেষ্টা করে।
- Group statistics এবং moderation history/logs।

IMPORTANT LIMITATIONS / REQUIRED PERMISSIONS
--------------------------------------------
- Bot-কে group admin করে Delete Messages, Restrict Members, Ban Users এবং Send Messages permission দিতে হবে। Telegram permission/API error হলে বট log করবে; সফল হয়েছে বলে দাবি করবে না।
- Telegram Bot API কোনো user-এর হয়ে message পাঠাতে দেয় না; /pmsg bot identity-তেই পাঠায়।
- Callback buttons currently show a small acknowledgement only; arbitrary user-defined callback actions, message edit/delete console, button row editor, template media, per-filter custom punishment, scheduled media/buttons, full active-member analytics, welcome auto-delete timer editor এবং moderation per-feature thresholds এই build-এ অন্তর্ভুক্ত নয়।
- Auto moderation শুধুমাত্র bot যে group message update পায় তার ওপর কাজ করে। Telegram privacy mode/permissions এবং message type সীমাবদ্ধতা প্রযোজ্য।
- Scheduled jobs একই local JSON storage-এ থাকে; Persistent Disk ছাড়া Render Free-তে restart/deploy/spin-down হলে data হারানোর ঝুঁকি আগের মতোই থাকবে।

UPDATE / DEPLOY
---------------
1) Deploy-এর আগে বর্তমান Render Persistent Disk-এর bot-data.json backup নাও।
2) ZIP extract করে সব project files replace/upload করো; পুরোনো data/ directory বা bot-data.json মুছবে না।
3) npm install চালাও; npm run check সফল হওয়া চাই।
4) একই BOT_TOKEN-এর অন্য polling instance বন্ধ রেখে Render deploy করো।
5) Bot-কে প্রয়োজনীয় group admin permissions দাও।
6) Bot Creator: Private Chat-এ /premium; Group Creator: নিজের group-এ /premium।
7) প্রথমে test group-এ প্রতিটি moderation switch আলাদাভাবে পরীক্ষা করো।
