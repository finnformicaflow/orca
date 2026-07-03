// Per-workstream preview: spins up each configured service (frontend, backend, …) on its
// own assigned port, wiring cross-references (e.g. VITE_BACKEND_URL). Services for one
// workstream are tracked together, keyed by branch, so they start/stop as a unit. Run via
// `sh -lc` so env prefixes and shell scripts in the command work.
import { nextPort } from "../web/src/workstream";
import type { OrcaConfig } from "./config";

type Svc = { name: string; port: number; open: boolean; proc: Bun.Subprocess };
export type SvcStatus = { name: string; port: number; url: string; open: boolean; running: boolean };

const previews = new Map<string, Svc[]>();
const usedPorts = () => [...previews.values()].flat().map((s) => s.port);

export function start(key: string, cwd: string, cfg: OrcaConfig): SvcStatus[] {
  stop(key); // restart clean
  const ports: Record<string, number> = {};
  for (const s of cfg.previewServices) {
    ports[s.name] = nextPort([...usedPorts(), ...Object.values(ports)], cfg.portRange);
  }
  const svcs: Svc[] = cfg.previewServices.map((s) => {
    const cmd = s.command
      .replace(/\{port\}/g, String(ports[s.name]))
      .replace(/\{svc:(\w+)\}/g, (_, n) => String(ports[n] ?? ""));
    const proc = Bun.spawn(["sh", "-lc", cmd], { cwd, env: process.env, stdout: "ignore", stderr: "ignore" });
    return { name: s.name, port: ports[s.name]!, open: s.open ?? false, proc };
  });
  previews.set(key, svcs);
  return status(key);
}

export function status(key: string): SvcStatus[] {
  return (previews.get(key) ?? []).map((s) => ({
    name: s.name,
    port: s.port,
    url: `http://localhost:${s.port}`,
    open: s.open,
    running: s.proc.killed === false,
  }));
}

export function stop(key: string): void {
  for (const s of previews.get(key) ?? []) {
    try { s.proc.kill(); } catch { /* already gone */ }
  }
  previews.delete(key);
}
