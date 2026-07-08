import { useEffect, useRef, useState } from "react";
import { useAtomValue } from "jotai";
import { draftRepoAtom } from "@/lib/atoms";
import { Check, Copy, ExternalLink, FlaskConical, Loader2, Square, TriangleAlert } from "lucide-react";
import type { PreviewSvc } from "../api";
import { baseBranch, previewStatus, stopPreview, testLocally, testMaster, useRepos, type Row } from "../store";
import { Button } from "@/components/ui/button";

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
  const { busy, open, active, ready, starting, elapsed, error, start, stop } = usePreview(row.worktreePath, () => testLocally(row));

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
  return (
    <div className="inline-flex w-full">
      {ready && open ? (
        <Button size="sm" variant="outline" className="flex-1 justify-center rounded-r-none" onClick={() => window.open(open.url, "_blank", "noreferrer")} title={`Open local preview on :${open.port}`}>
          <ExternalLink className="size-3.5" /> Open local
        </Button>
      ) : (
        <Button size="sm" variant="outline" className="flex-1 justify-center rounded-r-none" disabled>
          <Loader2 className="size-3.5 animate-spin" /> Starting local… {starting && elapsed > 0 ? `${elapsed}s` : ""}
        </Button>
      )}
      <Button size="sm" variant="outline" className="rounded-l-none border-l-0" disabled={busy} onClick={() => void stop()} title="Stop preview"><Square className="size-3.5 fill-current" /></Button>
    </div>
  );
}

/** "Test master": spin up a preview of the repo's base branch itself (latest, in a detached
 *  checkout) to sanity-check whether a bug reproduces on a clean main. Lives at the top of the
 *  board's Local lane, scoped to the same repo as the New-draft composer. Same lifecycle/visuals as
 *  the per-card PreviewControl, just keyed by the base worktree rather than a row. */
export function TestMaster() {
  const repos = useRepos();
  const draftRepo = useAtomValue(draftRepoAtom);
  const repo = draftRepo || repos[0]?.name || "";
  const base = repo ? baseBranch(repo) : "main";
  const { busy, open, active, ready, starting, elapsed, error, start, stop } = usePreview(undefined, () => testMaster(repo));
  if (!repo) return null;

  if (!active && !busy) {
    return (
      <div className="w-full space-y-1">
        <Button size="sm" variant="outline" className="w-full justify-center" onClick={() => void start()} title={error ? "Preview failed — expand the log below" : `Spin up a preview of the latest ${base}`}>
          {error ? <TriangleAlert className="text-destructive size-3.5" /> : <FlaskConical className="size-3.5" />}
          {error ? `Retry ${base} test` : `Test ${base}`}
        </Button>
        {error && <ErrorLog error={error} />}
      </div>
    );
  }
  return (
    <div className="inline-flex w-full">
      {ready && open ? (
        <Button size="sm" variant="outline" className="flex-1 justify-center rounded-r-none" onClick={() => window.open(open.url, "_blank", "noreferrer")} title={`Open the ${base} preview on :${open.port}`}>
          <ExternalLink className="size-3.5" /> Open {base}
        </Button>
      ) : (
        <Button size="sm" variant="outline" className="flex-1 justify-center rounded-r-none" disabled>
          <Loader2 className="size-3.5 animate-spin" /> Starting {base}… {starting && elapsed > 0 ? `${elapsed}s` : ""}
        </Button>
      )}
      <Button size="sm" variant="outline" className="rounded-l-none border-l-0" disabled={busy} onClick={() => void stop()} title="Stop preview"><Square className="size-3.5 fill-current" /></Button>
    </div>
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
