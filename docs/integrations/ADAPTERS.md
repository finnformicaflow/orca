# How to write an Orca adapter

This guide is for the branches that stack on the integrations core: Slack two-way, Discord, email,
the Settings page, the GitHub poller and Linear. The design is
[docs/research/integrations.md](../research/integrations.md) section 3. Read this guide first. Do not
change the core to add an adapter. If an adapter needs a core change, change the core in its own
commit and update this guide.

## 1. What the core does, and what an adapter does

The core does these tasks. An adapter never does them:

- It removes duplicate events (`event.key` is unique).
- It checks the sender against the link and the person (the gate).
- It records the event and plans the deliveries in one transaction.
- It retries a failed send with backoff and marks the delivery dead after 6 attempts.
- It stores thread links and passes the thread back to the adapter.
- It paces outbound sends per target (from `caps.rate`) and inbound messages per sender.
- It starts the adapter only on the primary bridge of the instance in `integration.instance`.

An adapter does only these tasks:

- It talks to one platform (a socket, a poll loop, or an HTTP route).
- It turns each platform event into an envelope and calls `ctx.ingest`.
- It sends one message in `send` and returns a `SendResult`.

## 2. Files

| File | Content |
|---|---|
| `shared/integrations.ts` | The envelope, topics, grants, `Capabilities`, `Target`, `OutboundMessage`, `SendResult`, `InboundMessage`, `ConversationRef`, and the pure decisions. |
| `server/integrations/adapter.ts` | The `Adapter` interface, `AdapterContext`, `Connection`, `AdapterFactory`. |
| `server/integrations/registry.ts` | `register(kind, factory)`, `sync()`, `handle()`, `health()`. |
| `server/integrations/router.ts` | `ingest` (the gate) and `publish`. |
| `server/integrations/dispatcher.ts` | The delivery loop. |
| `server/integrations/inbox.ts` | The orchestrator and workstream targets. |
| `server/integrations/store.ts` | All SQL. |
| `server/integrations/adapters/` | `web.ts`, `webhook.ts`, `slack.ts`. Put a new adapter here. |

## 3. The interface

This is the exact contract (`server/integrations/adapter.ts`):

```ts
export type Connection = {
  id: string;
  kind: AdapterKind;            // "slack" | "discord" | "email" | "github" | "linear" | "webhook" | "web" | string
  name: string;
  instance: string;             // the ONE instance that runs it
  config: Record<string, unknown>; // non-secret settings
  secretRef?: string;           // an environment variable NAME, never a value
  enabled: boolean;
};

export type AdapterContext = {
  connection: Connection;
  secret(): string | undefined;
  ingest(e: InboundEnvelope): Promise<"new" | "duplicate" | "rejected">;
  cursor: { get(): Promise<string | undefined>; set(v: string): Promise<void> };
  status(s: { ok: boolean; detail?: string; lastEventAt?: number }): Promise<void>;
  log(msg: string): void;
  signal: AbortSignal;          // aborted at stop
};

export interface Adapter {
  readonly kind: AdapterKind;
  readonly caps: Capabilities;
  start(ctx: AdapterContext): Promise<void>;
  stop(): Promise<void>;
  send(target: Target, msg: OutboundMessage, idempotencyKey: string): Promise<SendResult>;
  health(): Promise<{ ok: boolean; detail?: string; lastEventAt?: number }>;
  resolveUser?(externalId: string): Promise<{ id: string; name: string } | undefined>;
  handle?(req: Request, body: string): Promise<Response>;
}

export type AdapterFactory = (connection: Connection) => Adapter;
```

The data shapes (`shared/integrations.ts`):

```ts
export type Capabilities = {
  inbound: "socket" | "poll" | "relay" | "none";
  outbound: boolean;
  threads: boolean; edits: boolean; reactions: boolean; attachments: boolean;
  maxTextLength: number;
  rate?: { perTarget: number; windowMs: number };
};

export type Target = { linkId?: string; externalId: string; threadId?: string; messageId?: string };

export type OutboundMessage = {
  text: string; title?: string; url?: string; topic?: Topic;
  replyToExternalMsgId?: string; references?: string[];   // email threading
  edit?: boolean;                                          // replace Target.messageId
  attachments?: string[];
};

export type SendResult =
  | { ok: true; externalMsgId?: string; threadId?: string }
  | { ok: false; retryable: boolean; retryAfterMs?: number; error: string };

export type ConversationRef = { adapter: string; externalId: string; messageId?: string };

export type InboundMessage = {
  adapter: string; integrationId?: string; channel?: string;
  eventId: string; from: { adapter: string; id: string; name?: string };
  text: string; thread?: ConversationRef; mentioned?: boolean;
  attachments?: string[]; at?: number; raw?: unknown;
};
```

`inboundEnvelope(m: InboundMessage)` turns a chat or email message into the envelope. Its key is
`<adapter>:<eventId>` and its topic is `ext.<adapter>.message`.

## 4. Rules for each method

### `start(ctx)`

- The registry calls it only on the primary bridge of `connection.instance`. Do not check this again.
- Resolve when the adapter is ready. Do not hold the promise open for the life of a socket.
- Keep a socket or a poll loop alive until `ctx.signal` aborts.
- Reconnect on your own after a drop. Call `ctx.status({ ok: false, detail })` while you are down.
- Read the token with `ctx.secret()`. Never log it. Never put it in an envelope or in `raw`.
- Throw if the adapter cannot start (for example, a bad token). The registry records the error.

### `ingest` (you call it)

- Set `key` from the platform's own event id. A retry or a reconnect then gives `"duplicate"`.
- Set `source.channel` to the external place (a Slack channel id, a mailbox, a hook name). The core
  finds the `channel_link` row for it. A place with no link is `"rejected"`.
- Set `actor` for a person. The core finds the person through `identity`. An unknown person is
  `"rejected"` until a later branch adds pairing codes.
- Leave `actor` empty for a machine sender (a webhook, a poller). The integration is then the
  identity, and the grant is the link's level.
- Set `mentioned: false` for a chat message that does not mention Orca. A link with
  `require_mention` drops it.
- Set `thread` for a message in a thread. The core sends a reply in a linked thread to its workstream.
- Never set `grant`. The core sets it.

### `send(target, msg, idempotencyKey)`

- `idempotencyKey` is the delivery id. The same delivery can come twice (a crash after the send).
  - Email: use it in the `Message-ID`.
  - Chat: return `externalMsgId`. The core stores it before the next attempt.
- Post in `target.threadId` when it is set. Return `threadId` for a new post. The core stores it
  as the workstream's thread on that link. The thread id is yours: the core only stores it and
  gives it back. Slack uses `channel:thread_ts`.
- Edit `target.messageId` when `msg.edit` is true and `caps.edits` is true.
- The core cuts `msg.text` to `caps.maxTextLength`.
- Never throw for a platform error. Return `{ ok: false, retryable, error }`.
  - `retryable: true` for a network error, a 5xx, or a rate limit. Add `retryAfterMs` when the
    platform gives it.
  - `retryable: false` for bad auth, a missing channel, or a bad message.
- The core paces sends per target from `caps.rate`. Set it when the platform has a limit.

### `handle(req, body)`

- Only for `caps.inbound === "relay"`. The route is `POST /api/integrations/<id>/inbound`.
- `body` is the raw text. Check the signature against it before you parse it.
- Answer the request yourself. Return a 2xx fast; the platform retries a slow answer.

### `stop()`

- Close sockets and timers. The registry also aborts `ctx.signal`.

## 5. Register the adapter

1. Write `server/integrations/adapters/<kind>.ts`. Export a factory `(connection) => Adapter`.
2. Add one line to `server/integrations/registry.ts`: `register("<kind>", <kind>Adapter);`.
3. Add the kind's topics to `Topic` in `shared/integrations.ts` only if `ext.<kind>.<event>` is not
   enough.
4. Write a test in `tests/` that drives the adapter with a stubbed `fetch` or a fake server.

## 6. Configure an integration

Until the Settings page lands, configure an integration with SQL or with `store.ts` from a script.

1. Put the token in the instance's environment (`.env` or the systemd unit). Name it
   `ORCA_SECRET_<SOMETHING>`. The agent environment strips every `ORCA_SECRET_*` variable. The
   registry refuses any other name, except the names in `ORCA_SECRETS` (`server/env.ts`).
2. Add an `integration` row: `id`, `kind`, `name`, `instance` (the instance that runs it),
   `config`, `secret_ref` (the variable name).
3. Add a `channel_link` row for each external place: `level` (`notify`, `ask` or `work`), `repos`
   (for `work`), `require_mention`.
4. Add `principal` and `identity` rows for each person who may write to Orca.
5. Add `subscription` rows for what goes out: `topic_pattern`, `filter` (for example
   `{"repo":"orca"}`), `target_kind` (`link`, `orchestrator`, `workstream`, `web`), `target_id`
   (the link id, or `repo::branch`).

The primary bridge syncs the rows each minute. You do not need a restart.
`GET /api/integrations` shows the rows, what runs on this bridge, its health and the dead deliveries.

Example: CI failures for repo `orca` go to the Slack channel `C123`.

`user_id` is `db.currentUser()` (`ORCA_USER`, else `me`).

```sql
INSERT INTO integration (id, user_id, kind, name, instance, config, secret_ref, created_at)
VALUES ('slack-work', 'me', 'slack', 'Work Slack', 'cloud', '{}', 'ORCA_SECRET_SLACK_BOT', 0);
INSERT INTO channel_link (id, user_id, integration_id, external_id, level)
VALUES ('eng', 'me', 'slack-work', 'C123', 'notify');
INSERT INTO subscription (user_id, topic_pattern, filter, target_kind, target_id)
VALUES ('me', 'orca.pr.ci_failed', '{"repo":"orca"}', 'link', 'eng');
```

## 7. Permissions

| Level | The sender can | Orca can, for that message |
|---|---|---|
| `notify` | Nothing inbound. The gate drops the message. | Post to the link. |
| `ask` | Ask questions. | `orca board`, `chats`, `read`, `notes`, `preview --status`, `repo list`. |
| `work` | Ask, and start or steer work on the link's repos. | Also `spawn`, `send`, `address`, `status`, `pr-shots`, `preview` on those repos. |
| `full` | Your own chat in Orca. | Every verb. |

- The grant is min(link level, person's max level). The link's repos limit `work`.
- The orchestrator wakes for one grant at a time. Messages of another grant wait in the queue.
- The orchestrator's tool route (`POST /api/orchestrator/tool`) checks every verb against the
  grant of the wake in flight. A prompt cannot get past it.
- A wake for an outside sender has no shell. It can act only through `orca`.
- The text of an outside message goes into the prompt fenced, with its source, sender and grant.

## 8. What each later adapter needs from the core

| Branch | Uses | Adds |
|---|---|---|
| Slack two-way | `ingest`, `inboundEnvelope`, `thread`, `mentioned`, thread links, `caps.edits`. | Socket Mode in `start` (`inbound: "socket"`), a bot token in `ORCA_SECRET_SLACK_BOT`, an app-level token in `ORCA_SECRET_SLACK_APP`. Keep `postAsUser` for "post as me". Setup: [slack.md](slack.md). |
| Discord | The same as Slack. | Gateway in `start`. Run it on the personal box: set `integration.instance`. |
| Email | `OutboundMessage.replyToExternalMsgId` and `references`, `idempotencyKey` as the Message-ID, `ConversationRef.messageId`, `cursor` for an IMAP UID. | IMAP IDLE in `start`. A DKIM check before `ingest`. |
| Settings UI | `store.ts` (every table), `registry.health()`, `store.retryDead()`, `GET /api/integrations`. | Routes to write rows. A Test button that calls `publish` with a test key. |
| GitHub poller | `cursor` (an ETag or a timestamp), `ingest` without `actor`, topics `orca.pr.*` or `ext.github.*`. | A poll loop in `start` (`inbound: "poll"`). |
| Linear | The same as the GitHub poller, plus thread links for issues. | GraphQL polls. |
| Unified inbox | The `event` table (`ext.*.message`, `orca.question`). | A view. |

## 9. Behaviour that stays as before

- `POST /api/slack` posts `{channel, text}` with `SLACK_TOKEN` as you. It goes through the Slack
  adapter's `send` (`postAsUser`) and answers at once. It does not use the delivery queue, so the
  card still shows a failed post at once.
- `POST /api/orchestrator/event` stays. Instances use it to send worker reports to the
  orchestrator's instance. Scripts use a webhook integration in its place.
- `notify.emit` writes the notification row as before. For a new row it also writes the event with
  the same key.
