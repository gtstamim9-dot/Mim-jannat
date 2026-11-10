# Mim Jannat Telegram Bot v2.3 FINAL — GTS Tarek

Node.js 20+ Telegram webhook bot. This release is built from the original v2.1 source so the existing private AI personality, OpenRouter integration, welcome message, reactions, channel reactions and canned-reply library remain in place.

## What it does

- **Private chat:** normal AI conversation using the existing OpenRouter model and personality.
- **Ordinary group messages:** no group AI chat and no reply to every message. The bot replies only to built-in Bengali/English preset triggers or exact custom triggers saved by the group creator.
- **Group mention/reply:** when a member mentions the bot or replies to one of the bot's messages, the bot uses the AI chat personality to answer in context.
- **Custom replies (group creator only):** `/set`, `/list`, `/del`, `/cancel`. `/set` asks for a trigger, then asks for the reply, and saves it per group.
- **Private `/send` (Bot Owner only):** requires `OWNER_TELEGRAM_ID`. Use `/id` in private chat to see your numeric Telegram ID, put it in Render Environment Variables, then `/send` can collect a text/media message, ask for a target group/channel, show a copy preview with Send/Cancel buttons, and copy the exact original Telegram message after Send. Supports text, photo, video, voice, audio, video note, document, animation and sticker, subject to Telegram's copyMessage limits.
- Existing welcome message, group message reactions and channel post reactions are retained.

## Important Telegram setup (required for ordinary group triggers)

1. Open **@BotFather**.
2. Send `/setprivacy`, select this bot, then choose **Disable**.
3. Remove the bot from the group and add it again (or make it an administrator).
4. Ensure the bot can send messages. For reactions, allow the relevant reaction permission. For channel posting, make the bot an administrator with post permission.

If privacy mode remains enabled and the bot is not an administrator, Telegram may not deliver ordinary group messages such as `Hi` to the bot. The preset/custom trigger feature then cannot see those messages.

## Custom reply commands

- `/set` — Owner sends a trigger message; bot asks for the reply; Owner sends the reply.
- `/list` — list saved triggers for this group.
- `/del` — bot asks which trigger to delete; or `/del trigger text`.
- `/cancel` — cancel the current setup.
- `/register <private invite link>` — in the target private group, the Owner registers that exact invite link so `/send` can resolve it later. `/register` without a link records the current group, but an invite link still needs to be mapped explicitly.

Only the Telegram group **creator** can use these commands. The bot must be able to verify the creator through `getChatMember`; making the bot an administrator is recommended for reliable owner checks.

## Private `/send` flow

1. In the bot's private chat, send `/send`.
2. Send the message/media to copy.
3. Send a public group link (`https://t.me/groupusername`), a private invite link already registered with `/register <same link>`, or a `-100...` chat ID.
4. The bot shows a preview with **Send** and **Cancel** buttons.
5. Send copies the original message to the destination. The bot must already be a member of the destination; for a channel it must have post permission.

**Private invite limitation:** Telegram Bot API does not provide a way to turn an arbitrary private invite link into a chat ID. Add the bot to that group, then run `/register <exact invite link>` there as the group creator.

## Render deployment

- Runtime: Node 20 or newer. Build command can be blank; Start command: `npm start`.
- Set the new `OWNER_TELEGRAM_ID` variable to your numeric Telegram user ID. To find it, open the bot privately and send `/id`.
- Keep your existing Render Environment Variables unchanged. Do not delete the existing `BOT_TOKEN`, `OPENROUTER_API_KEY`, `OPENROUTER_MODEL`, `BASE_URL`, `WEBHOOK_SECRET`, or other v2.1 settings.
- For durable custom replies, attach a Render Persistent Disk and set `RENDER_DISK_PATH` to its mount path (example `/var/data`). Without a persistent disk, local file storage can be lost when the service is redeployed/recreated.
- Do not upload or share a real `.env` file. `.env.example` contains placeholders only.

## Tests

Run `npm test` and `node --check index.js`. Tests validate normalization, built-in replies and target-link parsing; they do not replace a live Telegram/Render test.
