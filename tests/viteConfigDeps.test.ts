// Guards the decoupling that keeps the Vite dev server alive: vite.config sources API_PORT from the
// leaf server/ports.ts, which must NOT import orca.config. If the port constant moved back into
// server/config (whose loadConfig dynamically imports orca.config), Vite would watch orca.config,
// "restart server" on every edit to it, and that restart intermittently hangs the dev server
// (process alive, :8788 no longer listening). These are static-source assertions — no booting.
import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const read = (rel: string) => readFile(join(import.meta.dir, "..", rel), "utf8");

test("vite.config imports the API port from the orca.config-free leaf module", async () => {
  const vite = await read("web/vite.config.ts");
  expect(vite).toContain('from "../server/ports"');
  expect(vite).not.toContain('API_PORT } from "../server/config"');
});

test("server/ports.ts is a leaf: no orca.config import", async () => {
  const ports = await read("server/ports.ts");
  expect(ports).toContain("export const API_PORT");
  // no static/dynamic import or require of orca.config (prose mentions in comments are fine)
  expect(ports).not.toMatch(/(from\s+["']|import\s*\(\s*["']|require\s*\(\s*["'])[^"']*orca\.config/);
});
