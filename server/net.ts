// Bridge-port helpers. Split out from index.ts/preview.ts so the port-reclaim logic is testable
// without booting the server.
import { createServer } from "node:net";

/** True if nothing is currently bound to `port`, checked against the OS (so an orphaned server from
 *  a prior run counts as taken — an in-memory map can't know about it after a restart). */
export function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    // listen() throws synchronously for out-of-range ports (>65535) — treat as "not free", re-roll.
    try { srv.listen(port, "0.0.0.0"); } catch { resolve(false); }
  });
}

/**
 * Reclaim the API port from a STALE Orca bridge squatting it — a prior `bun run dev` whose bridge
 * outlived its launcher, or another checkout's instance (the exact case that made "Test master" 404:
 * a bridge from the main checkout held :8787, so a feature branch's fresh bridge lost the bind and
 * its Vite proxied `/api` to the old, routeless code). Two bridges can't share the port and Orca is
 * a single-user local tool with no durable state, so newest-wins is the safe default.
 *
 * Deliberately narrow: only kills a listener whose argv looks like an Orca bridge (`server/index.ts`)
 * — never an unrelated service that happens to hold the port. Returns true if it killed something.
 */
export function reclaimBridgePort(port: number): boolean {
  try {
    const pid = Bun.spawnSync(["lsof", "-ti", `tcp:${port}`, "-sTCP:LISTEN"]).stdout.toString().trim().split("\n").filter(Boolean)[0];
    if (!pid) return false;
    const cmd = Bun.spawnSync(["ps", "-o", "command=", "-p", pid]).stdout.toString();
    if (!/server\/index\.ts/.test(cmd)) return false; // not an Orca bridge — leave it alone
    process.kill(Number(pid));
    return true;
  } catch {
    return false; // lsof/ps missing, or the pid already gone
  }
}

/** Wait (up to ~`timeoutMs`) for `port` to free up — a killed bridge takes a beat to run its
 *  shutdown handler and release the socket. */
export async function waitForPortFree(port: number, timeoutMs = 3000): Promise<boolean> {
  for (let waited = 0; waited < timeoutMs; waited += 100) {
    if (await portFree(port)) return true;
    await Bun.sleep(100);
  }
  return portFree(port);
}
