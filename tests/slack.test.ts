// Slack notify/bump post the message VERBATIM from your identity via Slack's chat.postMessage
// (server/slack-api.ts) — one path for every provider, no model, no MCP. These pin that the POST
// carries the exact channel + text and surfaces Slack's errors instead of throwing.
import { test, expect } from "bun:test";
import { postMessage } from "../server/slack-api";

const withStubbedFetch = async (
  impl: (url: string, init: any) => Response,
  body: () => Promise<unknown>,
) => {
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => impl(String(url), init)) as typeof fetch;
  try { return await body(); } finally { globalThis.fetch = orig; }
};

test("postMessage sends the channel and text VERBATIM to chat.postMessage as the user", async () => {
  process.env.SLACK_TOKEN = "xoxp-test";
  let seen: { url: string; body: any; auth: string } | undefined;
  try {
    const r = await withStubbedFetch((url, init) => {
      seen = { url, body: JSON.parse(init.body), auth: init.headers.authorization };
      return new Response(JSON.stringify({ ok: true, channel: "C123" }), { status: 200 });
    }, () => postMessage("#eng", "<https://gh/pr/7|#7 Add X>")) as Awaited<ReturnType<typeof postMessage>>;
    expect(r.ok).toBe(true);
    expect(seen!.url).toBe("https://slack.com/api/chat.postMessage");
    expect(seen!.body.channel).toBe("#eng");
    expect(seen!.body.text).toBe("<https://gh/pr/7|#7 Add X>"); // verbatim — no model rewording
    expect(seen!.auth).toBe("Bearer xoxp-test"); // posts as YOU, not a bot
  } finally { delete process.env.SLACK_TOKEN; }
});

test("postMessage surfaces Slack's error instead of throwing", async () => {
  process.env.SLACK_TOKEN = "xoxp-test";
  try {
    const r = await withStubbedFetch(
      () => new Response(JSON.stringify({ ok: false, error: "channel_not_found" }), { status: 200 }),
      () => postMessage("#nope", "hi"),
    ) as Awaited<ReturnType<typeof postMessage>>;
    expect(r).toEqual({ ok: false, error: "channel_not_found" });
  } finally { delete process.env.SLACK_TOKEN; }
});

test("postMessage refuses without a token (no request made)", async () => {
  delete process.env.SLACK_TOKEN;
  let called = false;
  const r = await withStubbedFetch(
    () => { called = true; return new Response("{}"); },
    () => postMessage("#eng", "hi"),
  ) as Awaited<ReturnType<typeof postMessage>>;
  expect(r.ok).toBe(false);
  expect(r.error).toContain("SLACK_TOKEN");
  expect(called).toBe(false);
});
