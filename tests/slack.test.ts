// Slack auto-send now runs the card's pinned agent headless to post via its own Slack tool (from your
// identity), using a lightweight model. These pin the per-provider argv and the post instruction; the
// live post depends on each provider's Slack integration, so it's exercised manually (see QA.md).
import { test, expect } from "bun:test";
import { slackPostCommand } from "../server/agent";
import { slackPostPrompt } from "../web/src/workstream";

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
