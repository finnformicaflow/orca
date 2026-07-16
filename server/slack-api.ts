// Post a Slack message from YOUR identity via Slack's documented `chat.postMessage`, authed with a
// user token (`xoxp`) in SLACK_TOKEN. Dependency-free — no third-party package ever touches the token
// — and the SINGLE path Orca uses for every provider's notify/bump: no per-agent branching, no model,
// so a post is deterministic and verbatim. Kept behind this thin function per the adapter boundary.

const token = () => process.env.SLACK_TOKEN ?? "";

/** POST to chat.postMessage. Slack returns HTTP 200 with `{ok:false,error}` on logical failures; a
 *  missing token or network error surfaces the same shape. Never throws — the caller decides. Pure I/O. */
export async function postMessage(channel: string, text: string): Promise<{ ok: boolean; error?: string; channel?: string }> {
  if (!token()) return { ok: false, error: "SLACK_TOKEN is not set" };
  try {
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8", authorization: `Bearer ${token()}` },
      body: JSON.stringify({ channel, text }),
    });
    return (await res.json().catch(() => ({ ok: false, error: `http ${res.status}` }))) as { ok: boolean; error?: string; channel?: string };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
