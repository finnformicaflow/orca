// The follow-up composer's text is mirrored into the durable enrichment blob (small, image-free)
// so it survives even when the composerDraft entry — which base64-inlines attachments — blows the
// ~5MB localStorage quota and loses everything. This is the "store it like enrichment" guarantee:
// setFollowDraft round-trips under the same repo::branch key as the original prompt, merging (not
// clobbering) and clearing on empty. Driven against the real store (apiFake preload).
import { beforeEach, expect, test } from "bun:test";
import * as store from "@/store";

const KEY = "orca.enrichment";

beforeEach(() => localStorage.clear());

test("setFollowDraft persists follow-up text in enrichment, merging with the prompt and clearing on empty", () => {
  // an existing entry (the original prompt) must survive — we merge, never clobber
  localStorage.setItem(KEY, JSON.stringify({ "branch-demo::feat": { prompt: "original task" } }));

  store.setFollowDraft("branch-demo", "feat", "a large follow-up prompt I don't want to lose");
  let blob = JSON.parse(localStorage.getItem(KEY)!);
  expect(blob["branch-demo::feat"].followDraft).toBe("a large follow-up prompt I don't want to lose");
  expect(blob["branch-demo::feat"].prompt).toBe("original task"); // untouched

  // empty / whitespace clears just the draft, leaving the rest intact
  store.setFollowDraft("branch-demo", "feat", "   ");
  blob = JSON.parse(localStorage.getItem(KEY)!);
  expect(blob["branch-demo::feat"].followDraft).toBeUndefined();
  expect(blob["branch-demo::feat"].prompt).toBe("original task");
});

test("setFollowDraft keys by repo::branch so drafts don't leak across worktrees", () => {
  store.setFollowDraft("branch-demo", "feat-a", "draft A");
  store.setFollowDraft("orca", "feat-b", "draft B");
  const blob = JSON.parse(localStorage.getItem(KEY)!);
  expect(blob["branch-demo::feat-a"].followDraft).toBe("draft A");
  expect(blob["orca::feat-b"].followDraft).toBe("draft B");
});
