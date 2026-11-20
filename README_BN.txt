MIM JANNAT BOT v2.2.0 — README (বাংলা)
Creator: GTS Tarek  |  Node.js + grammY  |  Hosting: Render

=== এই ZIP-এ কী আছে ===
ZIP খুললে সরাসরি (কোনো বাড়তি ফোল্ডার ছাড়া) এই ফাইলগুলো পাবেন:
index.js  package.json  config.js  permissions.js  personality.js  moderation-utils.js
features.js  panels.js  premium.js  premium-extra.js  profanity.js  render.yaml  .env.example  tests/
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
