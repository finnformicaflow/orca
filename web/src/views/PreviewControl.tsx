import { useEffect, useState } from "react";
import type { PreviewSvc } from "../api";
import { previewStatus, startPreview, stopPreview } from "../store";
import { Button } from "@/components/ui/button";

/** Start/stop a workstream's preview services and link to them. */
export function PreviewControl({ branch, worktreePath }: { branch: string; worktreePath: string }) {
  const [svcs, setSvcs] = useState<PreviewSvc[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => { previewStatus(branch).then(setSvcs).catch(() => {}); }, [branch]);

  const running = svcs.some((s) => s.running);
  const start = async () => {
    setBusy(true);
    try {
      const s = await startPreview(branch, worktreePath);
      setSvcs(s);
      const open = s.find((x) => x.open) ?? s[0];
      if (open) window.open(open.url, "_blank");
    } finally { setBusy(false); }
  };
  const stop = async () => {
    setBusy(true);
    try { await stopPreview(branch); setSvcs([]); } finally { setBusy(false); }
  };

  if (running) {
    return (
      <span className="flex flex-wrap items-center gap-1">
        {svcs.map((s) => (
          <a key={s.name} href={s.url} target="_blank" rel="noreferrer" className="text-xs hover:underline">{s.name}:{s.port}</a>
        ))}
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void stop()}>Stop</Button>
      </span>
    );
  }
  return <Button size="sm" variant="outline" disabled={busy} onClick={() => void start()}>{busy ? "Starting…" : "Preview"}</Button>;
}
