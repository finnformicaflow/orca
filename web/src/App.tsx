import { useAtom } from "jotai";
import { RefreshCw } from "lucide-react";
import { navigate, useRoute } from "@/lib/route";
import { repoFilterAtom } from "@/lib/atoms";
import { useRepos } from "./store";
import { Board } from "./views/Board";
import { Review } from "./views/Review";
import { PrDetail } from "./views/PrDetail";
import { LocalDetail } from "./views/LocalDetail";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export function App() {
  const route = useRoute();
  const topLevel = route.name === "board" || route.name === "review";
  return (
    <div className="w-full px-4 py-4 md:px-6">
      <header className="mb-6 flex items-center gap-3">
        <h1 className="text-xl font-semibold">🐳 Orca</h1>
        <p className="text-muted-foreground hidden text-sm sm:block">agent + PR control plane</p>
        {topLevel && <Nav active={route.name} />}
        {topLevel && <BoardControls />}
      </header>
      {route.name === "pr" ? <PrDetail repo={route.repo} number={route.number} sub={route.sub} />
        : route.name === "local" ? <LocalDetail repo={route.repo} branch={route.branch} sub={route.sub} />
        : route.name === "review" ? <Review />
        : <Board />}
    </div>
  );
}

// Switch between your own kanban ("Board") and the coworker review queue ("Review").
function Nav({ active }: { active: "board" | "review" }) {
  const link = (name: "board" | "review", to: string, label: string) => (
    <button
      className={`rounded-md px-2.5 py-1 text-sm font-medium ${active === name ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"}`}
      onClick={() => navigate(to)}
    >
      {label}
    </button>
  );
  return <nav className="flex items-center gap-1">{link("board", "/", "Board")}{link("review", "/review", "Review")}</nav>;
}

// Top-right controls (both top-level views): filter by repo, and refresh the app.
function BoardControls() {
  const repos = useRepos();
  const [filter, setFilter] = useAtom(repoFilterAtom);
  return (
    <div className="ml-auto flex items-center gap-2">
      {repos.length > 1 && (
        <Select value={filter} onValueChange={setFilter}>
          <SelectTrigger className="h-8 w-36"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All repos</SelectItem>
            {repos.map((r) => <SelectItem key={r.name} value={r.name}>{r.name}</SelectItem>)}
          </SelectContent>
        </Select>
      )}
      <Button size="sm" variant="outline" onClick={() => window.location.reload()} title="Reload the app (pick up rebuilt code + refetch)">
        <RefreshCw className="size-3.5" /> Refresh
      </Button>
    </div>
  );
}
