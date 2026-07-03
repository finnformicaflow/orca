// Per-workstream preview: spins up each configured service (frontend, backend, …) via `sh -lc`
// so shell scripts + env prefixes work. Services for one workstream are tracked together, keyed
// by branch/worktree, and started in the background. Status reports whether each process is
// still alive and whether the opened service's port is actually responding (ready).
import { nextPort } from "../web/src/workstream";
import type { PreviewService } from "./config";

type Svc = { name: string; port: number; open: boolean; proc: Bun.Subprocess; exited: boolean };
export type SvcStatus = { name: string; port: number; url: string; open: boolean; running: boolean; ready: boolean };

const previews = new Map<string, Svc[]>();
const usedPorts = () => [...previews.values()].flat().map((s) => s.port);

export function start(key: string, cwd: string, services: PreviewService[], portRange: [number, number]): void {
  stop(key); // restart clean
  const ports: Record<string, number> = {};
  for (const s of services) ports[s.name] = nextPort([...usedPorts(), ...Object.values(ports)], portRange);
  const svcs: Svc[] = services.map((s) => {
    const cmd = s.command
      .replace(/\{port\}/g, String(ports[s.name]))
      .replace(/\{svc:(\w+)\}/g, (_, n) => String(ports[n] ?? ""));
    const proc = Bun.spawn(["sh", "-lc", cmd], { cwd, env: process.env, stdout: "ignore", stderr: "ignore" });
    const svc: Svc = { name: s.name, port: ports[s.name]!, open: s.open ?? false, proc, exited: false };
    void proc.exited.then(() => { svc.exited = true; });
    return svc;
  });
  previews.set(key, svcs);
}

async function portReady(port: number): Promise<boolean> {
  try {
    await fetch(`http://localhost:${port}`, { signal: AbortSignal.timeout(700) });
    return true; // any HTTP response means the dev server is up
  } catch {
    return false; // connection refused / timeout — not up yet
  }
}

export async function status(key: string): Promise<SvcStatus[]> {
  const svcs = previews.get(key) ?? [];
  return Promise.all(svcs.map(async (s) => {
    const running = !s.exited;
    const ready = running && s.open ? await portReady(s.port) : running;
    return { name: s.name, port: s.port, url: `http://localhost:${s.port}`, open: s.open, running, ready };
  }));
}

export function stop(key: string): void {
  for (const s of previews.get(key) ?? []) {
    try { s.proc.kill(); } catch { /* already gone */ }
  }
  previews.delete(key);
}

/** Kill all preview services — call on server shutdown. */
export function killAll(): void {
  for (const key of [...previews.keys()]) stop(key);
}
