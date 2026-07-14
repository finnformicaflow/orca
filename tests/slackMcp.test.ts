// Orca's minimal Slack MCP server: verify the JSON-RPC handlers (initialize/tools/list/tools/call)
// and that a post maps Slack's ok/error into an MCP result. `fetch` is stubbed (platform API, not our
// code) so no real Slack call happens.
import { test, expect, afterEach } from "bun:test";
import { handleMessage, TOOL } from "../server/slack-mcp";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; delete process.env.SLACK_MCP_TOKEN; });

test("initialize advertises the tools capability", async () => {
  const r = await handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize" }) as any;
  expect(r.result.capabilities.tools).toBeDefined();
  expect(r.result.serverInfo.name).toBe("orca-slack");
});

test("tools/list exposes the single post tool", async () => {
  const r = await handleMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" }) as any;
  expect(r.result.tools).toEqual([TOOL]);
  expect(TOOL.name).toBe("slack_post_message");
});

test("tools/call posts via chat.postMessage and reports success", async () => {
  process.env.SLACK_MCP_TOKEN = "xoxp-test";
  let call: { url: unknown; body: string } | undefined;
  globalThis.fetch = (async (url: unknown, init: RequestInit) => { call = { url, body: init.body as string }; return new Response(JSON.stringify({ ok: true, channel: "C123" })); }) as unknown as typeof fetch;
  const r = await handleMessage({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "slack_post_message", arguments: { channel: "#eng", text: "<u|#7 X>" } } }) as any;
  expect(call!.url).toBe("https://slack.com/api/chat.postMessage");
  expect(JSON.parse(call!.body)).toEqual({ channel: "#eng", text: "<u|#7 X>" });
  expect(r.result.isError).toBe(false);
  expect(r.result.content[0].text).toContain("Posted");
});

test("tools/call surfaces a Slack error and marks isError", async () => {
  process.env.SLACK_MCP_TOKEN = "xoxp-test";
  globalThis.fetch = (async () => new Response(JSON.stringify({ ok: false, error: "channel_not_found" }))) as unknown as typeof fetch;
  const r = await handleMessage({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "slack_post_message", arguments: { channel: "#nope", text: "hi" } } }) as any;
  expect(r.result.isError).toBe(true);
  expect(r.result.content[0].text).toContain("channel_not_found");
});

test("tools/call without a token doesn't call Slack", async () => {
  let called = false;
  globalThis.fetch = (async () => { called = true; return new Response("{}"); }) as unknown as typeof fetch;
  const r = await handleMessage({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "slack_post_message", arguments: { channel: "#eng", text: "hi" } } }) as any;
  expect(called).toBe(false);
  expect(r.result.isError).toBe(true);
});

test("a notification (no id) gets no reply", async () => {
  expect(await handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
});
