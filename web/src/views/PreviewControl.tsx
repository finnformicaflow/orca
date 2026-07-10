import { useEffect, useRef, useState } from "react";
import { Check, Copy, ExternalLink, FlaskConical, Loader2, MonitorPlay, Square, TriangleAlert } from "lucide-react";
import { api, type PreviewSvc } from "../api";
import { baseBranch, previewStatus, startMaster, stopMaster, stopPreview, testLocally, useMaster, useMasters, useRepos, useWorkstreams, type Row } from "../store";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

// Shared preview lifecycle: start in the background, poll status, expose ready/failed/link. Driven
// by a preview `key` (the worktree path) and a `starter` that spins it up — so the same hook powers
// a branch preview (key known up front) and the "test master" preview (key learned on start).
function usePreview(initialKey: string | undefined, starter: () => Promise<{ key: string; svcs: PreviewSvc[] }>) {
  const [key, setKey] = useState(initialKey);
  const [svcs, setSvcs] = useState<PreviewSvc[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Once a service has crashed we reap the whole group and stop polling until the next start —
  // the ref dedupes the auto-reap and freezes the poll so a stale in-flight response can't revive it.
  const reaping = useRef(false);

  // Adopt the caller's key when it lands (e.g. a row gains a worktree after adoption).
  useEffect(() => { if (initialKey) setKey(initialKey); }, [initialKey]);

  useEffect(() => {
    if (!key) { setSvcs([]); return; }
    let cancelled = false;
    const tick = () => { if (reaping.current) return; void previewStatus(key).then((s) => !cancelled && setSvcs(s)).catch(() => {}); };
    tick();
    const t = setInterval(tick, 2500); // reflects "starting → ready" without a manual refresh
    return () => { cancelled = true; clearInterval(t); };
  }, [key]);

  const open = svcs.find((s) => s.open) ?? svcs[0];
  const crashed = svcs.find((s) => !s.running);
  const ready = svcs.length > 0 && svcs.every((s) => s.ready); // whole stack up (frontend AND backend)
  const starting = svcs.length > 0 && !ready && !crashed;
  const failed = Boolean(error) && svcs.length === 0; // a crash/start error was captured and reaped

  // Auto-reap on crash: a failed service leaves its siblings running + ports held, so the user would
  // otherwise have to hit Stop. Capture the service's log for the debug panel, drop back to the idle
  // "Retry" state immediately (no lingering Stop button), and reap procs/ports in the background.
  useEffect(() => {
    if (!crashed || !key || reaping.current) return;
    reaping.current = true;
    setError(crashed.error ?? "a service failed to start");
    setSvcs([]);
    void stopPreview(key).catch(() => {});
  }, [crashed, key]);

  const start = async () => {
    setBusy(true); setError(null); reaping.current = false; // fresh run: re-enable polling, clear the last error
    try { const r = await starter(); setKey(r.key); setSvcs(r.svcs); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); } // don't revert silently
    finally { setBusy(false); }
  };
  const stop = async () => {
    if (!key) return;
    setBusy(true); reaping.current = true; // stop polling; nothing left to reflect
    try { await stopPreview(key); setSvcs([]); } finally { setBusy(false); }
  };

  // Tick once a second while starting so the elapsed timer updates (shows if a boot is hanging).
  const [, tick] = useState(0);
  useEffect(() => {
    if (!starting) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [starting]);
  const startedAt = svcs.reduce((min, s) => Math.min(min, s.startedAt || Infinity), Infinity);
  const elapsed = starting && Number.isFinite(startedAt) ? Math.floor((Date.now() - startedAt) / 1000) : 0;

  return { svcs, busy, open, ready, failed, starting, elapsed, error, active: svcs.length > 0, start, stop };
}

// Collapsed-by-default log of a failed preview — the captured tail of the crashed service's output,
// so the reason (missing module, port in use, Postgres down…) is one click away without leaving Orca.
// A copy button (top-right) grabs the whole log for pasting into an agent / issue.
function ErrorLog({ error }: { error: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(error); setCopied(true); setTimeout(() => setCopied(false), 1500); }
    catch { /* clipboard unavailable */ }
  };
  return (
    <details className="text-xs">
      <summary className="text-muted-foreground hover:text-foreground cursor-pointer select-none">Preview failed — show log</summary>
      <div className="relative mt-1">
        <button onClick={copy} title="Copy log" className="text-muted-foreground hover:text-foreground bg-muted/80 absolute top-1 right-1 rounded p-1 backdrop-blur">
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        </button>
        <pre className="bg-muted max-h-48 overflow-auto rounded-md p-2 pr-8 whitespace-pre-wrap">{error}</pre>
      </div>
    </details>
  );
}

/** Compact "Test locally" action for the card footer: Test → Starting Ns → Open local (+Stop). */
export function PreviewControl({ row }: { row: Row }) {
  const { svcs, busy, active, error, start, stop } = usePreview(row.worktreePath, () => testLocally(row));

  // Idle (incl. after a failure — the crashed preview auto-stops, so there's no Stop button here,
  // just Retry + the expandable log).
  if (!active && !busy) {
    return (
      <div className="w-full space-y-1">
        <Button size="sm" variant="outline" className="w-full justify-center" onClick={() => void start()} title={error ? "Preview failed — expand the log below" : "Spin up a local preview of this branch"}>
          {error ? <TriangleAlert className="text-destructive size-3.5" /> : <FlaskConical className="size-3.5" />}
          {error ? "Retry local test" : "Test locally"}
        </Button>
        {error && <ErrorLog error={error} />}
      </div>
    );
  }
  // Running/starting: the state button + Stop read as one connected control.
  return <PreviewLiveControl svcs={svcs} busy={busy} onStop={() => void stop()} openLabel="Open local" startingLabel="Starting local…" />;
}

// The failed-preview log affordance, styled exactly like the card's ErrorLog trigger ("Preview
// failed — show log"). The menu is tight, so — unlike the card's inline <details> expand — the log
// opens in a popover floating above the row. Copy button included.
function LogPopover({ error }: { error: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(error); setCopied(true); setTimeout(() => setCopied(false), 1500); }
    catch { /* clipboard unavailable */ }
  };
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className="text-muted-foreground hover:text-foreground cursor-pointer text-xs select-none">Preview failed — show log</button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 text-xs">
        <div className="relative">
          <button onClick={() => void copy()} title="Copy log" className="text-muted-foreground hover:text-foreground bg-muted/80 absolute top-1 right-1 rounded p-1 backdrop-blur">
            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          </button>
          <pre className="bg-muted max-h-48 overflow-auto rounded-md p-2 pr-8 whitespace-pre-wrap">{error}</pre>
        </div>
      </PopoverContent>
    </Popover>
  );
}

// Live "Ns" counter while a preview boots (shows if it's hanging). Kept local to the row since it's
// pure display; the preview state itself lives in the store so it survives the popover closing.
function useElapsed(active: boolean, svcs: PreviewSvc[]): number {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [active]);
  const startedAt = svcs.reduce((min, s) => Math.min(min, s.startedAt || Infinity), Infinity);
  return active && Number.isFinite(startedAt) ? Math.floor((Date.now() - startedAt) / 1000) : 0;
}

/** Running/starting state of a live preview: an Open button once the whole stack is up (else a
 *  "Starting Ns" placeholder), joined to a Stop button so the pair reads as one connected control.
 *  Shared by the card's Test-locally control, the Test-master rows, and the running-previews menu. */
function PreviewLiveControl({ svcs, busy, onStop, openLabel, startingLabel }: {
  svcs: PreviewSvc[]; busy: boolean; onStop: () => void; openLabel: string; startingLabel: string;
}) {
  const open = svcs.find((s) => s.open) ?? svcs[0];
  const ready = svcs.length > 0 && svcs.every((s) => s.ready); // whole stack up (frontend AND backend)
  const elapsed = useElapsed(!ready, svcs);
  return (
    <div className="inline-flex w-full">
      {ready && open ? (
        <Button size="sm" variant="outline" className="flex-1 justify-center rounded-r-none" onClick={() => window.open(open.url, "_blank", "noreferrer")} title={`Open preview on :${open.port}`}>
          <ExternalLink className="size-3.5" /> {openLabel}
        </Button>
      ) : (
        <Button size="sm" variant="outline" className="flex-1 justify-center rounded-r-none" disabled>
          <Loader2 className="size-3.5 animate-spin" /> {startingLabel} {elapsed > 0 ? `${elapsed}s` : ""}
        </Button>
      )}
      <Button size="sm" variant="outline" className="rounded-l-none border-l-0" disabled={busy} onClick={onStop} title="Stop preview"><Square className="size-3.5 fill-current" /></Button>
    </div>
  );
}

/** One repo's row in the Test-master menu: its base branch + a Test/Starting/Open·Stop control
 *  (and, on failure, Retry + a Log popover). Reads the shared store lifecycle (see store.startMaster),
 *  so closing the popover mid-spin-up doesn't kill or forget the preview. */
export function TestMasterRow({ repo }: { repo: string }) {
  const base = baseBranch(repo);
  const { svcs, busy, error } = useMaster(repo);
  const active = busy || svcs.length > 0;
  const start = () => void startMaster(repo);
  const stop = () => void stopMaster(repo);

  return (
    <div className="space-y-1">
      <div className="text-muted-foreground text-xs font-medium">{repo}</div>
      {!active ? (
        <div className="w-full space-y-1">
          <Button size="sm" variant="outline" className="w-full justify-center" onClick={start} title={error ? "Preview failed — open the log" : `Spin up a preview of the latest ${base}`}>
            {error ? <TriangleAlert className="text-destructive size-3.5" /> : <FlaskConical className="size-3.5" />}
            {error ? `Retry ${base}` : `Test ${base}`}
          </Button>
          {error && <LogPopover error={error} />}
        </div>
      ) : (
        <PreviewLiveControl svcs={svcs} busy={busy} onStop={stop} openLabel={`Open ${base}`} startingLabel="Starting…" />
      )}
    </div>
  );
}

/** Top-right "Test master" menu: a flask-icon trigger that opens a popover with one row per repo,
 *  each able to spin up a preview of that repo's base branch itself — to sanity-check whether a bug
 *  reproduces on a clean main, without a feature branch in the way. The trigger reads the shared
 *  store state (not the popover's rows, which unmount on close) so it spins the instant a base
 *  preview is booting and shows a badge dot while one is live — even with the popover shut. */
export function TestMasterMenu() {
  const repos = useRepos();
  const masters = useMasters();
  const loading = masters.some((m) => m.busy || (m.svcs.length > 0 && !m.svcs.every((s) => s.ready)));
  const active = masters.some((m) => m.svcs.some((s) => s.running));
  if (repos.length === 0) return null;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button size="icon" variant="outline" className="relative size-8" title="Test master — preview a repo's base branch" aria-label="Test master">
          {loading ? <Loader2 className="size-4 animate-spin" /> : <FlaskConical className="size-4" />}
          {active && <span className="bg-primary ring-background absolute -top-0.5 -right-0.5 size-2 rounded-full ring-2" aria-label="a base preview is running" />}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 space-y-3">
        <div className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">Test master</div>
        {repos.map((r) => <TestMasterRow key={r.name} repo={r.name} />)}
      </PopoverContent>
    </Popover>
  );
}

/** Top-right "Running previews" menu, sitting beside Test master as a button group: lists every live
 *  local preview across repos (the cards' "Test locally" spins + any base-branch previews), each
 *  labelled with its session title and offering Open / Stop via the shared control. A count badge on
 *  the trigger tracks how many are running — polling the bridge (`/api/previews`) so it stays live
 *  even with the popover shut. */
export function PreviewManagerMenu() {
  const [previews, setPreviews] = useState<{ key: string; svcs: PreviewSvc[] }[]>([]);
  // The endpoint is unreachable when Orca previews itself: its Vite proxies /api to whatever bridge
  // is already running (:8787), which may predate this route and 404. Track that so the menu shows a
  // legible "API unavailable" hint instead of a false "No previews running" empty state.
  const [unavailable, setUnavailable] = useState(false);
  const rows = useWorkstreams();
  // Previews are keyed by worktree path; match that to a row for the session title (fall back to the
  // last path segment for adopted/base worktrees with no card).
  const titleOf = (key: string) => rows.find((r) => r.worktreePath === key)?.title ?? key.split("/").pop() ?? key;

  const load = () => void api.previews().then((p) => { setPreviews(p); setUnavailable(false); }).catch(() => setUnavailable(true));
  useEffect(() => {
    load();
    const t = setInterval(load, 2500); // reflects start/stop without a manual refresh
    return () => clearInterval(t);
  }, []);

  const running = previews.filter((p) => p.svcs.some((s) => s.running));
  const stop = async (key: string) => { await stopPreview(key).catch(() => {}); load(); };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button size="icon" variant="outline" className="relative size-8" title="Running previews" aria-label="Running previews">
          <MonitorPlay className="size-4" />
          {!unavailable && running.length > 0 && (
            <span className="bg-primary text-primary-foreground ring-background absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] leading-none font-semibold ring-2" aria-label={`${running.length} running previews`}>
              {running.length}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 space-y-3">
        <div className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">Running previews</div>
        {unavailable ? (
          <div className="text-muted-foreground text-xs">Previews API unavailable — run the bridge on this branch.</div>
        ) : running.length === 0 ? (
          <div className="text-muted-foreground text-xs">No previews running.</div>
        ) : (
          running.map((p) => (
            <div key={p.key} className="space-y-1">
              <div className="text-muted-foreground truncate text-xs font-medium" title={titleOf(p.key)}>{titleOf(p.key)}</div>
              <PreviewLiveControl svcs={p.svcs} busy={false} onStop={() => void stop(p.key)} openLabel="Open" startingLabel="Starting…" />
            </div>
          ))
        )}
      </PopoverContent>
    </Popover>
  );
}

/** Full panel for the detail Preview tab: embeds the running frontend once it's ready. */
export function PreviewPanel({ row }: { row: Row }) {
  const { open, active, ready, failed, busy, error, start, stop } = usePreview(row.worktreePath, () => testLocally(row));

  return (
    <div className="space-y-2 pt-3">
      <div className="flex items-center gap-2">
        {!active && <Button size="sm" disabled={busy} onClick={() => void start()}>{busy ? "Starting…" : failed ? "Retry preview" : "Start preview"}</Button>}
        {active && <Button size="sm" variant="outline" disabled={busy} onClick={() => void stop()}>Stop preview</Button>}
        {active && !ready && <span className="text-muted-foreground text-sm">starting the frontend + backend… (~10s)</span>}
        {failed && <span className="text-destructive text-sm">a service failed to start — expand the log for details</span>}
        {ready && open && <a className="text-muted-foreground inline-flex items-center gap-1 text-sm hover:underline" href={open.url} target="_blank" rel="noreferrer">open :{open.port} <ExternalLink className="size-3.5" /></a>}
      </div>
      {error && <ErrorLog error={error} />}
      {ready && open && <iframe title="preview" src={open.url} className="h-[70vh] w-full rounded-md border" />}
    </div>
  );
}
