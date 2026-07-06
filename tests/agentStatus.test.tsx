// E2E for the standardized Claude status display: agent status is shown by ONE badge
// (`AgentBadge`) reused across every lane, instead of a second ad-hoc "claude working…" tag that
// used to sit in the actions footer. Rendered into a real DOM (happy-dom) so we assert the actual
// emitted text, not a stringly-typed guess. See Board.tsx / WorkstreamActions.tsx.
import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AgentBadge } from "@/views/Board";
import type { Row } from "@/store";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLElement | undefined;

function mount(ui: React.ReactElement): HTMLElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container!);
    root.render(ui);
  });
  return container;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = container = undefined;
});

const row = (over: Partial<Row>): Row => ({ repo: "r", branch: "b", title: "t", lane: "LOCAL", ...over } as Row);

describe("standardized Claude status badge", () => {
  test("running shows the live label (not the old 'claude working…' text)", () => {
    const text = mount(<AgentBadge row={row({ agentStatus: "running" })} hasWork={false} />).textContent ?? "";
    expect(text).toContain("Running");
    expect(text.toLowerCase()).not.toContain("claude working");
  });

  test("done / error map to their own labels", () => {
    expect(mount(<AgentBadge row={row({ agentStatus: "done" })} hasWork={false} />).textContent).toContain("Done");
    afterEachSync();
    expect(mount(<AgentBadge row={row({ agentStatus: "error" })} hasWork={false} />).textContent).toContain("Error");
  });

  test("idle distinguishes committed work (Completed) from a stopped run (Stopped)", () => {
    expect(mount(<AgentBadge row={row({ agentStatus: "idle" })} hasWork={true} />).textContent).toContain("Completed");
    afterEachSync();
    expect(mount(<AgentBadge row={row({ agentStatus: "idle" })} hasWork={false} />).textContent).toContain("Stopped");
  });
});

// Tear down between two mounts inside one test (afterEach only fires between tests).
function afterEachSync() {
  act(() => root?.unmount());
  container?.remove();
  root = container = undefined;
}
