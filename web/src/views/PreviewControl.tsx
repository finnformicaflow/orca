import { useEffect, useState } from "react";
import { ExternalLink } from "lucide-react";
import type { PreviewSvc } from "../api";
import { previewStatus, stopPreview, testLocally, type Row } from "../store";
import { Button } from "@/components/ui/button";

const linkClass = "text-muted-foreground inline-flex items-center gap-0.5 text-xs hover:underline";

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
  return {
    svcs, busy, open,
    error: error ?? crashed?.error, // start-time error, else the failed service's captured log tail
    active: svcs.length > 0,
    ready: svcs.length > 0 && svcs.every((s) => s.ready), // whole stack up (frontend AND backend)
    failed: Boolean(crashed),
    start, stop,
  };
}

/** Compact control on cards: Test locally → starting… → link (or failed), with stop. */
export function PreviewControl({ row }: { row: Row }) {
  const { busy, open, active, ready, failed, error, start, stop } = usePreview(row);

  if (!active && !busy) {
    return (
      <span className="inline-flex items-center gap-2 text-xs">
        <Button variant="link" className={`h-auto p-0 ${linkClass}`} onClick={() => void start()}>
          Test locally <ExternalLink className="size-3" />
        </Button>
        {error && <span className="text-destructive" title={error}>failed</span>}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-2 text-xs">
      {ready && open
        ? <a className={linkClass} href={open.url} target="_blank" rel="noreferrer">preview :{open.port} <ExternalLink className="size-3" /></a>
        : <span className={failed ? "text-destructive" : "text-muted-foreground"} title={failed ? error : undefined}>{failed ? "failed" : "starting…"}</span>}
      <Button variant="link" className="text-muted-foreground h-auto p-0 text-xs" disabled={busy} onClick={() => void stop()}>stop</Button>
    </span>
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
