import { useEffect, useState } from "react";
import { useAtom } from "jotai";
import { Check, Clock, ExternalLink, X } from "lucide-react";
import { api } from "../api";
import type { ReviewPr } from "../../../server/gh";
import { addPreviewLabel, reviewRow, useRepos, useWorkstreams, type Row } from "../store";
import { repoFilterAtom } from "@/lib/atoms";
import { navigate } from "@/lib/route";
import { ActionButton } from "@/components/ActionButton";
import { PreviewControl } from "./PreviewControl";
import { Badge } from "@/components/ui/badge";

type Item = ReviewPr & { repo: string };

// The coworker review queue: every open PR NOT authored by you, across the configured repos,
// newest-updated first. A flat timeline (not a board) — you're triaging others' work, not moving it
// through your own lifecycle. Each row reuses "Test locally" (adopts the branch + spins up the
// preview, migrations included) and either opens the deploy preview or adds the preview label.
export function Review() {
  const repos = useRepos();
  const [filter] = useAtom(repoFilterAtom);
  const [items, setItems] = useState<Item[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const liveRows = useWorkstreams();
  const liveByBranch = new Map(liveRows.map((r) => [`${r.repo}::${r.branch}`, r]));

  useEffect(() => {
    const active = repos.filter((r) => r.hasRemote && (filter === "all" || r.name === filter));
    let cancelled = false;
    const load = () =>
      Promise.all(active.map((r) => api.reviewPrs(r.name).then((list) => list.map((p) => ({ ...p, repo: r.name }))).catch(() => [] as Item[])))
        .then((all) => { if (!cancelled) { setItems(all.flat().sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))); setError(null); } })
        .catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    setItems(null);
    load();
    const t = setInterval(load, 15_000); // coworker PRs change slowly — poll gently
    return () => { cancelled = true; clearInterval(t); };
  }, [filter, repos]);

  if (error) return <p className="text-destructive text-sm">{error}</p>;
  if (!items) return <p className="text-muted-foreground text-sm">Loading review queue…</p>;
  if (items.length === 0) return <p className="text-muted-foreground text-sm">No open PRs from your coworkers right now. 🎉</p>;

  return (
    <ol className="space-y-3 border-l pl-5">
      {items.map((pr) => (
        <ReviewItem key={`${pr.repo}::${pr.number}`} pr={pr} row={reviewRow(pr.repo, pr, liveByBranch.get(`${pr.repo}::${pr.branch}`))} multiRepo={repos.length > 1} />
      ))}
    </ol>
  );
}

function ReviewItem({ pr, row, multiRepo }: { pr: Item; row: Row; multiRepo: boolean }) {
  const detail = `/${pr.repo}/prs/${pr.number}`;
  return (
    <li className="relative">
      {/* Timeline dot on the rail */}
      <span className="bg-border ring-background absolute top-1.5 -left-[27px] size-2.5 rounded-full ring-4" />
      <div className="rounded-lg border p-3">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <button className="text-left font-medium hover:underline" onClick={() => navigate(detail)}>{pr.title}</button>
          <a className="text-muted-foreground hover:text-foreground" href={pr.url} target="_blank" rel="noreferrer" title="View on GitHub"><ExternalLink className="size-3.5" /></a>
          <div className="ml-auto flex flex-wrap gap-1">
            {pr.isDraft && <Badge variant="outline">draft</Badge>}
            {pr.reviewStatus === "changes_requested" && <Badge variant="destructive">changes requested</Badge>}
            {pr.reviewStatus === "approved" && <Badge variant="success">approved</Badge>}
            {pr.mergeable === "CONFLICTING" && <Badge variant="destructive">conflicts</Badge>}
            {pr.ciStatus === "passing" && <Badge variant="success">CI <Check /></Badge>}
            {pr.ciStatus === "failing" && <Badge variant="destructive">CI <X /></Badge>}
            {pr.ciStatus === "pending" && <Badge variant="outline">CI <Clock /></Badge>}
          </div>
        </div>
        <p className="text-muted-foreground mt-1 text-xs">
          #{pr.number} · {pr.authorName || pr.author || "?"}{multiRepo && <> · <span className="font-medium">{pr.repo}</span></>} · updated {timeAgo(pr.updatedAt)}
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {pr.previewUrl ? (
            <a className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm hover:underline" href={pr.previewUrl} target="_blank" rel="noreferrer">
              <ExternalLink className="size-3.5" /> PR preview
            </a>
          ) : (
            <ActionButton onRun={() => addPreviewLabel(row)}>Add preview label</ActionButton>
          )}
          <div className="w-44"><PreviewControl row={row} /></div>
        </div>
      </div>
    </li>
  );
}

// Compact relative time ("3h ago", "2d ago"). Coarse on purpose — this is a triage timeline.
function timeAgo(iso: string): string {
  if (!iso) return "?";
  const s = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
