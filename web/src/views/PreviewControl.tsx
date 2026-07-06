import { useEffect, useState } from "react";
import { ExternalLink, FlaskConical, Loader2, Square, TriangleAlert } from "lucide-react";
import type { PreviewSvc } from "../api";
import { previewStatus, stopPreview, testLocally, type Row } from "../store";
import { Button } from "@/components/ui/button";

// Shared preview lifecycle: start in the background, poll status, expose ready/failed/link.
function usePreview(row: Row) {
  const [svcs, setSvcs] = useState<PreviewSvc[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!row.worktreePath) { setSvcs([]); return; }
    let cancelled = false;
    const tick = () => void previewStatus(row.worktreePath!).then((s) => !cancelled && setSvcs(s)).catch(() => {});
    tick();
    const t = setInterval(tick, 2500); // reflects "starting → ready" without a manual refresh
    return () => { cancelled = true; clearInterval(t); };
  }, [row.worktreePath]);

  const open = svcs.find((s) => s.open) ?? svcs[0];
  const start = async () => {
    setBusy(true); setError(null);
    try { setSvcs(await testLocally(row)); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); } // don't revert silently
    finally { setBusy(false); }
  };
  const stop = async () => { if (!row.worktreePath) return; setBusy(true); try { await stopPreview(row.worktreePath); setSvcs([]); } finally { setBusy(false); } };

  const crashed = svcs.find((s) => !s.running);
  const ready = svcs.length > 0 && svcs.every((s) => s.ready); // whole stack up (frontend AND backend)
  const failed = Boolean(crashed);
  const starting = svcs.length > 0 && !ready && !failed;

  // Tick once a second while starting so the elapsed timer updates (shows if a boot is hanging).
  const [, tick] = useState(0);
  useEffect(() => {
    if (!starting) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [starting]);
  const startedAt = svcs.reduce((min, s) => Math.min(min, s.startedAt || Infinity), Infinity);
  const elapsed = starting && Number.isFinite(startedAt) ? Math.floor((Date.now() - startedAt) / 1000) : 0;

  return {
    svcs, busy, open, ready, failed, starting, elapsed,
    error: error ?? crashed?.error, // start-time error, else the failed service's captured log tail
    active: svcs.length > 0,
    start, stop,
  };
}

/** Compact "Test locally" action for the card footer: Test → Starting Ns → Open local (+Stop). */
export function PreviewControl({ row }: { row: Row }) {
  const { busy, open, active, ready, failed, starting, elapsed, error, start, stop } = usePreview(row);

  if (!active && !busy) {
    return (
      <Button size="sm" variant="outline" className="w-full justify-center" onClick={() => void start()} title={error ? `Preview failed: ${error}` : "Spin up a local preview of this branch"}>
        {error ? <TriangleAlert className="text-destructive size-3.5" /> : <FlaskConical className="size-3.5" />}
        {error ? "Retry local test" : "Test locally"}
      </Button>
    );
  }
  // Connected button group: the state button + Stop read as one control.
  return (
    <div className="inline-flex w-full">
      {ready && open ? (
        <Button size="sm" variant="outline" className="flex-1 justify-center rounded-r-none" onClick={() => window.open(open.url, "_blank", "noreferrer")} title={`Open local preview on :${open.port}`}>
          <ExternalLink className="size-3.5" /> Open local
        </Button>
      ) : failed ? (
        <Button size="sm" variant="outline" className="flex-1 justify-center rounded-r-none" onClick={() => void start()} title={error ?? "preview failed"}>
          <TriangleAlert className="text-destructive size-3.5" /> Retry local test
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

/** Full panel for the detail Preview tab: embeds the running frontend once it's ready. */
export function PreviewPanel({ row }: { row: Row }) {
  const { open, active, ready, failed, busy, error, start, stop } = usePreview(row);

  return (
    <div className="space-y-2 pt-3">
      <div className="flex items-center gap-2">
        {!active && <Button size="sm" disabled={busy} onClick={() => void start()}>{busy ? "Starting…" : "Start preview"}</Button>}
        {active && <Button size="sm" variant="outline" disabled={busy} onClick={() => void stop()}>Stop preview</Button>}
        {active && !ready && !failed && <span className="text-muted-foreground text-sm">starting the frontend + backend… (~10s)</span>}
        {error && !failed && <span className="text-destructive text-sm">{error}</span>}
        {failed && <span className="text-destructive text-sm">a service failed to start — check Postgres is running and backend/.env exists</span>}
        {ready && open && <a className="text-muted-foreground inline-flex items-center gap-1 text-sm hover:underline" href={open.url} target="_blank" rel="noreferrer">open :{open.port} <ExternalLink className="size-3.5" /></a>}
      </div>
      {failed && error && <pre className="bg-muted max-h-48 overflow-auto rounded-md p-3 text-xs whitespace-pre-wrap">{error}</pre>}
      {ready && open && <iframe title="preview" src={open.url} className="h-[70vh] w-full rounded-md border" />}
    </div>
  );
}
