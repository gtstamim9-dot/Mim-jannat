MIM JANNAT BOT — UPDATE BUILD
============================

এই ZIP-এ .env নেই। নিরাপত্তার জন্য আসল BOT_TOKEN / OPENROUTER_API_KEY শুধু Render Environment-এ রাখবে।

প্রয়োজনীয় Environment Variables (শুধু ২টি):
BOT_TOKEN
OPENROUTER_API_KEY

Deploy:
1) ZIP extract করে ভেতরের ফাইলগুলো GitHub repository-র root-এ upload করো।
2) .env.example upload করা যাবে; আসল .env upload করবে না। .gitignore-এ .env বাদ দেওয়া আছে।
3) Render Build Command: npm install
4) Render Start Command: npm start
5) Render Environment-এ BOT_TOKEN ও OPENROUTER_API_KEY যোগ করো।
6) এক BOT_TOKEN দিয়ে একটিমাত্র polling instance চালাবে; একই সঙ্গে webhook চালাবে না।
7) Deploy-এর পর নিজের Telegram Private Chat থেকে প্রথমে /start পাঠাও। প্রথম Owner ID data/bot-data.json-এ সেভ হবে। অন্য কাউকে আগে /start দিতে দেবে না।

PERSISTENT STORAGE — জরুরি:
এই কোড data/bot-data.json-এ Owner ID, Welcome Message, Custom Reply ও AI conversation সংরক্ষণ করে। Render-এর Free Web Service-এর filesystem ephemeral; restart/redeploy/spin-down হলে ফাইল হারাতে পারে এবং Free Web Service-এ Persistent Disk যোগ করা যায় না। Render Persistent Disk শুধু paid service-এ পাওয়া যায়।

যদি paid Render service ব্যবহার করো, Dashboard → Service → Disks থেকে disk যোগ করো:
Mount Path: /opt/render/project/src/data
Size: প্রয়োজন অনুযায়ী সর্বনিম্ন
এই path-টাই কোডের default DATA_DIR। disk attach করার আগে পুরোনো data/bot-data.json থাকলে backup নাও।

Render Free-তেই থাকলে বট চলতে পারে, কিন্তু Owner/Welcome/Custom Reply ডেটা স্থায়ী থাকবে—এমন নিশ্চয়তা নেই। Persistent storage চাইলে paid disk বা আলাদা persistent database দরকার।

COMMANDS
========
/start — Private Chat-এ বট চালু; DB-তে Owner না থাকলে প্রথম ব্যবহারকারী Owner হবে।
/help — ক্লিকযোগ্য বাংলা Help menu; Owner, Group, Welcome, Button, AI বিভাগে বিস্তারিত নির্দেশনা।
/id — বর্তমান Chat ID ও নিজের Telegram ID।
/send — Owner-এর Private Chat-এ text/photo/video/voice/document বেছে নিয়ে destination দিয়ে preview, Send/Cancel। Destination: @username বা numeric Chat ID; private invite link দিয়ে Chat ID বের করা যায় না।
/baton — Owner-এর Private Chat-এ মেসেজ, button label, URL, destination, sender label (Owner/Bot) দিয়ে preview ও Send/Cancel। Bot API-তে প্রকৃত sender সবসময় bot; Owner label হলে সেটি আলাদা attribution message হিসেবে পাঠানো হয়।
/welcome — Owner-এর Private Chat-এ Welcome Message edit, Preview, Confirm, ON/OFF। একই Welcome Text সব গ্রুপে প্রযোজ্য। {name} দিলে নতুন সদস্যের নাম বসবে।
/set — Group-এ Trigger ও Reply তৈরি; bot Owner অথবা ওই Group-এর Creator ব্যবহার করতে পারবেন।
/list — ওই গ্রুপের Custom Reply তালিকা।
/del 1 — তালিকার নির্দিষ্ট Reply মুছবে।
/cancel — চলমান setup বাতিল।

FEATURES
========
- Private Chat AI: OpenRouter দিয়ে বাংলা/ইংরেজি উত্তর ও সীমিত conversation history।
- Group AI: শুধু bot-কে @mention করলে অথবা bot-এর message-এ reply করলে।
- Default Bangla/English greeting replies এবং per-group custom trigger replies।
- Bot group-এ যোগ হলে setup greeting।
- নতুন সদস্য যোগ হলে Welcome Message (ON থাকলে)।
- Group/channel reaction best-effort; Telegram permission/API support না থাকলে নাও হতে পারে।
- /send ও /baton destination group-এ bot আগে থেকে থাকতে হবে এবং message পাঠানোর permission থাকতে হবে।
- Private group-এর invite link থেকে Bot API chat ID resolve করতে পারে না; group-এ /id দিয়ে numeric ID নাও।

LIMITATIONS
===========
- OpenRouter API Key-তে model access/usage থাকতে হবে। Default model: openai/gpt-4o-mini.
- Telegram bot ব্যক্তিগত user account-এর পরিচয়ে মেসেজ পাঠাতে পারে না। /baton-এ Owner-এর পক্ষ থেকে বাছলে একটি Owner attribution message এবং তার পরে bot-এর পাঠানো button message যাবে। Bot-এর পক্ষ থেকে বাছলে শুধু bot-এর button message যাবে।
- Syntax check করা হয়েছে; বাস্তব Telegram/Render deployment-এ live end-to-end test করা হয়নি।
