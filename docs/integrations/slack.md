# Slack: set up the two-way adapter

This guide connects a Slack workspace to Orca in both directions:

- **Inbound.** A mention of the bot, a DM to the bot, or a reply in a thread that the bot started
  becomes an `ext.slack.message` event. The core gates it and routes it to the orchestrator, or to
  the workstream that owns the thread.
- **Outbound.** Orca posts as the bot. A reply goes into the thread of the message that it answers.
  Orca can also edit its own posts.

The adapter uses [Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/). The box
opens a WebSocket to Slack. Slack does not need a public URL, so the box stays without ingress.

The old path does not change. `POST /api/slack` (the card's Slack button) still posts as you with
your user token (`SLACK_TOKEN`, `xoxp-`).

The code is `server/integrations/adapters/slack.ts`. The contract is
[ADAPTERS.md](ADAPTERS.md).

## 1. Tokens

| Token | Prefix | Variable | Use |
|---|---|---|---|
| Bot token | `xoxb-` | `ORCA_SECRET_SLACK_BOT` | Web API calls: `auth.test`, `chat.postMessage`, `chat.update`, `users.info`. |
| App-level token | `xapp-` | `ORCA_SECRET_SLACK_APP` | `apps.connections.open`, which gives the Socket Mode URL. Scope `connections:write`. |
| User token (old) | `xoxp-` | `SLACK_TOKEN` | "Post as me" from the card. Not part of this adapter's connection. |

Every `ORCA_SECRET_*` variable is removed from the environment of agents, checks and previews
(`server/env.ts`). A prompt injection cannot read these tokens.

## 2. Create the Slack app

1. Open <https://api.slack.com/apps>.
2. Click **Create New App**, then **From an app manifest**.
3. Select the workspace.
4. Paste the manifest below. Change `name` if you want a different bot name.
5. Click **Create**.

```yaml
display_information:
  name: Orca
  description: Orca's orchestrator. Mention it, or send it a DM.
features:
  app_home:
    home_tab_enabled: false
    messages_tab_enabled: true
    messages_tab_read_only_enabled: false
  bot_user:
    display_name: Orca
    always_online: true
oauth_config:
  scopes:
    bot:
      - app_mentions:read
      - chat:write
      - channels:history
      - groups:history
      - im:history
      - users:read
settings:
  event_subscriptions:
    bot_events:
      - app_mention
      - message.channels
      - message.groups
      - message.im
  interactivity:
    is_enabled: false
  org_deploy_enabled: false
  socket_mode_enabled: true
  token_rotation_enabled: false
```

The scopes:

| Scope | Why |
|---|---|
| `app_mentions:read` | Receive `app_mention` events. |
| `chat:write` | Post and edit as the bot. |
| `channels:history`, `groups:history` | Receive replies in a bot thread in public and private channels. The reply does not mention the bot. |
| `im:history` | Receive DMs to the bot. |
| `users:read` | Find a person's display name for pairing (`resolveUser`). |

`messages_tab_enabled` lets a person send a DM to the bot.

## 3. Get the two tokens

1. In the app, open **Basic Information**.
2. Under **App-Level Tokens**, click **Generate Token and Scopes**.
3. Name it `socket`, add the scope `connections:write`, and click **Generate**.
4. Copy the `xapp-` token. This is `ORCA_SECRET_SLACK_APP`.
5. Open **Install App** and click **Install to Workspace**. Accept the scopes.
6. Copy the **Bot User OAuth Token** (`xoxb-`). This is `ORCA_SECRET_SLACK_BOT`.
7. In each channel that Orca must read, type `/invite @Orca`.

## 4. Put the tokens on the box

The bridge reads `/opt/orca/.env` at start (the unit's `WorkingDirectory`). Do these steps on the
instance that runs Slack (the work box).

1. Open a shell on the box as the `orca` user (SSM, or the instance web terminal).
2. Add the two lines to `/opt/orca/.env`:

   ```sh
   ORCA_SECRET_SLACK_BOT=xoxb-...
   ORCA_SECRET_SLACK_APP=xapp-...
   ```

3. Make sure only `orca` can read the file: `chmod 600 /opt/orca/.env`.
4. Restart the bridge: `sudo systemctl restart orca`.

Never put a token in `orca.config.ts`, in a database row, or in a commit. The repo is public. A row
holds only the variable NAME.

## 5. Add the rows

Until the Settings page lands, add the rows with SQL on the Orca database. Set `instance` to the
`ORCA_INSTANCE` of the box that holds the tokens. Only the primary bridge of that instance opens the
socket. `user_id` is `db.currentUser()` (`ORCA_USER`, else `me`).

```sql
-- The connection. secret_ref names the bot token's variable.
INSERT INTO integration (id, user_id, kind, name, instance, config, secret_ref, created_at)
VALUES ('slack-work', 'me', 'slack', 'Work Slack', 'cloud', '{}', 'ORCA_SECRET_SLACK_BOT', 0);

-- A channel Orca reads and posts to. Find the id in the channel's details (C...).
INSERT INTO channel_link (id, user_id, integration_id, external_id, level, require_mention)
VALUES ('eng', 'me', 'slack-work', 'C0123456789', 'ask', true);

-- Every DM to the bot. The external id is the fixed word 'im'.
INSERT INTO channel_link (id, user_id, integration_id, external_id, level, require_mention)
VALUES ('slack-dm', 'me', 'slack-work', 'im', 'ask', false);

-- Each person who may write to Orca, by Slack user id (U...: profile → ⋯ → Copy member ID).
INSERT INTO principal (id, user_id, name, max_level) VALUES ('finn', 'me', 'Finn', 'work');
INSERT INTO identity (user_id, principal_id, adapter, external_id) VALUES ('me', 'finn', 'slack', 'U0123456789');
```

A person with no `identity` row gets nothing: the gate drops the message.

The primary bridge reads the rows each minute. You do not need a restart.

Optional `config` keys on the `integration` row:

| Key | Default | Effect |
|---|---|---|
| `appTokenRef` | `"ORCA_SECRET_SLACK_APP"` | The app-level token's variable. It must start with `ORCA_SECRET_`. |
| `socket` | `true` | `false` turns inbound off. The bot then posts only. |

## 6. Check it

1. Open `GET /api/integrations` on the box. `running.slack-work` must show
   `ok: true` and `Socket Mode connected as U...`.
2. In a linked channel, type `@Orca what is on the board?`.
3. The orchestrator wakes with the message fenced as an outside message with the `ask` grant.
4. The answer comes back in a thread under your message.

If the adapter does not start, `integration.status.error` holds the reason. Some examples:

- `ORCA_SECRET_SLACK_APP is not set (the app-level token, for Socket Mode)`
- `auth.test: invalid_auth`: the bot token is wrong or revoked.
- `apps.connections.open: invalid_auth`: the app-level token is wrong, or Socket Mode is off.

## 7. How events map

| Slack | Orca |
|---|---|
| `app_mention`, or a `message` that contains `<@bot>` | `mentioned: true`. The bot tag is removed from the text. |
| A `message` in a thread that the bot started (`parent_user_id` is the bot) | `mentioned: true`, so a reply to Orca needs no mention. |
| A `message` with `channel_type: im` | Source channel `im` (the DM link), `mentioned: true`. |
| Any other channel `message` | `mentioned: false`. A link with `require_mention` drops it. |
| A bot's post, Orca's own post, an edit, a delete, a join | Ignored. |

- **Key:** `slack:<team>:<channel>:<ts>`. Slack sends a mention twice (`app_mention` and `message`).
  Both have one key, so the core records one event. A resent envelope is also a duplicate.
- **Thread:** `<channel>:<thread_ts>`, or `<channel>:<ts>` for a top-level message. The reply goes
  into that thread. `messageId` is the message's own `ts`.
- **Send:** when the target has a thread id, the adapter posts to the thread id's channel. A reply
  to a DM therefore reaches the DM, not the `im` link.

## 8. Limits

- **Ack.** The adapter acks each envelope at once. Slack resends an envelope with no ack after 3 s.
- **Reconnect.** On `disconnect` or a closed socket the adapter opens a new one: 1 s, doubling to
  30 s. A `Retry-After` from Slack wins when it is longer.
- **Outbound pace.** One post per second per channel (`caps.rate`). A `429` returns `retryable: true`
  with `retryAfterMs` from Slack's `Retry-After`. The core waits that long before the next attempt.
- **One socket.** Only the primary bridge of `integration.instance` starts the adapter. Slack allows
  up to 10 Socket Mode connections for each app, but Orca opens one.
- Files and reactions are not supported yet (`caps.attachments` and `caps.reactions` are `false`).
