// Interactive-terminal adapter, exercised against the REAL `tmux` binary (no mocks of our own code).
// Skips cleanly when tmux isn't installed on the host — CI/dev machines without it still go green.
import { afterAll, expect, test } from "bun:test";
import { tmpdir } from "os";
import * as tmux from "../server/tmux";
import { snapshotFrame } from "../server/terminal";
import { isOrcaSession, sessionName } from "../shared/tmux";

// The initial screen a browser terminal gets: capture-pane's bare \n must become \r\n so xterm draws
// each line at column 0 instead of staircasing off-screen (which read as a blank terminal). Idempotent
// on already-correct \r\n so nothing gets doubled.
test("snapshotFrame turns capture-pane's bare \\n into \\r\\n without doubling existing \\r\\n", () => {
  expect(snapshotFrame("line1\nline2\nline3")).toBe("line1\r\nline2\r\nline3");
  expect(snapshotFrame("already\r\ncrlf")).toBe("already\r\ncrlf");
  expect(snapshotFrame("")).toBe("");
});

// Pure naming: namespaced under orca/ and stripped of tmux's reserved `.`/`:`/`/` characters, so an
// Orca session can never collide with (or be confused for) the user's own tmux sessions.
test("sessionName is namespaced and tmux-safe", () => {
  expect(sessionName("acme/app", "feat/x.y:z")).toBe("orca/acme-app/feat-x-y-z");
  expect(isOrcaSession(sessionName("r", "b"))).toBe(true);
  expect(isOrcaSession("my-own-session")).toBe(false);
});

const name = sessionName("orca-test-repo", "tmux-round-trip");
const t = tmux.available() ? test : test.skip;

afterAll(async () => { await tmux.killSession(name); });

t("ensureSession → sendKeys → capturePane round-trips, killSession cleans up", async () => {
  await tmux.killSession(name); // clean slate in case a prior run left it
  expect(await tmux.sessionExists(name)).toBe(false);

  // Empty command → tmux starts the default shell, which keeps the pane alive to type into.
  await tmux.ensureSession(name, tmpdir(), "");
  expect(await tmux.sessionExists(name)).toBe(true);
  expect(await tmux.listSessions()).toContain(name);

  await tmux.ensureSession(name, tmpdir(), ""); // idempotent: a second ensure is a no-op, not an error
  expect(await tmux.sessionExists(name)).toBe(true);

  // Type a command + Enter (\r), then read it back off the pane.
  const marker = "orca_tmux_marker_42";
  await tmux.sendKeys(name, `echo ${marker}\r`);
  let out = "";
  for (let i = 0; i < 30 && !out.includes(marker); i++) {
    await Bun.sleep(100);
    out = await tmux.capturePane(name);
  }
  expect(out).toContain(marker);

  await tmux.killSession(name);
  expect(await tmux.sessionExists(name)).toBe(false);
  expect(await tmux.listSessions()).not.toContain(name);
});

t("concurrent ensureSession doesn't error on the create race (both see 'absent', one would dup)", async () => {
  await tmux.killSession(name);
  // Two ensures in parallel: both pass the exists-check before either creates, so the loser hits
  // tmux's "duplicate session". ensureSession must swallow that and leave exactly one live session.
  await Promise.all([tmux.ensureSession(name, tmpdir(), ""), tmux.ensureSession(name, tmpdir(), "")]);
  expect(await tmux.sessionExists(name)).toBe(true);
  await tmux.killSession(name);
});
