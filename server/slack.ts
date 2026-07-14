// Slack adapter: post a message to an incoming-webhook URL. No bot token, no OAuth app — the webhook
// is a secret URL that posts to its own pre-configured channel, and no model is involved, so an
// auto-send costs zero LLM tokens. Kept behind this thin function per the adapter boundary.

/** POST `{ text }` to a Slack incoming webhook (mrkdwn is rendered by default). Throws on a non-2xx. */
export async function postToWebhook(webhookUrl: string, text: string): Promise<void> {
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`Slack webhook failed: ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
}
