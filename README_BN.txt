MIM JANNAT — FRESH TELEGRAM BOT v1.0
====================================

এই ZIP-এ নতুন করে তৈরি করা বট আছে। পুরোনো বটের ফাইলের ওপর নির্ভর করে না।

শুধু ২টি Environment Variable লাগবে:
1) BOT_TOKEN
2) OPENROUTER_API_KEY

গুরুত্বপূর্ণ নিরাপত্তা:
- Deploy করার পর বটের ব্যক্তিগত চ্যাটে সবার আগে তুমি নিজে /start পাঠাবে।
- প্রথম যে ব্যক্তি private chat-এ /start করবে, সে Owner হিসেবে সংরক্ষিত হবে।
- তাই /start করার আগে বটের username/link কাউকে দেবে না।
- Telegram bot token বা OpenRouter API key কাউকে/এই চ্যাটে পাঠাবে না। Render-এর Environment-এ বসাবে।

Render-এ Deploy:
1. ZIP extract করো এবং GitHub repository-তে সব ফাইল upload করো।
2. Render → New → Web Service → ওই repository select করো।
3. Build Command: npm install
4. Start Command: npm start
5. Environment Variables-এ শুধু এই দুইটি যোগ করো:
   BOT_TOKEN = @BotFather থেকে পাওয়া token
   OPENROUTER_API_KEY = OpenRouter dashboard থেকে পাওয়া API key
6. Deploy শেষ হলে bot-কে ব্যক্তিগত চ্যাটে খুলে /start পাঠাও।
7. এরপর Owner হিসেবে /help ও /send ব্যবহার করতে পারবে।

বটের সুবিধা:
- Private chat-এ OpenRouter AI chat এবং সীমিত conversation context।
- Group-এ predefined Bangla/English greeting reply।
- Group custom trigger: /set, /list, /del, /cancel। শুধু group Creator এই custom-reply command চালাতে পারবে।
- Group AI reply হবে শুধু bot-কে mention করলে অথবা bot-এর message-এ reply করলে।
- /send: Owner private chat থেকে text/photo/video/voice/document বেছে নিয়ে preview করে group-এ পাঠাতে পারবে।
- /id: বর্তমান chat ID দেখাবে।
- নতুন member এলে welcome message।
- Group ও channel message-এ সীমিত random reaction (Telegram permission/API support সাপেক্ষে)।

Private group link সম্পর্কে:
Telegram Bot API শুধু invite link দেখে private group-এর chat ID বের করতে পারে না।
Private group-এ bot যোগ করে সেখানে /id চালাও; পাওয়া numeric Chat ID /send-এর destination হিসেবে দাও।
Public group-এর @username বা public t.me link ব্যবহার করা যায়।

Owner data / persistence:
Owner ID ও custom trigger data/data.json-এ রাখা হয়। Render Free service-এর local filesystem স্থায়ী নয়; service recreate/redeploy হলে এই data হারাতে পারে। Data হারালে bot-এর private chat-এ আবার প্রথমে /start পাঠিয়ে Owner claim করতে হবে। স্থায়ীভাবে রাখতে Render Persistent Disk ব্যবহার করতে হবে (যদি তোমার plan-এ available থাকে), mount path /opt/render/project/src/data দিয়ে DATA_DIR সেট করতে হবে। DATA_DIR না দিলেও চলে।

OpenRouter:
এই কোডে default model হিসেবে openai/gpt-4o-mini সেট করা আছে। এটি index.js-এর OPENROUTER_MODEL constant থেকে বদলানো যায়; আলাদা environment variable দরকার নেই। OpenRouter account-এ ওই model access/usage available থাকতে হবে।

সীমাবদ্ধতা ও দরকারি সেটিং:
- Group-এ bot-কে add করতে হবে। Welcome message পাঠাতে bot-এর send permission লাগবে।
- Reaction দিতে Telegram-এর setMessageReaction support ও bot permission লাগতে পারে; না থাকলে error silently ignore হবে।
- /send করার সময় bot-কে destination group-এ আগে থেকেই add থাকতে হবে এবং message পাঠানোর permission থাকতে হবে।
- /send-এর private invite link destination হিসেবে কাজ করবে না; numeric chat ID ব্যবহার করো।
- এক BOT_TOKEN দিয়ে একসঙ্গে একটির বেশি polling instance চালাবে না। Webhook mode-ও একসঙ্গে চালাবে না; এই project নিজে startup-এ webhook delete করে polling চালু করে।
- AI reply-এর জন্য OpenRouter usage/credit ও internet connection দরকার।

ফাইল:
index.js          মূল বট
package.json      dependencies ও start command
.env.example     দুইটি variable-এর নমুনা
render.yaml       Render service config
README_BN.txt    বাংলা নির্দেশনা
