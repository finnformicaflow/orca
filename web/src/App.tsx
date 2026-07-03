import { useRoute } from "@/lib/route";
import { Board } from "./views/Board";
import { PrDetail } from "./views/PrDetail";
import { LocalDetail } from "./views/LocalDetail";

export function App() {
  const route = useRoute();
  return (
    <div className="w-full px-4 py-4 md:px-6">
      <header className="mb-6 flex items-baseline gap-3">
        <h1 className="text-xl font-semibold">🐳 Orca</h1>
        <p className="text-muted-foreground text-sm">agent + PR control plane</p>
      </header>
      {route.name === "pr" ? <PrDetail repo={route.repo} number={route.number} sub={route.sub} />
        : route.name === "local" ? <LocalDetail repo={route.repo} branch={route.branch} sub={route.sub} />
        : <Board />}
    </div>
  );
}
