import { useEffect, useState } from "react";
import { useAtom } from "jotai";
import { ExternalLink } from "lucide-react";
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
    // Fetch per-repo independently: a repo that errors (e.g. a stale bridge missing the route)
    // shows its error rather than silently blanking the whole page as "no PRs".
    const load = async () => {
      const results = await Promise.all(active.map(async (r): Promise<{ list?: Item[]; err?: string }> => {
        try { return { list: (await api.reviewPrs(r.name)).map((p) => ({ ...p, repo: r.name })) }; }
        catch (e) { return { err: `${r.name}: ${e instanceof Error ? e.message : String(e)}` }; }
      }));
      if (cancelled) return;
      setItems(results.flatMap((x) => x.list ?? []).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)));
      setError(results.map((x) => x.err).filter(Boolean).join(" · ") || null);
    };
    setItems(null);
    void load();
    const t = setInterval(() => void load(), 15_000); // coworker PRs change slowly — poll gently
    return () => { cancelled = true; clearInterval(t); };
  }, [filter, repos]);

  if (!items) return <p className="text-muted-foreground text-sm">Loading review queue…</p>;

  return (
    <div className="space-y-3">
      {error && <p className="text-destructive text-sm">{error}</p>}
      {items.length === 0 && !error && <p className="text-muted-foreground text-sm">No open PRs from your coworkers right now. 🎉</p>}
      <ol className="space-y-3 border-l pl-5">
        {items.map((pr) => (
          <ReviewItem key={`${pr.repo}::${pr.number}`} pr={pr} row={reviewRow(pr.repo, pr, liveByBranch.get(`${pr.repo}::${pr.branch}`))} multiRepo={repos.length > 1} />
        ))}
      </ol>
    </div>
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
          {/* CI status isn't in the meta list (it's a slow per-PR fetch) — see it on the detail page. */}
          <div className="ml-auto flex flex-wrap gap-1">
            {pr.isDraft && <Badge variant="outline">draft</Badge>}
            {pr.reviewStatus === "changes_requested" && <Badge variant="destructive">changes requested</Badge>}
            {pr.reviewStatus === "approved" && <Badge variant="success">approved</Badge>}
            {pr.mergeable === "CONFLICTING" && <Badge variant="destructive">conflicts</Badge>}
          </div>
        </div>
        <p className="text-muted-foreground mt-1 text-xs">
          #{pr.number} · {pr.authorName || pr.author || "?"}{multiRepo && <> · <span className="font-medium">{pr.repo}</span></>} · updated {timeAgo(pr.updatedAt)}
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <ActionButton onRun={() => addPreviewLabel(row)}>Add preview label</ActionButton>
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
