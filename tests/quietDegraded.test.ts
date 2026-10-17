// Quiet degraded mode: with the database unreachable, the bridge says so ONCE, skips its background
// duties without a line per tick, decides primary/secondary once, and when the database is back says
// so ONCE (with how long it was down), takes the lock and runs the skipped run-once duty (the boot
// reconcile's `primary.whenUp`) exactly once — no restart. Before: the lock's own client reconnected
// before db.ts's probe did, so the bridge became primary, its boot reconcile hit `DbUnavailable`
// ("primary duty failed" with a stack, and never ran again), and the heartbeat and metrics sample
// logged a failure every tick.
//
// The bridge's wiring runs in a child process (tests/fixtures/quietDb.ts: primary.ts holds one
// election per process). Its database URL is a loopback port that is closed, then a TCP forwarder to
// the test Postgres opens on it: "the database is back" without changing the URL.
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshSchema, type TestDb } from "./pg";
import { downFor } from "../server/db";

const ROOT = join(import.meta.dir, "..");

function freePort(): number {
  const s = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = s.port;
  s.stop(true);
  return port;
}

type Side = { peer?: Bun.Socket<Side>; early: Uint8Array[] };
/** A plain TCP forwarder on `port` → `target` (small Postgres messages, so no back-pressure handling). */
function forwarder(port: number, target: { hostname: string; port: number }) {
  return Bun.listen<Side>({
    hostname: "127.0.0.1", port,
    socket: {
      open(client) {
        client.data = { early: [] };
        void Bun.connect<Side>({
          ...target,
          socket: {
            open(up) {
              up.data = { peer: client, early: [] };
              client.data.peer = up;
              for (const b of client.data.early) up.write(b);
            },
            data(up, d) { up.data.peer?.write(d); },
            close(up) { up.data.peer?.end(); },
            error(up) { up.data.peer?.end(); },
          },
        }).catch(() => client.end());
      },
      data(client, d) {
        if (client.data.peer) client.data.peer.write(d);
        else client.data.early.push(new Uint8Array(d));
      },
      close(client) { client.data.peer?.end(); },
      error(client) { client.data.peer?.end(); },
    },
  });
}

let pg: TestDb | undefined;
let state: string | undefined;
afterEach(async () => {
  await pg?.drop();
  if (state) await rm(state, { recursive: true, force: true });
  pg = state = undefined;
});

test("downFor reads an outage's length for the recovery line", () => {
  expect(downFor(4_200)).toBe("4s");
  expect(downFor(192_000)).toBe("3m 12s");
  expect(downFor(7_500_000)).toBe("2h 5m");
});

test("Q1 database down: one line, duties skip quietly, no lock flapping; back: one line, the duty runs once", async () => {
  pg = await freshSchema("quiet");
  state = await mkdtemp(join(tmpdir(), "orca-quiet-"));
  const port = freePort();
  const url = new URL(pg.url);
  const via = new URL(pg.url);
  via.hostname = "127.0.0.1";
  via.port = String(port);
  const proc = Bun.spawn(["bun", "--env-file=/dev/null", "tests/fixtures/quietDb.ts"], {
    cwd: ROOT, stdout: "pipe", stderr: "pipe",
    env: {
      PATH: process.env.PATH!, HOME: process.env.HOME!, NODE_ENV: "test", TMPDIR: process.env.TMPDIR!,
      ORCA_DATABASE_URL: via.toString(), ORCA_STATE_DIR: state, ORCA_PRIMARY: "1",
      ORCA_INSTANCE: `quiet-${process.pid}`, ORCA_PRIMARY_RETRY_MS: "50", ORCA_DB_RETRY_MAX_MS: "200",
      ORCA_DB_CONNECT_TIMEOUT_S: "1",
    },
  });
  let out = "";
  const read = async (s: ReadableStream<Uint8Array>) => {
    const r = s.getReader();
    for (let c = await r.read(); !c.done; c = await r.read()) out += new TextDecoder().decode(c.value);
  };
  void read(proc.stdout);
  void read(proc.stderr);
  const until = async (ok: () => boolean, ms = 15_000) => {
    for (const end = Date.now() + ms; !ok() && Date.now() < end;) await Bun.sleep(25);
    expect(ok()).toBe(true);
  };
  let fwd: ReturnType<typeof forwarder> | undefined;
  try {
    // Down: let many ticks pass (the sampler ticks every 50ms, the lock retries every 50ms).
    await until(() => out.includes("database unreachable ("));
    await Bun.sleep(1_500);
    const down = out;
    expect(down.match(/database unreachable \(/g)).toHaveLength(1);
    expect(down).not.toMatch(/failed|DbUnavailable|\n\s+at /); // no per-tick line, no stack
    expect(down).not.toContain("DUTY ran"); // skipped while down
    expect(down).toContain("STATE held=false");
    expect(down).not.toContain("STATE held=true");
    expect(down.match(/secondary bridge/g)).toHaveLength(1); // decided once, logged once
    expect(down).toContain("secondary bridge (database unreachable)");
    expect(down).not.toContain("primary for instance");

    // Back: one recovery line with the down time, the lock taken once, the duty run once.
    fwd = forwarder(port, { hostname: url.hostname === "localhost" ? "127.0.0.1" : url.hostname, port: Number(url.port || 5432) });
    await until(() => out.includes("DUTY ran"), 20_000);
    await Bun.sleep(800);
    expect(out.match(/database reachable again \(down since \S+, for \d+s\)/g)).toHaveLength(1);
    expect(out.match(/DUTY ran/g)).toHaveLength(1);
    expect(out.match(/primary for instance/g)).toHaveLength(1);
    expect(out.match(/secondary bridge/g)).toHaveLength(1);
    expect(out.indexOf("database reachable again")).toBeLessThan(out.indexOf("DUTY ran"));
    expect(out).not.toMatch(/failed|\n\s+at /);
    expect(out.slice(-200)).toContain("STATE held=true");
  } finally {
    proc.kill();
    await proc.exited;
    fwd?.stop(true);
  }
}, 40_000);

// 2026-10-17: `bun run dev` on the laptop while the tailnet moved. The database went away UNDER a
// primary bridge with queries in flight: each duty logged "… failed" with a Bun Postgres stack, the
// pool logged "[db] connection dropped" again and again, and the bridge still said it was primary.
test("Q2 connections cut under a primary bridge's duties: one down line, no per-duty line; back: one up line, the duties run again", async () => {
  pg = await freshSchema("quietcut");
  state = await mkdtemp(join(tmpdir(), "orca-quietcut-"));
  const port = freePort();
  const url = new URL(pg.url);
  const via = new URL(pg.url);
  via.hostname = "127.0.0.1";
  via.port = String(port);
  const target = { hostname: url.hostname === "localhost" ? "127.0.0.1" : url.hostname, port: Number(url.port || 5432) };
  let fwd: ReturnType<typeof forwarder> | undefined = forwarder(port, target);
  const proc = Bun.spawn(["bun", "--env-file=/dev/null", "tests/fixtures/quietDb.ts"], {
    cwd: ROOT, stdout: "pipe", stderr: "pipe",
    env: {
      PATH: process.env.PATH!, HOME: process.env.HOME!, NODE_ENV: "test", TMPDIR: process.env.TMPDIR!,
      ORCA_DATABASE_URL: via.toString(), ORCA_STATE_DIR: state, ORCA_PRIMARY: "1", QUIET_DUTIES: "1",
      ORCA_INSTANCE: `quietcut-${process.pid}`, ORCA_PRIMARY_RETRY_MS: "50", ORCA_DB_RETRY_MAX_MS: "200",
      ORCA_DB_CONNECT_TIMEOUT_S: "1",
    },
  });
  let out = "";
  const read = async (s: ReadableStream<Uint8Array>) => {
    const r = s.getReader();
    for (let c = await r.read(); !c.done; c = await r.read()) out += new TextDecoder().decode(c.value);
  };
  void read(proc.stdout);
  void read(proc.stderr);
  const until = async (ok: () => boolean, ms = 15_000) => {
    for (const end = Date.now() + ms; !ok() && Date.now() < end;) await Bun.sleep(25);
    expect(ok()).toBe(true);
  };
  const noDutyLines = (text: string) => {
    expect(text).not.toMatch(/ failed|PostgresError|\n\s+at |\n\s*\d+ \| /); // no per-duty line, no stack, no source frame
  };
  try {
    // Up and primary, every duty ticking.
    await until(() => out.includes("primary for instance") && out.includes("TICK upkeep pass") && out.includes("TICK preview publish"));
    // The tailnet moves: every live connection is cut mid-query, and the port refuses new ones.
    fwd.stop(true);
    fwd = undefined;
    const cutAt = out.length;
    await until(() => out.includes("database unreachable ("));
    await Bun.sleep(1_500);
    const down = out.slice(cutAt);
    expect(down.match(/database unreachable \(/g)).toHaveLength(1);
    expect((down.match(/\[db\] connection dropped/g) ?? []).length).toBeLessThanOrEqual(1);
    noDutyLines(out);
    expect(down).toContain("secondary bridge (database unreachable)"); // no longer claims "primary … running background duties"
    expect(down.slice(-300)).toContain("STATE held=false");
    expect(down.slice(-300)).not.toContain("TICK"); // the duties skip their work while it is down

    // Back: one up line, the lock taken again, the duties tick again.
    fwd = forwarder(port, target);
    const backAt = out.length;
    await until(() => out.slice(backAt).includes("TICK upkeep pass"), 20_000);
    await Bun.sleep(500);
    const back = out.slice(backAt);
    expect(out.match(/database reachable again \(down since \S+, for \d+s\)/g)).toHaveLength(1);
    expect(out.match(/database unreachable \(/g)).toHaveLength(1);
    expect(back).toContain("primary for instance");
    expect(back).toContain("TICK merge queue pass");
    noDutyLines(out);
  } finally {
    proc.kill();
    await proc.exited;
    fwd?.stop(true);
  }
}, 40_000);
