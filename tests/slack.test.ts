// Slack auto-send goes through an incoming webhook — no agent, no OAuth, zero LLM cost. Verify the
// adapter forms the exact request and surfaces failures so the caller falls back to copy. `fetch` is
// stubbed (a platform API, not our code) because the suite preloads happy-dom, whose window `fetch`
// enforces CORS and can't reach a local server; production uses Bun's native fetch.
import { test, expect, afterEach } from "bun:test";
import { postToWebhook } from "../server/slack";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

test("postToWebhook POSTs the message as JSON to the webhook URL", async () => {
  let call: { url: unknown; init: RequestInit } | undefined;
  globalThis.fetch = (async (url: unknown, init: RequestInit) => { call = { url, init }; return new Response("ok"); }) as unknown as typeof fetch;
  await postToWebhook("https://hooks.slack.test/abc", "<https://gh/pr/7|#7 Add X>");
  expect(call!.url).toBe("https://hooks.slack.test/abc");
  expect(call!.init.method).toBe("POST");
  expect((call!.init.headers as Record<string, string>)["content-type"]).toBe("application/json");
  expect(JSON.parse(call!.init.body as string)).toEqual({ text: "<https://gh/pr/7|#7 Add X>" });
});

test("postToWebhook throws on a non-2xx response so the caller can fall back to copy", async () => {
  globalThis.fetch = (async () => new Response("no_service", { status: 404 })) as unknown as typeof fetch;
  await expect(postToWebhook("https://hooks.slack.test/abc", "hi")).rejects.toThrow(/404/);
});
