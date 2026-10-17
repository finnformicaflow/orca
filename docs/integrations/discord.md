# Discord

The Discord adapter (`server/integrations/adapters/discord.ts`) connects Orca to one Discord bot.
People in a linked channel can @mention the bot to ask a question or to start work. Orca posts
results back to the channel. The integrations core does the permission checks. See
[ADAPTERS.md](ADAPTERS.md).

Run Discord only on the personal box (`orca-personal-box`). One bot token must have only one
Gateway session, because two sessions give each event twice. The `integration.instance` column
selects the box. Each other instance ignores the row.

## What the adapter does

- Inbound: a Gateway WebSocket with the intents `GUILDS`, `GUILD_MESSAGES`, `DIRECT_MESSAGES` and
  `MESSAGE_CONTENT`.
  - A message in a linked channel goes to the core. A message with no mention of the bot has
    `mentioned: false`. A link with `require_mention` drops it.
  - A message in a thread uses the link of the thread's parent channel. The thread is its
    conversation.
  - A new request (a mention at the top level of a channel) gets its own thread. The adapter opens
    the thread on that message after the core accepts the message.
  - A direct message (DM) goes to the link that `config.dmLink` names. With no `dmLink`, it goes to
    the integration's catch-all link (`external_id` `*`). With neither link, the core drops it.
  - An unknown person gets a pairing code from the core. The reply goes into the thread of their
    message. The adapter opens that thread when it sends the reply.
  - The adapter ignores messages from bots.
- Outbound: a post to the link's channel.
  - The first post for a workstream opens a thread on that post. The core keeps the thread id.
    Later posts for the workstream go into that thread.
  - A post with a title is an embed (a linked title and a colour). This matches the build posts in
    the same server. A reply with no title is plain text.
  - An edit replaces the message (`PATCH`).
  - Posts never ping `@everyone`, roles or users (`allowed_mentions` is empty).
  - Rate limits: the core sends at most 5 messages each 5 seconds to one channel. A `429` is retried
    after Discord's `retry_after`.

## Create the bot

1. Open the [Discord Developer Portal](https://discord.com/developers/applications).
2. Click **New Application**. Give it a name, for example `Orca`.
3. Open **Bot**. Click **Reset Token**. Copy the token. Keep it secret.
4. On the same page, turn on **Message Content Intent** (under Privileged Gateway Intents).
5. Open **OAuth2 → URL Generator**. Select the scope `bot`.
6. Select these bot permissions:
   - View Channels
   - Send Messages
   - Send Messages in Threads
   - Create Public Threads
   - Read Message History
7. Open the URL that the page gives. Add the bot to the server.
8. In Discord, open **User Settings → Advanced**. Turn on **Developer Mode**.
9. Right-click each channel that Orca uses. Click **Copy Channel ID**.
10. Right-click each person who may write to Orca. Click **Copy User ID**.

If the Message Content intent is off, the Gateway closes with code `4014`. The health line then
says so. The adapter does not reconnect after that code.

## Put the token on the box

1. On `orca-personal-box`, add the token to the bridge's environment (`.env` or the systemd unit):

   ```
   ORCA_SECRET_DISCORD_BOT=<the bot token>
   ```

2. Restart the bridge.

The orca repo is public. Never put the token in a file in the repo, in a config row or in a log.
The agent environment removes every `ORCA_SECRET_*` variable, so a worker cannot read it.

## Configure the rows

Until the Settings page lands, add rows with SQL. `user_id` is `db.currentUser()` (`ORCA_USER`, else
`me`). Replace the ids with the ids that you copied.

```sql
-- The bot. It runs only on the personal box.
INSERT INTO integration (id, user_id, kind, name, instance, config, secret_ref, created_at)
VALUES ('discord', 'me', 'discord', 'Discord', 'orca-personal-box', '{}', 'ORCA_SECRET_DISCORD_BOT', 0);

-- A channel. "work" lets the people start and steer work on the listed repos.
INSERT INTO channel_link (id, user_id, integration_id, external_id, level, repos, require_mention)
VALUES ('site-templates', 'me', 'discord', '<channel id>', 'work', '{site-templates}', true);

-- A person, and their Discord identity. The grant is min(link level, max_level).
INSERT INTO principal (id, user_id, name, max_level) VALUES ('saajan', 'me', 'Saajan', 'work');
INSERT INTO identity (user_id, principal_id, adapter, external_id) VALUES ('me', 'saajan', 'discord', '<user id>');

-- What goes out: CI failures and merges of site-templates to the channel.
INSERT INTO subscription (user_id, topic_pattern, filter, target_kind, target_id)
VALUES ('me', 'orca.pr.*', '{"repo":"site-templates"}', 'link', 'site-templates');
```

Check the columns against `server/integrations/store.ts` before you run this. The core owns the
schema.

To accept DMs, add a catch-all link (`*`). It also covers each channel that has no link of its own.

```sql
INSERT INTO channel_link (id, user_id, integration_id, external_id, level) VALUES ('discord-dm', 'me', 'discord', '*', 'ask');
```

To accept DMs only, give the link another `external_id` and name it in the integration's config:

```sql
INSERT INTO channel_link (id, user_id, integration_id, external_id, level) VALUES ('discord-dm', 'me', 'discord', 'dm', 'ask');
UPDATE integration SET config = '{"dmLink":"discord-dm"}' WHERE id = 'discord';
```

To let a new person in, approve their pairing code in Orca (`POST /api/integrations/pairing/approve`).
You can also add `principal` and `identity` rows by hand.

The primary bridge reads the rows each minute. `GET /api/integrations` shows the health line:
`connected as <bot name>`, or the reason it is down.

## Levels

| Level | What a person in the channel can do |
|---|---|
| `notify` | Nothing inbound. Orca only posts. |
| `ask` | Ask questions. Orca reads the board and past chats. |
| `work` | Also start and continue workstreams on the link's repos. |

The orchestrator's tool route checks each verb against the grant of the message. A Discord message
cannot start work on a repo that its link does not list.
