import { useState, type ReactNode } from "react";
import { Check, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";

type Variant = "default" | "outline" | "ghost" | "secondary" | "destructive";
type State = "idle" | "loading" | "done" | "error";

/** Button that runs an async action with inline feedback: spinner → ✓/✗ (reverts after 2s).
 *  Disabled while running so it can't be double-fired. */
export function ActionButton({
  onRun,
  children,
  size = "sm",
  variant = "outline",
  disabled,
  confirm,
}: {
  onRun: () => Promise<unknown>;
  children: ReactNode;
  size?: "sm" | "default";
  variant?: Variant;
  disabled?: boolean;
  confirm?: string;
}) {
  const [state, setState] = useState<State>("idle");

  const run = async () => {
    if (state === "loading") return;
    if (confirm && !window.confirm(confirm)) return;
    setState("loading");
    try {
      await onRun();
      setState("done");
    } catch {
      setState("error");
    }
    setTimeout(() => setState("idle"), 2000);
  };

  return (
    <Button size={size} variant={state === "error" ? "destructive" : variant} disabled={disabled || state === "loading"} onClick={() => void run()}>
      {state === "loading" && <Loader2 className="animate-spin" />}
      {state === "done" && <Check />}
      {state === "error" && <X />}
      {children}
    </Button>
  );
}
