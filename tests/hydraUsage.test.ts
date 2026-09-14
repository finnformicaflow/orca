// The usage meter's Claude numbers come from claude-hydra (`hydra status --json`) when it is
// installed: every login, three windows each (5-hour, weekly, Fable), plus hydra's verdict on the
// login's state. Without hydra the single default login's endpoint reading still works. Driven
// through the real module with a fake `hydra` on PATH (the same PATH-shim pattern as `gh`).
import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hydraUsage, shapeHydraStatus, usage } from "../server/usage";

const STATUS = {
  threshold: 90, now: 1789378422,
  profiles: [
    { name: "formicsoftware", dir: "/u/.claude", email: "me@x", signed_in: true, disabled: false, fetched_at: 1789378422, source: "api", auth: "ok", locked: false,
      session: { pct: 12, resets: 1789389600, severity: "normal" }, weekly: { pct: 12, resets: 1789776000, severity: "normal" }, fable: { pct: 21, resets: 1789776000, severity: "normal" }, state: "ok" },
    { name: "work", dir: "/u/.hydra/profiles/work", email: "me@work", signed_in: true, disabled: false, fetched_at: 1789378422, source: "api", auth: "ok", locked: false,
      session: { pct: 95, resets: 1789389600, severity: "warning" }, weekly: { pct: 40, resets: null, severity: "normal" }, fable: null, state: "exhausted" },
    { name: "spare", dir: "/u/.hydra/profiles/spare", email: "", signed_in: false, disabled: true, fetched_at: 0, source: null, auth: "unknown", locked: false,
      session: null, weekly: null, fable: null, state: "not signed in on this machine" },
  ],
};

let shim: string | undefined;
let prevPath: string | undefined;
afterEach(async () => {
  if (prevPath !== undefined) process.env.PATH = prevPath;
  prevPath = undefined;
  if (shim) await rm(shim, { recursive: true, force: true });
  shim = undefined;
});

/** A fake `hydra` first on PATH: `status --json` prints the canned document, `bin` a fixed path. */
async function installFakeHydra(doc: unknown): Promise<void> {
  shim = await mkdtemp(join(tmpdir(), "orca-hydra-"));
  await writeFile(join(shim, "status.json"), JSON.stringify(doc));
  await writeFile(join(shim, "hydra"), `#!/bin/sh\ncase "$1 $2" in\n  "status --json") cat "${shim}/status.json" ;;\n  "bin ") echo /fake/claude-real ;;\n  *) echo "fake-hydra: $*" >&2; exit 1 ;;\nesac\n`);
  await chmod(join(shim, "hydra"), 0o755);
  prevPath = process.env.PATH;
  process.env.PATH = `${shim}:${prevPath}`;
}

test("shapeHydraStatus: three windows per login, epoch-second resets → ISO, null buckets kept null, state carried", () => {
  const [personal, work, spare] = shapeHydraStatus(STATUS);
  const iso = (s: number) => new Date(s * 1000).toISOString(); // hydra reports epoch SECONDS
  expect(personal).toEqual({
    name: "formicsoftware", email: "me@x", state: "ok",
    usage: {
      fiveHour: { utilization: 12, resetsAt: iso(1789389600) },
      sevenDay: { utilization: 12, resetsAt: iso(1789776000) },
      fable: { utilization: 21, resetsAt: iso(1789776000) },
      extra: null,
    },
  });
  expect(work?.usage?.fable).toBeNull();                 // no Fable window on that account
  expect(work?.usage?.sevenDay.resetsAt).toBeNull();     // null resets → null
  expect(work?.state).toBe("exhausted");
  expect(spare?.usage).toBeNull();                       // no session reading → no bars…
  expect(spare?.state).toBe("not signed in on this machine"); // …but the reason is kept
  expect(spare?.email).toBeUndefined();
  expect(shapeHydraStatus(null)).toEqual([]);
  expect(shapeHydraStatus({ profiles: [{ nope: 1 }] })).toEqual([]);
});

test("with hydra on PATH, usage() reports every login from `hydra status --json`", async () => {
  await installFakeHydra(STATUS);
  const profiles = await hydraUsage();
  expect(profiles?.map((p) => p.name)).toEqual(["formicsoftware", "work", "spare"]);

  const u = await usage();
  expect(u?.profiles?.map((p) => `${p.name}:${p.state}`)).toEqual(["formicsoftware:ok", "work:exhausted", "spare:not signed in on this machine"]);
  expect(u?.claude?.fiveHour.utilization).toBe(12); // back-compat: the first login's reading
  expect(u?.claude?.fable?.utilization).toBe(21);   // the window the bare endpoint never exposed
});

test("without hydra on PATH there are no profiles and the single-login path is used", async () => {
  // A PATH with no hydra (and no codex/claude either), so nothing external answers.
  const empty = await mkdtemp(join(tmpdir(), "orca-nopath-"));
  prevPath = process.env.PATH;
  process.env.PATH = empty;
  try {
    expect(await hydraUsage()).toBeNull();
    const u = await usage();
    // Either nothing at all (null) or a reading with NO profiles — never a hydra-shaped payload.
    expect(u?.profiles).toBeUndefined();
  } finally {
    await rm(empty, { recursive: true, force: true });
  }
});
