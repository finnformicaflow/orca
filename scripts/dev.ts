// Launch the bridge + Vite dev server together. Vite proxies /api to the bridge.
const opts = { stdout: "inherit", stderr: "inherit", env: process.env } as const;
Bun.spawn(["bun", "run", "server/index.ts"], opts);
Bun.spawn(["bunx", "--bun", "vite"], { cwd: "web", ...opts });
await new Promise(() => {}); // keep the launcher alive
export {};
