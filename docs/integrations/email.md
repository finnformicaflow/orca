# Email

The email adapter lets a person send mail to Orca, and lets Orca send mail to that person. The
code is `server/integrations/adapters/email.ts` and the files in `server/integrations/adapters/email/`.
The design is [docs/research/integrations.md](../research/integrations.md) phase 6. The adapter
contract is [ADAPTERS.md](ADAPTERS.md).

## 1. What it does

- **Inbound.** The adapter keeps one IMAP connection open to one mailbox. It uses IDLE (RFC 2177).
  If the server has no IDLE, or `idle` is `false`, it polls every `pollSeconds` (default 60).
- **Outbound.** The adapter sends mail with SMTP or with the Resend API. `outbound` in the config
  selects one.
- **Threads.** The thread id is the root Message-ID of the conversation. A reply finds its
  workstream through `References` and `In-Reply-To`.
- **The gate.** A mail must pass these checks before it gets to the core:
  1. It is not from Orca's own address.
  2. It is not an auto-reply, a bounce or a list mail.
  3. The sender is in `allowedSenders`.
  4. Your receiving server says DKIM, SPF or DMARC passed for the From domain.
- **Attachments.** Each attachment becomes an Orca attachment. A file over 20 MB is not kept. The
  text says which file was not kept.
- **Plain text.** The adapter uses the `text/plain` part. If there is none, it changes the HTML to
  text. It removes the quoted history of a reply (`keepQuoted: true` keeps it).

After the gate, the core does its usual checks: the link, the person and the grant.

## 2. Make a mailbox

Use a mailbox that only Orca reads. Orca marks each mail it reads as `\Seen`.

1. Make a new mailbox, for example `orca@yourdomain.com`.
2. Turn on IMAP for the mailbox.
3. Make an app password for IMAP. Make one for SMTP too, if the provider needs a different one.
4. Find the authserv-id of the provider's receiving server. Open a mail in the mailbox and read
   the first `Authentication-Results` header. The first word is the authserv-id.

| Provider | IMAP | SMTP | authserv-id |
|---|---|---|---|
| Gmail / Google Workspace | `imap.gmail.com:993` | `smtp.gmail.com:465` | `mx.google.com` |
| Fastmail | `imap.fastmail.com:993` | `smtp.fastmail.com:465` | the host in the header, for example `mx.messagingengine.com` |

Set `authservId`. If you do not set it, the adapter trusts only the topmost
`Authentication-Results` header.

## 3. Set the secrets

Put the secrets in the environment of the instance that runs the adapter (`.env` or the systemd
unit). The agent environment removes every `ORCA_SECRET_*` variable. Use these names:

| Variable | Content | Needed |
|---|---|---|
| `ORCA_SECRET_EMAIL_IMAP` | The IMAP password. This is the integration's `secret_ref`. | For inbound mail. |
| `ORCA_SECRET_EMAIL_SMTP` | The SMTP password. Name it in `smtp.secretRef`. If you do not set `smtp.secretRef`, SMTP uses the IMAP password. | For `outbound: "smtp"`. |
| `ORCA_SECRET_RESEND` | The Resend API key. Name it in `resend.secretRef`. | For `outbound: "resend"`. |

You can use other names. Each name must start with `ORCA_SECRET_`.

## 4. Add the rows

Add the rows with SQL until the Settings page lands. `user_id` is `db.currentUser()` (`ORCA_USER`,
else `me`).

1. Add the integration. `instance` is the instance that runs the IMAP connection.

   ```sql
   INSERT INTO integration (id, user_id, kind, name, instance, config, secret_ref, created_at)
   VALUES ('mail', 'me', 'email', 'Orca mail', 'cloud', '{
     "address": "orca@yourdomain.com",
     "fromName": "Orca",
     "imap": { "host": "imap.gmail.com", "port": 993 },
     "outbound": "smtp",
     "smtp": { "host": "smtp.gmail.com", "port": 465, "secretRef": "ORCA_SECRET_EMAIL_SMTP" },
     "allowedSenders": ["finn@yourdomain.com"],
     "authservId": "mx.google.com"
   }', 'ORCA_SECRET_EMAIL_IMAP', 0);
   ```

2. Add one link for each person. The link's external id is the person's address, in lower case.
   The same link carries their mail in and Orca's mail out to them.

   ```sql
   INSERT INTO channel_link (id, user_id, integration_id, external_id, level, repos, require_mention)
   VALUES ('mail-finn', 'me', 'mail', 'finn@yourdomain.com', 'work', '{orca}', false);
   ```

   You can also add one catch-all link with external id `*`. It accepts mail from every address in
   `allowedSenders`. A sender with no `identity` row gets a pairing code by mail, in reply to their
   mail. Approve the code in Orca. A subscription cannot send to `*`: use a link with the address.

3. Add the person and their address.

   ```sql
   INSERT INTO principal (id, user_id, name, max_level) VALUES ('finn', 'me', 'Finn', 'work');
   INSERT INTO identity (user_id, adapter, external_id, principal_id) VALUES ('me', 'email', 'finn@yourdomain.com', 'finn');
   ```

4. Add a subscription for each kind of mail Orca sends. This example mails each finished or failed
   run in repo `orca`.

   ```sql
   INSERT INTO subscription (user_id, topic_pattern, filter, target_kind, target_id)
   VALUES ('me', 'orca.run.*', '{"repo":"orca"}', 'link', 'mail-finn');
   ```

The primary bridge reads the rows each minute. `GET /api/integrations` shows the health of the
adapter, for example `idle on INBOX` or `polling every 60s`.

## 5. The config

| Key | Default | Meaning |
|---|---|---|
| `address` | (required) | Orca's address. It is the From of each mail and the IMAP user. |
| `fromName` | none | The display name in From. |
| `imap.host`, `imap.port`, `imap.tls`, `imap.user`, `imap.mailbox` | port 993, TLS on, user = `address`, `INBOX` | The IMAP server. Without `imap`, the adapter only sends. |
| `idle` | `true` | Use IDLE when the server has it. |
| `pollSeconds` | 60 | The poll interval when there is no IDLE. |
| `outbound` | `none` | `smtp`, `resend` or `none`. |
| `smtp.host`, `smtp.port`, `smtp.security`, `smtp.user`, `smtp.secretRef` | port 465, `implicit` (port 587: `starttls`), user = `address` | The SMTP server. `security` is `implicit`, `starttls` or `none`. |
| `resend.secretRef`, `resend.apiUrl` | `https://api.resend.com/emails` | The Resend key variable. |
| `allowedSenders` | `[]` | Addresses, or `@domain` for a domain. An empty list lets no mail in. |
| `authservId` | none | The authserv-id of your receiving server. |
| `requireDkim` | `false` | Refuse a mail that has only an SPF or DMARC pass. |
| `keepQuoted` | `false` | Keep the quoted history of a reply in the text. |
| `perHour` | 20 | The maximum number of mails to one address each hour. |

## 6. Threads

- Orca's first mail about a workstream starts a thread. Its Message-ID is
  `<orca.<delivery id>@<your domain>>`. The core stores it as the workstream's thread on that link.
- Each later mail about the workstream has `In-Reply-To` and `References` set to the thread. Its
  subject starts with `Re:`.
- A reply from the person has Orca's first Message-ID as the first entry in `References`. The core
  sends the reply to the workstream when the grant allows work on its repo. Other mail goes to the
  orchestrator.
- A retry of the same delivery has the same Message-ID. Mail clients show it one time.

## 7. Limits

- The adapter reads only new mail. At the first start, or when the mailbox's UIDVALIDITY changes, it
  starts at the newest mail. It does not read old mail.
- Resend sets its own Message-ID if it does not accept the one Orca gives. Then a reply does not find
  its workstream, and it goes to the orchestrator. Use SMTP if replies must reach the workstream.
- The subject of a thread follows the title of each event. Some clients (Gmail) start a new
  conversation when the subject changes. The workstream link still works, because it uses
  `References`.
- There is no `[orca:<branch>]` tag in the subject yet. Threads use only the headers.

## 8. Test it

`tests/email.test.ts` runs the adapter against a fake IMAP server, a fake SMTP server and a fake
Resend endpoint. It never connects to a real mail service.

```
bun test tests/email.test.ts
```
