MIM JANNAT BOT v2.5.0 — README (বাংলা)
Creator: GTS Tarek  |  Node.js + grammY  |  Hosting: Render

=== এই ZIP-এ কী আছে ===
ZIP খুললে সরাসরি (কোনো বাড়তি ফোল্ডার ছাড়া) এই ফাইলগুলো পাবেন:
index.js  package.json  config.js  permissions.js  personality.js  moderation-utils.js
features.js  panels.js  premium.js  premium-extra.js  profanity.js  backup.js  render.yaml  .env.example  tests/
README_BN.txt  FINAL_AUDIT_REPORT_BN.txt

=== Render-এ Deploy (ধাপে ধাপে) ===
১) ZIP খুলে সব ফাইল GitHub Repository-র ROOT-এ আপলোড করুন (index.js ও package.json যেন Repository-র একদম উপরের স্তরে থাকে)।
   ZIP-এর ভেতরের কোনো ফোল্ডার বানিয়ে তার ভেতরে রাখবেন না।
২) Render > New > Web Service > Repository বেছে নিন।
৩) Root Directory: ফাঁকা রাখুন।   Build Command: npm install   Start Command: npm start
   (আগের ত্রুটি "Cannot find module '/opt/render/project/src/index.js'" হয় যখন index.js Repository-র root-এ থাকে না। এই ZIP-এ index.js root-এই আছে।)
৪) Environment Variables: BOT_TOKEN, OPENROUTER_API_KEY।
৫) Deploy করুন। Logs-এ "Starting Mim Jannat as @..." দেখলে বট চালু। https://আপনার-সার্ভিস.onrender.com/health ওপেন করলে {"ok":true,...} আসবে।
৬) একই BOT_TOKEN দিয়ে একসঙ্গে দুটি জায়গায় বট চালাবেন না (409 Conflict হয়)।

=== ডেটা সংরক্ষণ — অত্যন্ত গুরুত্বপূর্ণ ===
বটের ডেটা একটি JSON ফাইলে থাকে (data/bot-data.json)। Render Free plan-এ ডিস্ক স্থায়ী নয়, তাই Redeploy বা Restart হলে
সব ডেটা (গ্রুপ সেটিংস, Warning, Schedule, Custom Reply) হারাতে পারে।
সমাধান: Render-এ Persistent Disk যোগ করুন (paid plan) —
  Disk Name: mim-data   Mount Path: /opt/render/project/src/data   Size: 1 GB
  এবং Environment-এ DATA_DIR=/opt/render/project/src/data দিন।
Disk ছাড়া চালালে ডেটা হারানোর ঝুঁকি থেকে যায়।

=== Database Migration ===
- এই আপডেট শুধু নতুন Key যোগ করে (Additive)। পুরোনো কোনো Key মোছা বা বদলানো হয় না।
- প্রতিবার বট চালুর সময় আগে bot-data.json.preupgrade-<সময়>.bak নামে Backup নেওয়া হয় (সর্বশেষ ১০টি রাখা হয়)।
  Backup ব্যর্থ হলে বট চালু হয় না — ডেটা সুরক্ষিত থাকে।
- Schema Version 3 db.schemaVersion-এ লেখা হয়; ইতিহাস db.migrationLog-এ।
- ডেটা ফাইল নষ্ট (corrupt) থাকলে বট খালি Database দিয়ে ওভাররাইট করে না — .corrupt-*.bak কপি করে থেমে যায়।
- সংরক্ষণ Atomic (temp ফাইল লিখে rename)।

=== Backup ও Recovery ===
Backup নেওয়া: Render Shell/Disk থেকে data/bot-data.json কপি করে রাখুন।
Recovery: বট বন্ধ করুন → data/bot-data.json মুছে/সরিয়ে দিন → যেকোনো .preupgrade-*.bak ফাইলকে bot-data.json নামে কপি করুন → বট চালু করুন।
আপগ্রেডে সমস্যা হলে একই পদ্ধতিতে Rollback হয় (পুরোনো ZIP-এর কোড + পুরোনো .bak)।

=== কে কী ব্যবহার করতে পারে ===
👑 Bot Creator (ID config.js-এ, শুধু numeric ID দিয়ে যাচাই): /admin (Master Panel), /All Broadcast, /channels, /send, /baton,
   /pmsg, /health, সব গ্রুপের /panel ও /premium, Global Settings।
🧰 Group Creator (Telegram getChatAdministrators → status=creator, প্রতিবার যাচাই; API ব্যর্থ হলে Access বন্ধ):
   শুধু নিজের গ্রুপে — /panel, /settings, /premium, /set /list /del, /welcome, /warn /unwarn /warnings, /mute /unmute, /ban /unban (/gban /ungban একই),
   /schedule, /pmsg, Link/Spam/Filter/Welcome/Goodbye সেটিংস।
🙂 সাধারণ ব্যবহারকারী: AI চ্যাট, /start, /help (Owner/Admin অংশ দেখানো হয় না), /id, নিজের /warnings।
Admin ও Creator-কে স্বয়ংক্রিয় Moderation থেকে বাদ রাখা হয়; Telegram যাচাই করতে না পারলে কাউকে Punish করা হয় না।

=== নতুন ফিচার (v2.1.0) ===
- Warning Limit (১–২০), Punishment (Mute/Restrict) ও সময় — Premium > Warning System থেকে।
- Custom Filter: প্রতিটি শব্দের আলাদা Action (delete / warn / mute / restrict), পুরো-শব্দ মেলানো (False Positive কম); অংশ মেলাতে *শব্দ* লিখুন।
- Auto Reply: একাধিক Trigger (hi|hello), Contains (*শব্দ*), Case-insensitive।
- Welcome: {name} {username} {mention} {group}, Button যোগ, Auto Delete টাইমার, Preview। Goodbye Message একই ধরনের।
- Premium Message (/pmsg): পাঠানোর আগে পূর্ণ Preview + Confirm/Cancel; শেষ Button বাদ দেওয়া।
- Scheduled Messages: তালিকা, Pause/Resume, Delete, "অনিশ্চিত" Job হাতে যাচাই করে পুনরায় পাঠানো, /schedule কমান্ড।
- Templates: তালিকা থেকে গ্রুপে পাঠানো ও মুছে ফেলা।
- Statistics: Join/Leave/Warning/Mute/Ban/Deleted/Filtered/Links/Spam + আজ/৭ দিন/৩০ দিন বার্তা সংখ্যা।
- /health (Owner), Moderation-এর আগে টার্গেট Admin/Creator/Owner কি না যাচাই।
- AI Personality: লাজুক, মিষ্টি, ইসলামিক শালীনতা, প্রাসঙ্গিক Emoji; Creator উত্তর: "আমার Bot Creator হলেন GTS Tarek! 🌸🤍"।

=== পরীক্ষা চালানো ===
npm install
npm run check
npm test


=== v2.2.0 — Smart Moderation ও সব মেসেজে AI Reply ===
(পুরোনো কোনো ফিচার/কমান্ড/Database Key বাদ যায়নি; শুধু সংশোধন ও যোগ করা হয়েছে। নতুন ফাইল: profanity.js)

১) গালি স্বয়ংক্রিয়ভাবে চেনা
   • Premium Dashboard → Bad Words → ON করলে বট নিজেই বাংলা, Banglish ও English গালি/অশালীন শব্দ চিনে মুছে দেবে — আলাদা করে শব্দ দিতে হবে না।
   • বানান ঘুরিয়ে লিখলেও ধরে: fuuuck, f.u.c.k, f*ck, sh!t, মাদারচুদ/মাদারচোদ, মাগি/মাগী ইত্যাদি।
   • স্বাভাবিক শব্দে ভুল ধরে না: class, Assam, হারাম (ধর্মীয় শব্দ), চোদ্দ, বালিশ, সালাম, শালীনতা ইত্যাদি নিরাপদ।
২) "গালি" ও "লিংক" লিখে দিলেই পুরো ক্যাটাগরি
   • Add Word-এ শুধু  গালি  (অথবা "কেউ গালি দিলে ডিলিট") লিখলে → যেকোনো গালি মুছবে।
   • Add Word-এ  লিংক  (অথবা "লিংক ডিলিট", link) লিখলে → যেকোনো ধরনের লিংক মুছবে (https://, www., example.com, t.me/..., tg://, লুকানো টেক্সট-লিংক, বাটন-লিংক, "example [dot] com", hxxp:// — সব)।
   • শব্দ যোগ করলে Bad Words Filter নিজে থেকে ON হয়ে যায়।
   • অন্য সাধারণ শব্দ আগের মতোই পুরো-শব্দ মেলে; অংশ মেলাতে *শব্দ* লিখুন।
৩) কে লিংক/গালির নিয়মের বাইরে?
   • Bot Creator (GTS Tarek) এবং ওই গ্রুপের প্রকৃত Creator — সবসময়, কোনো মেসেজ মুছবে না।
   • গ্রুপ Admin — আগের মতো ডিফল্টে ছাড় পায়। চাইলে Dashboard → Advanced Settings → Admin Exemption OFF করলে Admin-দের মেসেজও যাচাই হবে।
৪) আরও উন্নতি
   • Force Join চালু থাকলেও, বটকে mention করা মেসেজ আগে মডারেশনে যায় (আগে এই পথে লিংক/গালি এড়িয়ে যেত)।
   • মেসেজ মুছলে ৮ সেকেন্ডের ছোট নোটিশ (পরে নিজে মুছে যায়); Advanced Settings থেকে বন্ধ করা যায়।
   • বটের "Delete messages" permission না থাকলে গ্রুপে ১০ মিনিটে একবার জানায়।
   • প্রতি মেসেজে Telegram-এ Admin যাচাইয়ের কল কমাতে ৪৫ সেকেন্ডের Cache; মেমরি লিক বন্ধ।
   • বট Admin হলে (আগে থেকে গ্রুপে থাকলে) প্রতিবার Welcome মেসেজ দিত — এখন শুধু গ্রুপে নতুন যুক্ত হলে।
৫) AI সব ধরনের মেসেজে উত্তর দেয়
   • Private Chat: টেক্সট, ছবি (বট ছবি দেখে উত্তর দেয়), স্টিকার, GIF, ভয়েস, অডিও, ভিডিও, ফাইল, লোকেশন, Contact, Poll — সবকিছুতেই উত্তর।
   • গ্রুপে: বটকে mention বা বটের মেসেজে Reply করলে একই নিয়মে (ছবি/স্টিকারসহ) উত্তর।
   • ভয়েস/ভিডিও/ফাইলের ভেতর বট দেখতে-শুনতে পায় না — সে কথা সৎভাবে জানিয়ে লিখে বলতে অনুরোধ করে।
৬) পরীক্ষা: npm run check ও npm test (৩২টি) পাস। Deploy-এর পর Render Logs দেখুন।


=== v2.3.0 — স্থায়ী স্মৃতি (Permanent Memory) ও দুটি কপির সমস্যা ===
সমস্যা: /channels-এ Channel যোগ হলেও পরের মুহূর্তে তালিকা খালি; আগের সেটিং/ধাপ হারিয়ে যাওয়া।
কারণ (সবচেয়ে সম্ভাব্য): একই BOT_TOKEN দিয়ে বটের দুটি কপি চলছে (পুরোনো Render Service / অন্য হোস্ট / ফোন বা কম্পিউটার)। Telegram আপডেট দুই কপিতে ভাগ করে দেয়, প্রতিটির আলাদা মেমরি — তাই একটিতে যোগ হয়, অন্যটি জানে না।
   → বটের Owner চ্যাটে /health দুইবার দিন। "Instance" আইডি বদলালে দুটি কপি চলছে। পুরোনোটি বন্ধ (Suspend/Delete) করুন — শুধু একটি রাখুন। বট এখন নিজেই এই অবস্থা ধরে Owner-কে সতর্ক করে।
স্থায়ী স্মৃতি (Render Free-তেও):
   • সব ডেটা (সেটিংস, Channel/Group, Filter, Warning, Schedule, Custom Reply, AI স্মৃতি) বট নিজে থেকে Owner-এর Private Chat-এ bot-data.json ফাইল হিসেবে পাঠিয়ে PIN করে রাখে (পরিবর্তন হলে সর্বোচ্চ ১৫ মিনিটে একবার; পুরোনো Backup মুছে নতুনটি থাকে)।
   • বট রিস্টার্ট হয়ে ডিস্ক খালি পেলে ওই PIN করা ফাইল থেকে সব ফিরিয়ে আনে এবং Owner-কে জানায়।
   • এখনই Backup নিতে: Owner Private Chat-এ /backup। ⚠️ ওই পিন করা ফাইলটি মুছবেন/আনপিন করবেন না।
   • আপনি যা সেট করবেন তা আপনি নিজে মুছলে/বন্ধ করলেই কেবল বদলাবে (Filter 🗑️, Channel 🗑, Auto Reply মুছুন ইত্যাদি)।
আরও: Channel যোগের সময় সংরক্ষণ ব্যর্থ হলে এখন সৎভাবে জানায়; বোতামে "Channel / Group" লেখা; Anonymous Admin হিসেবে লিখলে বটের স্পষ্ট নির্দেশনা (Remain Anonymous বন্ধ করুন); /health-এ Instance ID ও Backup অবস্থা।


=== v2.3.1 — Audit সংশোধন (কোনো পুরোনো ফিচার/কমান্ড/Database Key বাদ যায়নি) ===
১) Render Free-তে বট ঘুমিয়ে পড়ার সমস্যা: Free Web Service ১৫ মিনিট কোনো HTTP ট্রাফিক না পেলে ঘুমিয়ে যায় এবং তখন বট আর মেসেজ পায় না।
   এখন বট নিজেই প্রতি ১০ মিনিটে নিজের /health পিং করে জেগে থাকে (Render নিজে RENDER_EXTERNAL_URL দেয়; কিছু বসাতে হবে না)। বন্ধ করতে: KEEP_ALIVE=off।
২) /health (পাবলিক লিংক) আর সার্ভারের ফাইল-পাথ (storage) দেখায় না; x-powered-by হেডারও বন্ধ। Owner-এর /health কমান্ড আগের মতোই সব তথ্য দেখায়।
৩) Reaction-এ Rate Limit (429) বা "Reaction নিষিদ্ধ" গ্রুপে প্রতি মেসেজে বার বার ব্যর্থ চেষ্টা হতো (Log ভরে যেত, Telegram Flood Limit-এর ঝুঁকি) → এখন ব্যর্থ হলে ওই গ্রুপে কিছুক্ষণ Reaction বিরতি নেয়; অন্য সবকিছু আগের মতো চলে।
৪) AI-এর System Prompt-এ ইউজারের Telegram নাম সরাসরি বসত — কেউ নামে নির্দেশ লিখে বটকে বিভ্রান্ত করতে পারত → নাম এখন এক লাইনে, বিশেষ চিহ্ন বাদ দিয়ে, সর্বোচ্চ ৪০ অক্ষরে বসে।
৫) Help মেনুতে একই বাটন আবার চাপলে (Bot Creator Info / মূল Help) "message is not modified" Error Log হতো → চুপচাপ উপেক্ষা করা হয়।
৬) Database ফাইল এখন Compact JSON-এ সংরক্ষিত হয় (পড়ার সময় কোনো পার্থক্য নেই; ফাইল ছোট, প্রতি Save-এ CPU কম)। পুরোনো Pretty ফাইলও আগের মতোই পড়া যায়।
৭) ঐচ্ছিক OPENROUTER_MODEL Environment Variable (না দিলে আগের মডেল openai/gpt-4o-mini-ই চলে)।
৮) render.yaml-এ NODE_VERSION সংখ্যার বদলে লেখা ("20") করা হয়েছে — Render Blueprint-এ সংখ্যা দিলে ভুল ধরে।
৯) নতুন টেস্ট: নাম-হার্ডেনিং। সব মিলিয়ে npm test: 35টি।


=== v2.4.0 — চারটি উন্নতি (আপনার অনুমতিতে; পুরোনো কিছু বাদ যায়নি) ===
১) AI স্মৃতি পরিষ্কার: যার সঙ্গে ৯০ দিনের বেশি কথা হয়নি শুধু তার পুরোনো স্মৃতি নিজে মুছে যায় (চালুর সময় ও প্রতি ২৪ ঘণ্টায়)। সক্রিয় ইউজারের স্মৃতি কখনো মোছে না। ডেটা ফাইল ও Backup ছোট থাকে।
২) অসম্পূর্ণ ধাপের মেয়াদ: /set /baton /send /All ইত্যাদির মাঝপথে ছেড়ে দিলে ৩০ মিনিট পর ধাপটি নিজে বাতিল হয়; Preview ১ ঘণ্টা পর। (ধাপ চললে প্রতিটি উত্তরে সময় নতুন করে গোনা হয়।)
৩) Backup ব্যবধান ৫ → ১৫ মিনিট (পরিবর্তন থাকলে)। বট বন্ধ হওয়ার সময় ও /backup দিলে সঙ্গে সঙ্গে Backup হয়, তাই ডেটা হারানোর ঝুঁকি কম।
৪) Admin Moderation (ডিফল্ট OFF = আগের মতো): গ্রুপ Creator Premium Dashboard → Advanced Settings → "Admin Moderation" ON করলে "Restrict members" অধিকারওয়ালা গ্রুপ Admin-রা /warn /unwarn /mute /unmute /ban /unban ব্যবহার করতে পারবেন। Admin, Creator ও Bot Creator-কে Punish করা এখনো যায় না; Anonymous Admin বা যাচাই না হলে অনুমতি নেই।
টেস্ট: npm test 36টি পাস।


=== v2.5.0 — সংশোধন ও নতুন সুবিধা (পুরোনো কিছু বাদ যায়নি) ===
১) Private Chat-এ কেউ স্টিকার দিলে বট একই প্যাকের, একই ইমোজির আরেকটি স্টিকার পাঠায়। না পেলে প্যাকের অন্য স্টিকার; তাও না হলে একই স্টিকার।
২) AI পার্সোনালিটি: নাম Mim Jannat; Creator প্রশ্নে "GTS Tarek"; বাসা প্রশ্নে "গোদাগাড়ী, রাজশাহী", আরও নির্দিষ্ট প্রশ্নে "সারাংপুর পুলিশপাড়া"। বট নিজে থেকে নিজের পরিচয় বলে না, নিজেকে মানুষও দাবি করে না; কেউ আন্তরিকভাবে সরাসরি জিজ্ঞেস করলে মিথ্যা না বলে ছোট্ট করে জানায় সে একটি বট।
৩) Private Chat-এ কোনো রেট লিমিট নেই (আপনার নির্দেশ অনুযায়ী)।
৪) AI উত্তরের দৈর্ঘ্য-সীমা ৫০০ থেকে ৯০০ টোকেন (AI_MAX_TOKENS দিয়ে বদলানো যায়)।
৫) স্বয়ংক্রিয় Backup এখন কমপক্ষে প্রতি ১ মিনিটে (আগে ৫ মিনিট), শুধু ডেটা বদলালে।
৬) /unmute এখন গ্রুপের নিজস্ব ডিফল্ট permission ফিরিয়ে দেয় (আগে প্রাইভেট গ্রুপে অতিরিক্ত অধিকার দিয়ে ফেলতে পারত)।
৭) নতুন কমান্ড: /privacy, /forget (নিজের AI স্মৃতি মোছা), /setup (গ্রুপে বটের permission চেকলিস্ট)। Telegram-এর "/" মেনুতে কমান্ডের তালিকা (ইউজার, গ্রুপ ও Owner-এর জন্য আলাদা) স্বয়ংক্রিয়ভাবে বসে।
৮) OpenRouter-এর HTTP-Referer এখন বটের নিজের URL; ঐচ্ছিক OPENROUTER_FALLBACK_MODEL।
৯) GitHub Actions টেস্ট (.github/workflows/test.yml)।
