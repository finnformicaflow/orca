import { useEffect } from "react";
import { useSetAtom } from "jotai";
import { navigate, useRoute, type Route } from "@/lib/route";
import { addNewOpenAtom } from "@/lib/atoms";
import { useOrchestrator } from "@/components/Terminal";
import { launchOverlay } from "./workstream";
import { expandTruncatedOnTap, trackVisualViewport } from "@/lib/viewport";
import { Shell, Crumb, AddNew } from "@/components/Shell";
import { OrchestratorPanel, OrchestratorPage } from "@/components/Terminal";
import { TerminalPanel } from "@/components/InstanceTerminal";
import { ToastHost } from "@/components/Notifications";
import { useWorkstreams } from "./store";
import { NewDraft } from "./views/Board";
import { Overview } from "./views/Overview";
import { Agents } from "./views/Agents";
import { GitHubPage, PreviewsPage, Repos, Settings, UsagePage } from "./views/Pages";
import { PrDetail } from "./views/PrDetail";
import { IntegrationsPage } from "./views/Integrations";
import { LocalDetail } from "./views/LocalDetail";
import { TooltipProvider } from "./components/ui/tooltip";

// The console: Vercel's shell (sidebar + top bar) around one page per route. The orchestrator's
// window floats outside it, on every route; the top bar's "Ask the orchestrator" opens it. Action
// failures are notifications (lib/notificationStore `actionFailed`), in the one toast stack.
export function App() {
  const route = useRoute();
  // The phone layout's two global listeners: the visible viewport's size (sheets stay above the
  // keyboard) and tap-to-expand for truncated text.
  useEffect(() => { const a = trackVisualViewport(), b = expandTruncatedOnTap(); return () => { a(); b(); }; }, []);
  // A home-screen shortcut (manifest `shortcuts`) launches with ?open=new|orchestrator: open that
  // overlay once, and drop the parameter so a reload doesn't reopen it.
  const setAddNew = useSetAtom(addNewOpenAtom);
  const { ask } = useOrchestrator();
  useEffect(() => {
    const open = launchOverlay(location.search);
    if (!open) return;
    navigate(location.pathname, true);
    if (open === "new") setAddNew(true); else ask();
  }, []);
  return (
    <TooltipProvider>
      <Shell crumbs={<Crumbs route={route} />} sidebarActions={(collapsed) => <SidebarAction collapsed={collapsed} />}>
        <Page route={route} />
      </Shell>
      <ToastHost />
      <OrchestratorPanel />
      <TerminalPanel />
    </TooltipProvider>
  );
}

function Page({ route }: { route: Route }) {
  switch (route.name) {
    case "pr": return <PrDetail repo={route.repo} number={route.number} sub={route.sub} />;
    case "local": return <LocalDetail repo={route.repo} branch={route.branch} sub={route.sub} />;
    case "agents": return <Agents />;
    case "previews": return <PreviewsPage />;
    case "repos": return <Repos />;
    case "github": return <GitHubPage />;
    case "usage": return <UsagePage />;
    case "settings": return <Settings />;
    case "integrations": return <IntegrationsPage />;
    // The orchestrator's routed page (narrow screens; see useOrchestrator). It works if visited
    // directly on a desktop width too — nothing about the route itself is phone-only.
    case "orchestrator": return <OrchestratorPage />;
    default: return <Overview />;
  }
}

const TITLES = { board: "Overview", agents: "Agents", previews: "Previews", repos: "Repos", github: "GitHub", usage: "Usage", settings: "Settings", orchestrator: "Orchestrator", integrations: "Integrations" } as const;

function Crumbs({ route }: { route: Route }) {
  const rows = useWorkstreams();
  if (route.name === "pr" || route.name === "local") {
    const row = route.name === "pr"
      ? rows.find((r) => r.repo === route.repo && r.prNumber === route.number)
      : rows.find((r) => r.repo === route.repo && r.branch === route.branch);
    const label = row?.title ?? (route.name === "pr" ? `#${route.number}` : route.branch);
    return <><Crumb to="/agents">Agents</Crumb><Crumb>{label}</Crumb></>;
  }
  if (route.name === "integrations") return <><Crumb to="/settings">Settings</Crumb><Crumb>Integrations</Crumb></>;
  return <Crumb>{TITLES[route.name]}</Crumb>;
}

// The last of the sidebar's actions: Vercel's "Add New", opening the New-draft box in a dialog.
const SidebarAction = ({ collapsed }: { collapsed: boolean }) => (
  <AddNew collapsed={collapsed}>{(onSent) => <NewDraft onSent={onSent} autoFocus />}</AddNew>
);

// Pure helpers the usage tests import from here (they live in lib/vitals and workstream.ts).
export { aggregateProfiles, headerUsage, mergeUsage } from "@/lib/vitals";
export { untilReset } from "./workstream";
