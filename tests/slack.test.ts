// Slack auto-send now runs the card's pinned agent headless to post via its own Slack tool (from your
// identity), using a lightweight model. These pin the per-provider argv and the post instruction; the
// live post depends on each provider's Slack integration, so it's exercised manually (see QA.md).
import { test, expect } from "bun:test";
import { slackPostCommand } from "../server/agent";
import { postMessage } from "../server/slack-mcp";
import { slackPostPrompt } from "../web/src/workstream";

test("postMessage sends the channel and text VERBATIM to chat.postMessage as the user", async () => {
  const orig = globalThis.fetch;
  let seen: { url: string; body: any; auth: string } | undefined;
  process.env.SLACK_MCP_TOKEN = "xoxp-test";
  globalThis.fetch = (async (url: any, init: any) => {
    seen = { url: String(url), body: JSON.parse(init.body), auth: init.headers.authorization };
    return new Response(JSON.stringify({ ok: true, channel: "C123" }), { status: 200 });
  }) as typeof fetch;
  try {
    const r = await postMessage("#eng", "<https://gh/pr/7|#7 Add X>");
    expect(r.ok).toBe(true);
    expect(seen!.url).toBe("https://slack.com/api/chat.postMessage");
    expect(seen!.body.channel).toBe("#eng");
    expect(seen!.body.text).toBe("<https://gh/pr/7|#7 Add X>"); // verbatim — no model rewording
    expect(seen!.auth).toBe("Bearer xoxp-test"); // posts as YOU, not a bot
  } finally {
    globalThis.fetch = orig;
    delete process.env.SLACK_MCP_TOKEN;
  }
});

test("slackPostCommand runs each provider with tools enabled and a cheap model where available", () => {
  expect(slackPostCommand("claude", "/repo", "post it")).toEqual([
    "claude", "-p", "post it", "--model", "haiku", "--permission-mode", "bypassPermissions", "--output-format", "json",
  ]);
  expect(slackPostCommand("codex", "/repo", "post it")).toEqual([
    "codex", "exec", "--json", "--dangerously-bypass-approvals-and-sandbox", "-C", "/repo", "post it",
  ]);
  expect(slackPostCommand("cursor", "/repo", "post it")).toEqual([
    "cursor-agent", "-p", "post it", "--force", "--approve-mcps", "--output-format", "json",
  ]);
  // NOT the read-only one-shot form: the agent must be able to actually call its Slack tool.
  expect(slackPostCommand("claude", "/repo", "x")).not.toContain("--tools");
});

test("slackPostPrompt tells the agent to post the exact content to the channel", () => {
  const p = slackPostPrompt("#eng", "<https://gh/pr/7|#7 Add X>");
  expect(p).toContain("#eng");
  expect(p).toContain("<https://gh/pr/7|#7 Add X>");
  expect(p).toContain("exactly this content");
  expect(slackPostPrompt(undefined, "hi")).not.toContain("channel"); // no channel → don't name one
});
