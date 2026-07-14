// A minimal stdio MCP server exposing ONE tool: post a Slack message as the authenticated user via
// Slack's documented `chat.postMessage`, authed with a user token (`xoxp`) from SLACK_MCP_TOKEN. It
// exists so Orca's agent-send works on every provider (Cursor/Codex don't have a usable hosted Slack
// MCP): it's wired into ~/.cursor/mcp.json and ~/.codex/config.toml. Deliberately dependency-free —
// no third-party package ever touches the token — and Bun-native (`bun server/slack-mcp.ts`), so it
// doesn't need a node/asdf version set. A user token posts AS YOU (no bot/app label).
//
// Speaks newline-delimited JSON-RPC 2.0 (the MCP stdio transport): initialize / tools/list / tools/call.

const token = () => process.env.SLACK_MCP_TOKEN ?? "";

export const TOOL = {
  name: "slack_post_message",
  description: "Post a message to a Slack channel as the authenticated user (you).",
  inputSchema: {
    type: "object",
    properties: {
      channel: { type: "string", description: "Channel name (e.g. #v3-engineering) or ID." },
      text: { type: "string", description: "Message text in Slack mrkdwn." },
    },
    required: ["channel", "text"],
  },
} as const;

/** POST to Slack's Web API. Slack returns 200 with `{ok:false,error}` on logical failures. Pure I/O. */
export async function postMessage(channel: string, text: string): Promise<{ ok: boolean; error?: string; channel?: string }> {
  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8", authorization: `Bearer ${token()}` },
    body: JSON.stringify({ channel, text }),
  });
  return (await res.json().catch(() => ({ ok: false, error: `http ${res.status}` }))) as { ok: boolean; error?: string; channel?: string };
}

type Rpc = { jsonrpc: "2.0"; id?: unknown; method?: string; params?: any };

/** Handle one JSON-RPC message; returns the response object, or null for notifications (no reply). */
export async function handleMessage(msg: Rpc): Promise<object | null> {
  const { id, method, params } = msg;
  const ok = (result: unknown) => ({ jsonrpc: "2.0" as const, id, result });
  const err = (code: number, message: string) => ({ jsonrpc: "2.0" as const, id, error: { code, message } });
  switch (method) {
    case "initialize":
      return ok({ protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "orca-slack", version: "1.0.0" } });
    case "tools/list":
      return ok({ tools: [TOOL] });
    case "tools/call": {
      if (params?.name !== TOOL.name) return err(-32602, `unknown tool: ${params?.name}`);
      if (!token()) return ok({ content: [{ type: "text", text: "SLACK_MCP_TOKEN is not set" }], isError: true });
      const r = await postMessage(String(params?.arguments?.channel ?? ""), String(params?.arguments?.text ?? ""));
      return ok({ content: [{ type: "text", text: r.ok ? `Posted to ${r.channel ?? "channel"}` : `Slack error: ${r.error}` }], isError: !r.ok });
    }
    default:
      return typeof id === "undefined" ? null : err(-32601, `unknown method: ${method}`);
  }
}

// Run the stdio loop only when executed directly (tests import the handlers instead).
if (import.meta.main) {
  const reader = Bun.stdin.stream().getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        const response = await handleMessage(JSON.parse(line));
        if (response) process.stdout.write(JSON.stringify(response) + "\n");
      } catch { /* ignore a malformed line */ }
    }
  }
}
