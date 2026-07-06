// Launch the bridge + Vite dev server together. Vite proxies /api to the bridge.
const opts = { stdout: "inherit", stderr: "inherit", env: process.env } as const;
const children = [
  Bun.spawn(["bun", "run", "server/index.ts"], opts),
  Bun.spawn(["bunx", "--bun", "vite"], { cwd: "web", ...opts }),
];

// Reap children on exit — otherwise every restart orphans the bridge + Vite (killing this launcher
// doesn't cascade), they pile up over days and squat ports (8788→8789, 5173→5176…). We also pkill
// the Vite by path because `bunx` spawns node as a grandchild that a plain kill() would miss.
const shutdown = () => {
  for (const c of children) { try { c.kill(); } catch { /* already gone */ } }
  try { Bun.spawnSync(["pkill", "-f", "orca/node_modules/.bin/vite"]); } catch { /* none running */ }
  process.exit(0);
};
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, shutdown);

await new Promise(() => {}); // keep the launcher alive
export {};
