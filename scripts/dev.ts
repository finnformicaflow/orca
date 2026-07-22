// Launch the bridge + Vite dev server together. Vite proxies /api to the bridge.
const opts = { stdout: "inherit", stderr: "inherit", env: process.env } as const;
const children = [
  // --watch so editing server code (adapters, routes) restarts the bridge — otherwise Vite
  // hot-reloads the UI but the API keeps serving stale logic until a manual restart.
  Bun.spawn(["bun", "--watch", "run", "server/index.ts"], opts),
  Bun.spawn(["bunx", "--bun", "vite"], { cwd: "web", ...opts }),
];

// Reap children on exit — otherwise every restart orphans the bridge + Vite (killing this launcher
// doesn't cascade), they pile up over days and squat ports (8788→8789, 5173→5176…). We also pkill
// the Vite by path because `bunx` spawns node as a grandchild that a plain kill() would miss.
let shuttingDown = false;
const shutdown = (code = 0) => {
  if (shuttingDown) return; // a signal and a child-exit can race; only tear down once
  shuttingDown = true;
  for (const c of children) { try { c.kill(); } catch { /* already gone */ } }
  try { Bun.spawnSync(["pkill", "-f", "orca/node_modules/.bin/vite"]); } catch { /* none running */ }
  process.exit(code);
};
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, shutdown);

// If EITHER child exits — a crash, an external kill, or a port reclaim by another checkout's bridge —
// tear the whole launcher down and exit, instead of `await new Promise(() => {})`-ing forever as an
// orphan that spins on a dead event loop (the 14-day zombie that burned CPU with no children left).
// `bun --watch` restarts the server in-process on file edits, so this fires only when the watcher
// PROCESS itself dies, not on a normal hot-restart. `bun run dev` then simply ends; restart it.
await Promise.race(children.map((c) => c.exited));
console.error("orca dev: a child (bridge or vite) exited — shutting down. Re-run `bun run dev`.");
shutdown(1);

export {};
