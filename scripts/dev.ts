// Launch the bridge + Vite dev server together. Vite proxies /api to the bridge.
const opts = { stdout: "inherit", stderr: "inherit", env: process.env } as const;
const children = [
  // NOT --watch. It restarted the bridge on every server-file change — and once the orchestrator's
  // workers were merging to main all day, that meant a restart under every in-flight run: the
  // exit handlers died with the process, so finished runs showed as "running" forever, their
  // results came back only through session-file recovery, and a wake killed mid-turn (exit 143)
  // read as the orchestrator "leaving". Restart the bridge yourself when server code changes;
  // Vite still hot-reloads the UI.
  Bun.spawn(["bun", "run", "server/index.ts"], opts),
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
// A little send-off when you quit the dev server by hand. Pod's-eye view of an Orca shutting down.
const GOODBYES = [
  "🐋  Orca diving deep — pod's asleep. See you on the next tide.",
  "🌊  Surfacing for air. `bun run dev` when you're back.",
  "🐋  Fluke up, agents parked, previews down. Git's still the source of truth. Bye!",
  "👋  Orca out. May your CI be green and your conflicts few.",
  "🐳  Whale, that's a wrap. Catch you on the flip-fluke.",
];
const farewell = () => GOODBYES[Math.floor(Math.random() * GOODBYES.length)]!;

// A signal handler is called with the SIGNAL NAME, not a number — passing it straight to `shutdown`
// made `process.exit("SIGINT")` throw. Wrap so a Ctrl-C / SIGTERM always exits 0 (with a wave).
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { console.log(`\n${farewell()}`); shutdown(0); });

// If EITHER child exits — a crash, an external kill, or a port reclaim by another checkout's bridge —
// tear the whole launcher down and exit, instead of `await new Promise(() => {})`-ing forever as an
// orphan that spins on a dead event loop (the 14-day zombie that burned CPU with no children left).
// `bun run dev` then simply ends; restart it.
await Promise.race(children.map((c) => c.exited));
// A Ctrl-C also kills the children, so guard: don't print the scary line (or exit non-zero) when a
// signal already began the teardown — only a genuine unexpected child exit reaches this.
if (!shuttingDown) {
  console.error("orca dev: a child (bridge or vite) exited — shutting down. Re-run `bun run dev`.");
  shutdown(1);
}

export {};
