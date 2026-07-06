import { useEffect, useState } from "react";
import { useAtom } from "jotai";
import { ExternalLink } from "lucide-react";
import { api } from "../api";
import type { ReviewPr } from "../../../server/gh";
import { useRepos } from "../store";
import { repoFilterAtom } from "@/lib/atoms";
import { navigate } from "@/lib/route";
import { Badge } from "@/components/ui/badge";

type Item = ReviewPr & { repo: string };

// The coworker review queue: every open PR NOT authored by you, across the configured repos,
// newest-updated first. A dense, scannable index — click a row to open the PR detail, where the
// deep info lives (CI, diff, deploy preview, "Test locally"). Kept to a readable column width.
export function Review() {
  const repos = useRepos();
  const [filter] = useAtom(repoFilterAtom);
  const [items, setItems] = useState<Item[] | null>(null);
  const [error, setError] = useState<string | null>(null);

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
    <div className="max-w-[1024px] space-y-3">
      {error && <p className="text-destructive text-sm">{error}</p>}
      {items.length === 0 && !error && <p className="text-muted-foreground text-sm">No open PRs from your coworkers right now. 🎉</p>}
      <ol className="divide-y">
        {items.map((pr) => <ReviewItem key={`${pr.repo}::${pr.number}`} pr={pr} multiRepo={repos.length > 1} />)}
      </ol>
    </div>
  );
}

function ReviewItem({ pr, multiRepo }: { pr: Item; multiRepo: boolean }) {
  return (
    <li className="hover:bg-muted/40 flex items-baseline gap-2 py-1.5">
      <button className="min-w-0 flex-1 truncate text-left text-sm font-medium hover:underline" onClick={() => navigate(`/${pr.repo}/prs/${pr.number}`)}>
        {pr.title}
      </button>
      <span className="text-muted-foreground shrink-0 text-xs">
        #{pr.number} · {pr.authorName || pr.author || "?"}{multiRepo && <> · {pr.repo}</>} · {timeAgo(pr.updatedAt)}
      </span>
      {pr.isDraft && <Badge variant="outline">draft</Badge>}
      {pr.reviewStatus === "changes_requested" && <Badge variant="destructive">changes</Badge>}
      {pr.reviewStatus === "approved" && <Badge variant="success">approved</Badge>}
      {pr.mergeable === "CONFLICTING" && <Badge variant="destructive">conflicts</Badge>}
      <a className="text-muted-foreground hover:text-foreground shrink-0" href={pr.url} target="_blank" rel="noreferrer" title="View on GitHub"><ExternalLink className="size-3.5" /></a>
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
