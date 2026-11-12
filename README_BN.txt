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
