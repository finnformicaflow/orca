import { useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Copies `text` to the clipboard and briefly shows a check. */
export function CopyButton({
  text,
  children,
  size = "sm",
  variant = "outline",
}: {
  text: string;
  children: ReactNode;
  size?: "sm" | "default";
  variant?: "default" | "outline" | "ghost" | "secondary";
}) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <Button size={size} variant={copied ? "secondary" : variant} onClick={copy}>
      {copied ? <><Check /> Copied</> : <><Copy /> {children}</>}
    </Button>
  );
}
