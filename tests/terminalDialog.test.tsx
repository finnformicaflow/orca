// E2E for the board terminal dialog: the hand-driven terminal now opens in a modal on the board
// (next to Test locally) instead of navigating to the PR/local detail page, and it resumes the
// pinned agent's session — so the past chat's context is carried in. The New-draft chatbox no
// longer carries the interactive terminal toggle. Driven against the fake api (tests/apiFake.ts).
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { apiFake } from "./apiFake";
import * as store from "@/store";
import { Board, WorkstreamCard } from "@/views/Board";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The dialog mounts the real xterm terminal, which opens a WebSocket to the bridge. That transport
// is exercised server-side (tmux.test.ts); here we only care about the dialog opening + resuming the
// session, so stub WebSocket to avoid a real (unreachable) connection erroring in the test process.
const RealWebSocket = globalThis.WebSocket;
class FakeWebSocket { static OPEN = 1; readyState = 0; binaryType = ""; constructor(_url: string) {} send() {} close() {} }
beforeAll(() => { (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket; });
afterAll(() => { (globalThis as unknown as { WebSocket: unknown }).WebSocket = RealWebSocket; });

beforeAll(() => store.configReady);

const flush = () => new Promise((r) => setTimeout(r, 0));
const click = async (el: Element) => { await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); await flush(); await flush(); }); };

// A local branch that already ran Claude headlessly here: it has a worktree + a resumable session,
// so opening the terminal resumes THAT session (carrying the past conversation) rather than a blank one.
const row: store.Row = {
  repo: "r", hasRemote: false, branch: "feat", title: "Feat", prompt: "do a thing", lane: "LOCAL",
  worktreePath: "/wt/feat", agentProvider: "claude", sessionId: "claude-abc",
};

let root: Root | undefined;
let container: HTMLElement | undefined;
async function mount(node: React.ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => { root = createRoot(container!); root.render(node); await flush(); });
}

afterEach(async () => {
  apiFake.reset();
  await act(async () => { await store.refresh(); });
  act(() => root?.unmount());
  container?.remove();
  root = container = undefined;
});

describe("board terminal dialog", () => {
  test("the terminal button beside Test locally opens a modal that resumes the agent's session", async () => {
    await mount(<WorkstreamCard row={row} />);
    const dialog = container!.querySelector("dialog")!;
    expect(dialog.open).toBe(false); // closed until opened — xterm/ws aren't mounted yet

    const button = [...container!.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.getAttribute("aria-label") === "Open terminal")!;
    expect(button).toBeTruthy();
    await click(button);

    expect(dialog.open).toBe(true);
    // Resumed the recorded Claude session — so the terminal opens with the past chat's context, not blank.
    expect(apiFake.terminalEnsures).toHaveLength(1);
    expect(apiFake.terminalEnsures[0]).toMatchObject({ branch: "feat", provider: "claude", sessionId: "claude-abc", fresh: false });
  });

  test("the New-draft chatbox no longer carries the interactive terminal toggle", async () => {
    await mount(<Board />);
    const toggle = [...document.body.querySelectorAll("button")].find((b) => /Headless|drive it by hand/.test(b.getAttribute("title") ?? ""));
    expect(toggle).toBeUndefined();
  });
});
