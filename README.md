# Mim Jannat — GTS Tarek Telegram Bot v2.2.0

Node.js 20+ Telegram bot with private AI chat, group-owner custom trigger/replies, private message preview/send, reactions, and welcome messages.

## Features

### Private chat
- Existing Mim Jannat AI conversation remains enabled.
- `/send` starts a guided send flow: submit one message or media item, provide the destination, inspect a preview, then press **Send Message** or **Cancel**.
- The final message is copied by Telegram from the bot account. Supported message text, captions, photos, videos, voice/audio, documents and other Telegram-copyable message types are preserved where Telegram allows.

### Groups
- No AI reply is generated for every group message, bot mention, reply-to-bot or `/mim` command.
- Existing exact built-in canned replies remain active (for example, common greetings).
- Custom exact-trigger replies are available to all group members after the creator configures them.
- Only the Telegram group creator (`getChatMember` status `creator`) can use `/setreply`, `/listreplies` and `/delreply`.
- Reactions and new-member welcome messages remain enabled when Telegram permissions/settings allow.

## Group owner commands

| Command | Purpose |
|---|---|
| `/setreply` | Start setup. Bot asks for a trigger, then asks for the response. |
| `/listreplies` | List this group's saved custom replies. |
| `/delreply` | Ask which trigger to delete. `/delreply trigger text` also works. |
| `/cancel` | Cancel the current setup. |

Example: group creator sends `/setreply`, then `Hi`, then `Hello!`. Thereafter a member's exact `Hi` message receives `Hello!`. Matching ignores case, punctuation and emoji using the existing text normalizer. A saved trigger with the same normalized text replaces the previous one.

**Permissions:** Promote the bot to group administrator so Telegram can reliably return group-member status and so reaction/send permissions are available. Only the group creator is accepted; ordinary administrators are not.

## Private `/send` flow

1. Open Mim Jannat's private chat and send `/send`.
2. Send the exact text or one media message you want the bot to copy.
3. Send a destination public `t.me` link, `@username`, private `t.me/c/<id>/<message-id>` link, or numeric `-100...` chat ID.
4. Review the preview and tap **Send Message**. The bot copies the original message to the destination as Mim Jannat.

The bot must already be a member of the destination group/channel and have permission to post. For channels, make it an administrator with posting permission. Private invite links such as `t.me/+...` cannot be resolved into a chat ID by the bot; provide the numeric `-100...` ID instead. Protected content, unavailable messages or destination restrictions can prevent copying. The flow previews one message at a time; albums are not bundled as one send.

## Deploy on Render (Android-friendly)

1. Extract this ZIP and upload the project folder to a **private** GitHub repository. Do not upload a real `.env` file or any keys.
2. In Render, create a Node Web Service connected to that repository.
3. Build command: `npm install`  
   Start command: `npm start`  
   Node version: 20 or newer.
4. Add the variables listed in `.env.example` in Render's Environment settings. Use your real Render HTTPS service URL for `BASE_URL` and generate a random `WEBHOOK_SECRET` containing only letters, numbers, `_` and `-`.
5. Deploy. On startup the app registers its Telegram webhook and bot commands.
6. Add the bot to the group, promote it to administrator, and follow the owner command steps above.
7. Add the bot to destination groups/channels before using `/send`; grant the required posting permissions.

## Persistent custom replies on Render

Custom replies are stored as JSON at `REPLY_STORE_PATH`.

For persistence across Render redeploys/restarts, attach a Render Persistent Disk and set `REPLY_STORE_PATH` to a file on its mount path, for example `/var/data/custom-replies.json`. Without a persistent disk, a redeploy or instance replacement may erase saved custom replies. The simple JSON store is intended for one running service instance, not multiple replicas.

## Environment variables

See `.env.example`. Required: `BOT_TOKEN`, `OPENROUTER_API_KEY`, `BASE_URL`, and `WEBHOOK_SECRET`. Never place real secrets in the ZIP, GitHub, screenshots or chat messages.

## Local checks

```bash
npm install
npm test
node --check index.js
```

The included tests check fixed replies, text normalization, destination parsing and related helper behavior. Passing local tests and ZIP integrity checks do **not** prove live Telegram or Render operation. Live operation depends on valid credentials, hosting, Telegram membership/permissions, destination access, and AI provider availability.

## Important limitations

- Telegram does not let a bot join a destination group/channel using an invite link by itself.
- Reactions depend on Telegram API support, chat type and permissions; they are best-effort.
- Render free services may sleep. Continuous 24/7 availability is not guaranteed.
- Private AI responses depend on OpenRouter model availability, quotas and network access.
- The bot cannot understand the actual content of media merely because it receives a file; it does not claim to have visually or audibly analyzed media.
- A private invite URL alone cannot identify a destination chat ID.
