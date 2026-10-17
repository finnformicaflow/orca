// This machine's vitals for the header's instance chip (GET /api/health). Shells out to `df` for
// the root disk; everything else is the os module. What the MACHINE costs is an hourly rate
// (`instanceRate`): the config's `instanceHourlyUsd` (Settings), else an on-demand estimate from the EC2 instance type IMDSv2 reports, else 0 — Cost Explorer needs AWS credentials
// the instance role doesn't have, and a rate that is always there beats a bill that needs a login.
import * as os from "os";
import * as db from "./db";
import * as lease from "./lease";
import { run } from "./run";
import { billedUptime, bootKey, journalBoots } from "../web/src/workstream";

export type Health = {
  instance: string; hostname: string; cores: number; cpuPct: number; load1: number; load5: number;
  memUsedGb: number; memTotalGb: number; memPressurePct?: number; memPressure?: boolean;
  disk?: { usedGb: number; totalGb: number }; uptimeS: number;
  at: number;
  /** What this machine costs per hour — `/api/health` adds it (`instanceRate`), so the card's Cost
   *  · this month cell can integrate it over the uptime. Absent from `health()` itself. */
  rate?: InstanceRate;
  /** What this machine cost this calendar month (UTC) — the rate over the time its boot ledger
   *  shows it running (`monthCost`). `/api/health` adds it alongside `rate`. */
  month?: MonthCost;
  /** Live leases right now — the same count the sampler records, so the card's "Agents · N" and
   *  the agents line's newest point are one reading. */
  runningAgents: number;
};

// ---- darwin memory: os.freemem() is only the truly-free page count, and the kernel keeps nearly
// all RAM occupied by design (inactive/file cache/speculative), so totalmem()-freemem() reads
// ~100% on every healthy Mac. `vm_stat` is what Activity Monitor's "Memory Used" reads instead:
// app + wired + compressed, i.e. active + wired + occupied-by-compressor pages. (Linux is fine as
// is: os.freemem() there already tracks /proc/meminfo's MemAvailable, so totalmem()-freemem() is
// the same "used" Activity Monitor's Linux equivalents report — verified against /proc/meminfo on
// the box.) Both shell out through `run` (server/run.ts) so tests can shim them on PATH, same as
// the rest of the server's adapters.

type VmStatPages = { pageSize: number; activePages: number; wiredPages: number; compressorPages: number };

/** Parse `vm_stat`'s text report. `Pages occupied by compressor` is missing on older macOS, where
 *  it counts as zero. Returns undefined if the page size or the active/wired lines aren't there —
 *  a format we don't recognise, so the caller should fall back rather than report nonsense. */
export function parseVmStat(out: string): VmStatPages | undefined {
  const pageSize = out.match(/page size of (\d+) bytes/)?.[1];
  const activePages = out.match(/Pages active:\s*(\d+)\./)?.[1];
  const wiredPages = out.match(/Pages wired down:\s*(\d+)\./)?.[1];
  const compressorPages = out.match(/Pages occupied by compressor:\s*(\d+)\./)?.[1];
  if (!pageSize || !activePages || !wiredPages) return undefined;
  return { pageSize: Number(pageSize), activePages: Number(activePages), wiredPages: Number(wiredPages), compressorPages: Number(compressorPages ?? 0) };
}

/** Activity Monitor's "Memory Used", in GB: app (active) + wired + compressed, page size weighted. */
export function vmStatUsedGb(p: VmStatPages): number {
  return Math.round(((p.pageSize * (p.activePages + p.wiredPages + p.compressorPages)) / 1073741824) * 10) / 10;
}

async function vmStat(): Promise<string> {
  return run(["vm_stat"]);
}

/** `kern.memorystatus_level` is a free-ness level (100 ≈ plenty free, falling as pressure rises).
 *  Inverted to a pressure percentage; "pressure" proper below ~20 (Apple's own warn/critical band
 *  starts there). Undefined when the sysctl isn't there (non-darwin, or an old kernel). */
async function memoryPressureLevel(): Promise<number | undefined> {
  const n = Number((await run(["sysctl", "-n", "kern.memorystatus_level"])).trim());
  return Number.isFinite(n) ? n : undefined;
}

/** darwin's corrected memory figures, shelling to `vm_stat`/`sysctl` through `run` so a test can
 *  shim them on PATH (tests/health.test.ts, same approach as tests/helpers.ts' fake `gh`) without
 *  the box actually being a Mac. Exported separately
 *  from `health()` for exactly that: `process.platform` can't be faked, these adapters can. Each
 *  failure degrades on its own — a missing sysctl shouldn't cost the (more important) used figure. */
export async function darwinMemory(): Promise<{ memUsedGb?: number; memPressurePct?: number; memPressure?: boolean }> {
  let memUsedGb: number | undefined;
  try {
    const parsed = parseVmStat(await vmStat());
    if (parsed) memUsedGb = vmStatUsedGb(parsed);
  } catch { /* vm_stat unavailable */ }
  let memPressurePct: number | undefined, memPressure: boolean | undefined;
  try {
    const level = await memoryPressureLevel();
    if (level !== undefined) { memPressurePct = Math.round(100 - level); memPressure = level < 20; }
  } catch { /* sysctl unavailable */ }
  return { memUsedGb, memPressurePct, memPressure };
}

export async function health(): Promise<Health> {
  const cores = os.cpus().length || 1;
  const [load1 = 0, load5 = 0] = os.loadavg();
  let disk: Health["disk"];
  try {
    const out = Bun.spawnSync(["df", "-k", "/"]).stdout.toString().trim().split("\n").at(-1)?.split(/\s+/) ?? [];
    if (out.length >= 4) disk = { usedGb: Math.round((Number(out[2]) / 1048576) * 10) / 10, totalGb: Math.round((Number(out[1]) / 1048576) * 10) / 10 };
  } catch { /* no df */ }

  // linux: os.freemem() already tracks MemAvailable, so totalmem()-freemem() is real "used".
  let memUsedGb = Math.round(((os.totalmem() - os.freemem()) / 1073741824) * 10) / 10;
  let memPressurePct: number | undefined;
  let memPressure: boolean | undefined;
  if (process.platform === "darwin") {
    const darwin = await darwinMemory();
    if (darwin.memUsedGb !== undefined) memUsedGb = darwin.memUsedGb;
    memPressurePct = darwin.memPressurePct;
    memPressure = darwin.memPressure;
  }

  return {
    instance: db.instanceName(), hostname: os.hostname(), cores,
    cpuPct: Math.min(100, Math.round((load1 / cores) * 100)), load1, load5,
    memUsedGb, memTotalGb: Math.round((os.totalmem() / 1073741824) * 10) / 10, memPressurePct, memPressure,
    disk, uptimeS: Math.round(os.uptime()),
    at: Date.now(),
    runningAgents: lease.live().length,
  };
}

// ---- history (instance_metric) ----

/** How often each instance samples itself into `instance_metric`. */
export const METRIC_SAMPLE_MS = 60_000;

/** The `hours` a history request asks for: 24 by default, at most the 30 days kept. */
export function historyHours(raw: string | null | undefined): number {
  const n = Number(raw);
  return raw && Number.isFinite(n) && n > 0 ? Math.min(n, 24 * 30) : 24;
}

// Agent runs OOM-killed in their own scope (server/agent.ts) since the last sample. In memory: a
// restart between samples loses at most a minute's count, which the chart can afford.
let oomKills = 0;
export function noteOomKill(): void { oomKills++; }

/** Sample this machine and record it. Never throws: a metrics write must not touch anything else.
 *  Running agents come from the leases (durable, per-host) rather than agent.ts's in-memory `runs`
 *  map, so a sample taken right after a restart still counts what's genuinely live. No cost is
 *  recorded: the machine's cost is its hourly rate over its boot ledger, which each sample's
 *  heartbeat (`heartbeat`) keeps current. */
export async function sampleMetrics(): Promise<void> {
  if (db.unavailableSince() !== null) return; // skipped while down (kills carry over); db.ts announces the outage once
  await heartbeat();
  const kills = oomKills;
  oomKills = 0;
  try {
    const h = await health();
    await db.recordMetric({
      cpuPct: h.cpuPct, load1: h.load1, memUsedGb: h.memUsedGb, memTotalGb: h.memTotalGb, diskUsedGb: h.disk?.usedGb,
      runningAgents: h.runningAgents, oomKills: kills,
    }, h.at);
  } catch (e) {
    oomKills += kills; // not recorded — carry them to the next sample
    db.logUnlessDown("orca: metrics sample failed")(e);
  }
}

/** Each instance samples ITSELF once a minute (and once at startup, so a fresh box has a point),
 *  after backfilling its boot ledger from the journal. */
export function startMetricsSampler(ms = METRIC_SAMPLE_MS): ReturnType<typeof setInterval> {
  void importJournalBoots().finally(() => void sampleMetrics());
  db.onAvailable(() => void sampleMetrics()); // a sample the outage skipped, taken at once on its return
  return setInterval(() => void sampleMetrics(), ms).unref();
}

// ---- the uptime ledger (instance_boot) ----

/** This kernel's boot: its id (`/proc/sys/kernel/random/boot_id`; off Linux, the boot minute — a
 *  boot seen under two ids is merged by `billedUptime`, never double-counted) and when it booted. */
export async function currentBoot(now = Date.now()): Promise<{ bootId: string; bootedAt: number }> {
  const bootedAt = Math.round(now - os.uptime() * 1000);
  const id = await Bun.file(process.env.ORCA_BOOT_ID_FILE ?? "/proc/sys/kernel/random/boot_id").text().catch(() => "");
  return { bootId: id.trim() ? bootKey(id) : `t${Math.round(bootedAt / 60_000)}`, bootedAt };
}

/** Mark this boot seen now. Never throws, and runs apart from the metrics write: the ledger is what
 *  the month's cost reads, so neither may take the other down. */
export async function heartbeat(now = Date.now()): Promise<void> {
  if (db.unavailableSince() !== null) return;
  try {
    const b = await currentBoot(now);
    await db.recordBoots([{ ...b, lastSeen: now }]);
  } catch (e) {
    db.logUnlessDown("orca: uptime heartbeat failed")(e);
  }
}

/** Backfill the ledger with every boot the journal remembers (`journalctl --list-boots`): the boots
 *  before Orca ran, or before this ledger existed, each spanning its first to last journal entry — so
 *  a boot Orca was down or hung through still counts whole. Silently nothing without journald (a Mac)
 *  or permission to read it. */
export async function importJournalBoots(): Promise<number> {
  try {
    const boots = journalBoots(await run(["journalctl", "--list-boots", "-o", "json", "--no-pager"]));
    await db.recordBoots(boots);
    return boots.length;
  } catch {
    return 0;
  }
}

// ---- the machine's hourly rate ----

export type MonthCost = {
  usd: number; upHours: number; since: number;
  /** Hours whose billing nobody here can tell (`billedUptime`), counted as stopped; `usdMax` is the
   *  figure were they billed. */
  unknownHours: number; usdMax: number;
  /** Hours before the ledger assumed running because of the configured billing start. */
  assumedHours: number;
  ledgerFrom: number | null; billingSince?: number;
};

/** This calendar month's (UTC) cost: the rate × the hours the machine's kernel boot ledger shows it
 *  running (`billedUptime`: boots, the reboots between them, and — from `billingSince`, the
 *  configured launch — the time before the ledger), never Orca's own samples. */
export async function monthCost(hourlyUsd: number, o: { billingSince?: number; instance?: string; now?: number; currentBootId?: string } = {}): Promise<MonthCost> {
  const now = o.now ?? Date.now(), instance = o.instance ?? db.instanceName();
  const d = new Date(now);
  const since = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const currentBootId = o.currentBootId ?? (instance === db.instanceName() ? (await currentBoot(now)).bootId : undefined);
  const u = billedUptime(await db.boots(instance), { from: since, now, currentBootId, billingSince: o.billingSince });
  const rate = Math.max(0, hourlyUsd), H = 3_600_000;
  const usd = (ms: number) => Math.round((ms / H) * rate * 100) / 100;
  return {
    usd: usd(u.billedMs), upHours: u.billedMs / H, since,
    unknownHours: u.unknownMs / H, usdMax: usd(u.billedMs + u.unknownMs), assumedHours: u.assumedMs / H,
    ledgerFrom: u.ledgerFrom, ...(o.billingSince === undefined ? {} : { billingSince: o.billingSince }),
  };
}

export type InstanceRate = {
  hourlyUsd: number;
  /** config: the app config's `instanceHourlyUsd`; estimate: the built-in on-demand table for the
   *  type IMDS reported; none: nothing known (the laptop) — 0. */
  source: "config" | "estimate" | "none";
  instanceType?: string; region?: string;
};

/** On-demand Linux USD/hour for common types, by region. An ESTIMATE (list price, no savings plan,
 *  no EBS/transfer) — a type or region not here reads as unknown, never a guess. Checked 2026-10. */
export const EC2_ON_DEMAND_USD: Record<string, Record<string, number>> = {
  "eu-west-2": {
    "t3.medium": 0.0472, "t3.large": 0.0944, "t3.xlarge": 0.1888,
    "m6i.large": 0.111, "m6i.xlarge": 0.222, "m6i.2xlarge": 0.444,
    "m7i.large": 0.11655, "m7i.xlarge": 0.2331, "m7i.2xlarge": 0.4662,
  },
  "us-east-1": {
    "t3.medium": 0.0416, "t3.large": 0.0832, "t3.xlarge": 0.1664,
    "m6i.large": 0.096, "m6i.xlarge": 0.192, "m6i.2xlarge": 0.384,
    "m7i.large": 0.1008, "m7i.xlarge": 0.2016, "m7i.2xlarge": 0.4032,
  },
};

/** The instance type and region from EC2's metadata service (IMDSv2: a session token, then two
 *  reads). Undefined off EC2 — a laptop has nothing at 169.254.169.254, so a short timeout. */
export async function imdsInstance(base = process.env.ORCA_IMDS_URL ?? "http://169.254.169.254", timeoutMs = 1000): Promise<{ instanceType: string; region: string } | undefined> {
  // Bun.fetch, not the global (the test DOM shim swaps that for one with a same-origin policy), and a
  // timer race rather than an AbortSignal (the shim swaps that too): off EC2 the connect just hangs.
  const ask = async () => {
    const tr = await Bun.fetch(`${base}/latest/api/token`, { method: "PUT", headers: { "X-aws-ec2-metadata-token-ttl-seconds": "60" } });
    if (!tr.ok) return undefined;
    const headers = { "X-aws-ec2-metadata-token": await tr.text() };
    const get = async (path: string) => {
      const r = await Bun.fetch(`${base}/latest/meta-data/${path}`, { headers });
      return r.ok ? (await r.text()).trim() : "";
    };
    const [instanceType, region] = await Promise.all([get("instance-type"), get("placement/region")]);
    return instanceType && region ? { instanceType, region } : undefined;
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([ask(), new Promise<undefined>((r) => { timer = setTimeout(() => r(undefined), timeoutMs); })]);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

// IMDS answers once per process: the instance type can't change under a running bridge.
let imdsCache: Promise<{ instanceType: string; region: string } | undefined> | null = null;
/** Tests: forget the IMDS answer. */
export function resetImds(): void { imdsCache = null; }

/** This machine's rate: the config's per-instance `instanceHourlyUsd` (Settings), else the IMDS
 *  type looked up in `EC2_ON_DEMAND_USD` (an estimate), else 0. (The old ORCA_HOURLY_USD /
 *  ORCA_BILLING_SINCE month-to-date estimate is gone: one override, in the shared config.) */
export async function instanceRate(configured: Record<string, number> | undefined, instance = db.instanceName()): Promise<InstanceRate> {
  const set = configured?.[instance];
  if (typeof set === "number" && set >= 0) return { hourlyUsd: set, source: "config" };
  const ec2 = await (imdsCache ??= imdsInstance());
  const price = ec2 && EC2_ON_DEMAND_USD[ec2.region]?.[ec2.instanceType];
  if (ec2 && price !== undefined) return { hourlyUsd: price, source: "estimate", ...ec2 };
  return { hourlyUsd: 0, source: "none", ...(ec2 ?? {}) };
}
