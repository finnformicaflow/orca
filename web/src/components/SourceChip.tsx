// The source chip: which integration a message, an event or a thread came from (Slack, Discord,
// email, a webhook, GitHub, Linear — or a kind the core learns later, by its own name). The inbox's
// rows and thread view use it, and a workstream card shows one per integration it has a thread on
// (`useThreadSources`, one shared poll of /api/inbox/threads for every card).
import { useSyncExternalStore } from "react";
import { Bot, GitPullRequest, Globe, Hash, Mail, MessageSquare, MessagesSquare, SquareKanban, Webhook, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { poll } from "@/lib/poll";
import { sharedSource } from "@/lib/vitals";
import { sourceLabel, threadSources } from "../../../shared/inbox";
import { api } from "../api";

const ICONS: Record<string, LucideIcon> = {
  slack: Hash, discord: MessagesSquare, email: Mail, webhook: Webhook, github: GitPullRequest, linear: SquareKanban, web: Globe, orca: Bot,
};

export function SourceChip({ adapter, iconOnly, className }: { adapter: string; iconOnly?: boolean; className?: string }) {
  const Icon = ICONS[adapter] ?? MessageSquare;
  const label = sourceLabel(adapter);
  return (
    <span data-slot="source-chip" data-source={adapter} aria-label={iconOnly ? label : undefined}
      className={cn("bg-muted text-muted-foreground inline-flex h-5 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium whitespace-nowrap [&>svg]:size-3", className)}>
      <Icon aria-hidden="true" />
      {!iconOnly && label}
    </span>
  );
}

const threadLinkSource = sharedSource<Map<string, string[]>>((set) =>
  poll(() => api.threadLinks().then((r) => set(threadSources(r.links))), 60_000));

/** The integration kinds a workstream has a thread on, in the order they were linked. */
export function useThreadSources(repo: string, branch: string): string[] {
  const map = useSyncExternalStore(threadLinkSource.subscribe, threadLinkSource.get);
  return map?.get(`${repo}::${branch}`) ?? NONE;
}
const NONE: string[] = [];

/** The chips for a card: one per integration, icon and name. Nothing when it has no thread. */
export function ThreadChips({ repo, branch, iconOnly }: { repo: string; branch: string; iconOnly?: boolean }) {
  const sources = useThreadSources(repo, branch);
  if (!sources.length) return null;
  return <span data-slot="thread-chips" className="inline-flex shrink-0 items-center gap-1">{sources.map((s) => <SourceChip key={s} adapter={s} iconOnly={iconOnly} />)}</span>;
}
