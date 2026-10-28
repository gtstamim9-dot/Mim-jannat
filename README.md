# Mim Jannat — GTS Tarek Telegram AI Bot v2.3

## What this version does
- Reworked chat style: short, casual, context-aware replies inspired by the conversational style in the user-provided Baka screenshot, without copying its private implementation or claiming to be that bot.
- Stronger output filtering and final-answer extraction for common internal-reasoning leaks; short response limits and one retry when a model returns analysis instead of a chat reply.
- Provider errors are logged without sending repeated false network-error messages into chats.
- Character profile answers are handled directly for name, age, location, religion, and AI identity questions; the bot does not falsely claim to be a real human if asked directly.
- Private chats and ordinary group text messages receive replies without requiring a mention; conversation history is kept per member in each chat. Media content is not invented when unavailable.
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


## Reply behavior (v2.3)
- In groups, Mim Jannat attempts to reply to ordinary member text messages without a mention. Telegram privacy mode must be disabled in BotFather and the bot may need to be removed and re-added to the group.
- Private chats also receive replies. Other bot commands are ignored except `/mim`.
- If the AI provider fails, the bot will not repeatedly send a generic “I got your message” reply. It sends a deterministic reply only when the message matches a recognized greeting/phrase; otherwise the failure is logged for diagnosis.
- Free AI model availability and Telegram reaction permissions cannot be guaranteed by code alone.


## v2.3 behavior notes
- Expanded deterministic Bengali/English canned replies for greetings, check-ins, food, location, mood, apologies, goodbyes, sleep, compliments and more. Exact-match canned replies run before the AI model.
- Welcome message uses the requested text and the member full name where available.
- Reactions are attempted for every received group message and channel post, subject to Telegram permissions and allowed reactions.
- No software can guarantee 100% uptime, perfect answers, or reactions when external services/permissions fail.


## v2.3 fixes and tests
- Fixed-reply matching now normalizes Unicode, punctuation, emoji, zero-width characters and bot mentions before matching. Harmless trailing address words such as “ভাই” and “মিম” are supported without swallowing longer questions.
- Reaction failures now log Telegram's error in Render logs instead of silently hiding it. This helps identify missing permissions or unsupported reactions.
- `npm test` checks common Bengali/English fixed replies and normalization behavior. `node --check index.js` checks JavaScript syntax.
- A passing local test does not prove the live Telegram webhook, Render environment variables, OpenRouter service or Telegram permissions are correct; verify these in the deployed service logs.


## v2.3 reliability changes
- Bot username mentions are checked using Telegram entities and a text fallback, in case the entity metadata is missing.
- If OpenRouter fails after retries, the bot avoids sending the same generic fallback repeatedly. A recognized greeting may still receive a direct phrase reply; other AI failures are logged for diagnosis.
- Telegram API error descriptions are now included in Render logs, including reaction permission failures and webhook setup failures.
- Webhook handler exceptions are logged instead of being silently swallowed.
- Local tests cover canned replies, normalization and mention detection. These do not replace a live Telegram/Render test.


## v2.3 behavior additions
- Records fixed/canned replies in per-chat/member conversation history, so follow-up AI replies can use that context.
- Attempts a 💗 reaction on each bot reply as well as attempting a reaction on each incoming message/channel post, subject to Telegram permissions.
- Can occasionally send a romantic/cute sticker when `ROMANTIC_STICKER_IDS` contains valid comma-separated Telegram sticker file IDs. This is optional because Telegram does not provide one universal sticker file ID; leave it blank until valid IDs are available.
- Local tests validate source syntax and common phrase matching, not live Telegram delivery.
