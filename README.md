# Mim Jannat — GTS Tarek Telegram AI Bot v1.5

## What this version does
- Reworked chat style: short, casual, context-aware replies inspired by the conversational style in the user-provided Baka screenshot, without copying its private implementation or claiming to be that bot.
- Stronger output filtering and final-answer extraction for common internal-reasoning leaks; short response limits and one retry when a model returns analysis instead of a chat reply.
- More varied fallback messages when the provider is unavailable, instead of repeating one identical error message.
- Character profile answers are handled directly for name, age, location, religion, and AI identity questions; the bot does not falsely claim to be a real human if asked directly.
- Replies to text and captions from all group members, and gives a limited context-aware response to stickers/media/other message types when their contents are not available to the AI.
- Uses separate short conversation history for each member in each chat (RAM-only; resets on restart).
- Attempts a context-based reaction to each group message and each channel post. Telegram permissions/settings may block reactions.
- Welcomes new group members.
- Creator questions answer “আমার নির্মাতা GTS Tarek 💗”.
- Persona profile: name Mim Jannat; fictional age 16; fictional location Sarangpur, Police Para, Godagari, Rajshahi, Bangladesh; character is written as Muslim. The bot truthfully identifies as AI if directly asked and does not claim to be a real human or to have real religious beliefs.
- Secrets stay in hosting Environment Variables.

## Android setup
1. Create a Telegram bot using https://t.me/BotFather and `/newbot`.
2. Create an OpenRouter API key at https://openrouter.ai/. Choose a currently available model at https://openrouter.ai/models?max_price=0. Default model: `openrouter/free`.
3. Upload all five files to a private GitHub repository. Never commit real keys.
4. On https://render.com create a Node Web Service connected to the repository. Build: `npm install`; Start: `npm start`; choose Free if offered.
5. Add Environment Variables: `BOT_TOKEN`, `OPENROUTER_API_KEY`, `OPENROUTER_MODEL`, `BASE_URL`, `WEBHOOK_SECRET`, `BOT_DISPLAY_NAME`, `CREATOR_NAME`, `REPLY_TO_ALL_TEXT`, `REACT_TO_MESSAGES`, `WELCOME_NEW_MEMBERS`, `CHANNEL_POST_REACTIONS`, `AI_TIMEOUT_MS`, `MAX_REPLY_CHARS`, `MAX_HISTORY_MESSAGES`.
6. Set `BOT_DISPLAY_NAME=Mim Jannat`, `CREATOR_NAME=GTS Tarek`, and the behavior switches to `true`. `BASE_URL` must be your real Render HTTPS URL. `WEBHOOK_SECRET` must be a random 32+ character string using letters, numbers, `_` and `-`.
7. Deploy. The app sets the Telegram webhook on startup.
8. In BotFather use `/setprivacy` → select the bot → Disable, then remove and re-add the bot to the group. Ensure the bot has permission to send messages and add reactions.
9. For channel reactions, add the bot as channel admin with suitable permissions and test a new post.

## Limitations (important)
- No bot can guarantee every reply or reaction: OpenRouter model availability/quotas, hosting outages, Telegram permissions, chat settings and API limits can prevent them.
- Render free hosting may sleep, so uninterrupted 24/7 responses are not guaranteed.
- The bot cannot understand the actual content of a photo, sticker, voice note or file unless that content is provided to it. It must not pretend to have seen/heard what it cannot access.
- It reacts to channel posts; it does not post a public reply to every channel post.
- Conversation history is held in RAM and resets when the service restarts.
- The filters are basic and cannot guarantee perfect factual accuracy or zero repetition. Different free AI models may still vary in quality.
- Group messages are sent to an external AI provider to generate replies. Avoid sharing sensitive personal information.

## Security
Never share keys in chats/screenshots or commit them to GitHub. Keep the repository private. If a token or key leaks, revoke and replace it immediately.
