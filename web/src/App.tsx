import { useAtom } from "jotai";
import { RefreshCw } from "lucide-react";
import { useRoute } from "@/lib/route";
import { repoFilterAtom } from "@/lib/atoms";
import { useRepos } from "./store";
import { Board } from "./views/Board";
import { PrDetail } from "./views/PrDetail";
import { LocalDetail } from "./views/LocalDetail";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export function App() {
  const route = useRoute();
  return (
    <div className="w-full px-4 py-4 md:px-6">
      <header className="mb-6 flex items-center gap-3">
        <h1 className="text-xl font-semibold">🐳 Orca</h1>
        <p className="text-muted-foreground hidden text-sm sm:block">agent + PR control plane</p>
        {route.name === "board" && <BoardControls />}
      </header>
      {route.name === "pr" ? <PrDetail repo={route.repo} number={route.number} sub={route.sub} />
        : route.name === "local" ? <LocalDetail repo={route.repo} branch={route.branch} sub={route.sub} />
        : <Board />}
    </div>
  );
}

// Top-right board controls: filter by repo, and refresh the app (reload the SPA + refetch live data).
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
