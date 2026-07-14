import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Highlight, themes } from "prism-react-renderer";
import { ArrowLeft, Check, Clock, ExternalLink, GitMerge, X } from "lucide-react";
import { api } from "../api";
import type { PrDetail as PrDetailData } from "../../../server/gh";
import { addPreviewLabel, useWorkstreams, type Row } from "../store";
import { navigate, type PrTab } from "@/lib/route";
import { useTheme } from "@/lib/theme";
import { WorkstreamActions } from "./WorkstreamActions";
import { PreviewPanel } from "./PreviewControl";
import { TerminalPanel } from "@/components/Terminal";
import { ActionButton } from "@/components/ActionButton";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export function PrDetail({ repo, number, sub }: { repo: string; number: number; sub: PrTab }) {
  const [pr, setPr] = useState<PrDetailData | null>(null);
  const [diff, setDiff] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const liveRow = useWorkstreams().find((r) => r.repo === repo && r.prNumber === number); // your own PR, if tracked

  useEffect(() => {
    setPr(null);
    setError(null);
    api.prDetail(repo, number).then(setPr).catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [repo, number]);

  useEffect(() => {
    if (sub === "files" && diff === null) api.prDiff(repo, number).then((d) => setDiff(d.diff)).catch(() => setDiff(""));
  }, [sub, repo, number, diff]);

  const go = (t: PrTab) => navigate(t === "overview" ? `/${repo}/prs/${number}` : `/${repo}/prs/${number}/${t}`);
  const back = `/${repo}`;

  if (error) return <div className="space-y-4"><Back to={back} /><p className="text-destructive text-sm">{error}</p></div>;
  if (!pr) return <div className="space-y-4"><Back to={back} /><p className="text-muted-foreground text-sm">Loading PR #{number}…</p></div>;

  // For a coworker PR (not one of your workstreams) synthesise a row so Test locally + the preview
  // panel + add-label still work here — the review list itself is action-free for density.
  const row: Row = liveRow ?? {
    repo, hasRemote: true, branch: pr.head, title: pr.title, prompt: "", lane: "IN_REVIEW",
    prNumber: pr.number, prUrl: pr.url, previewUrl: pr.previewUrl,
    ciStatus: pr.ciStatus, reviewStatus: pr.reviewStatus, mergeable: pr.mergeable,
  };

  return (
    <div className="space-y-4">
      <Back to={back} />
      <div className="space-y-2">
        <h2 className="flex flex-wrap items-center gap-2 text-lg font-semibold">
          <span className="text-muted-foreground">#{pr.number}</span>
          {pr.title}
          <a className="text-muted-foreground inline-flex items-center gap-1 text-sm font-normal hover:underline" href={pr.url} target="_blank" rel="noreferrer">
            View on GitHub <ExternalLink className="size-3.5" />
          </a>
          {pr.previewUrl && (
            <a className="text-muted-foreground inline-flex items-center gap-1 text-sm font-normal hover:underline" href={pr.previewUrl} target="_blank" rel="noreferrer">
              PR preview <ExternalLink className="size-3.5" />
            </a>
          )}
        </h2>
        <p className="text-muted-foreground text-sm">
          <code>{pr.head}</code> → <code>{pr.base}</code> · by {pr.author || "?"} · +{pr.additions}/−{pr.deletions} across {pr.changedFiles} files
        </p>
        <div className="flex flex-wrap gap-1">
          <Badge variant="outline">{pr.state}</Badge>
          {pr.reviewStatus === "changes_requested" && <Badge variant="destructive">Changes requested</Badge>}
          {pr.reviewStatus === "approved" && <Badge variant="success">Approved</Badge>}
          {pr.mergeable === "CONFLICTING" && <Badge variant="destructive">Conflicts</Badge>}
          {pr.ciStatus === "passing" && <Badge variant="success">CI <Check /></Badge>}
          {pr.ciStatus === "failing" && <Badge variant="destructive">CI <X /></Badge>}
          {pr.ciStatus === "pending" && <Badge variant="outline">CI <Clock /></Badge>}
          {pr.autoMergeEnabled && <Badge variant="outline" className="border-purple-500/20 bg-purple-500/10 text-purple-700 dark:text-purple-400">Auto-merge <GitMerge /></Badge>}
        </div>
        {liveRow ? <WorkstreamActions row={liveRow} />
          : !pr.previewUrl ? <ActionButton onRun={() => addPreviewLabel(row)}>Add preview label</ActionButton>
          : null}
      </div>

      <Tabs value={sub} onValueChange={(v) => go(v as PrTab)}>
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="files">Files changed ({pr.changedFiles})</TabsTrigger>
          <TabsTrigger value="checks">Checks ({pr.checks.length})</TabsTrigger>
          <TabsTrigger value="terminal">Terminal</TabsTrigger>
          <TabsTrigger value="preview">Preview</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-4 pt-3">
          {pr.body ? <Markdown>{pr.body}</Markdown> : <p className="text-muted-foreground text-sm">No description.</p>}
          {(pr.reviews.length > 0 || pr.comments.length > 0) && (
            <div className="space-y-2 border-t pt-3 text-sm">
              {pr.reviews.map((r, i) => (
                <div key={`r${i}`}><span className="text-muted-foreground">{r.author}</span> — {r.state.toLowerCase().replace(/_/g, " ")}</div>
              ))}
              {pr.comments.map((c, i) => (
                <div key={`c${i}`} className="border-l-2 pl-3">
                  <div className="text-muted-foreground text-xs">{c.author}</div>
                  <Markdown>{c.body}</Markdown>
                </div>
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="files" className="space-y-3 pt-3">
          {diff === null ? <p className="text-muted-foreground text-sm">Loading diff…</p> : <DiffView text={diff} />}
        </TabsContent>

        <TabsContent value="checks" className="space-y-1 pt-3">
          {pr.checks.length === 0 && <p className="text-muted-foreground text-sm">No checks.</p>}
          {pr.checks.map((c, i) => (
            <div key={i} className="flex items-center justify-between gap-3 text-sm">
              <span className="truncate">{c.name}</span>
              <Badge variant={c.status === "passing" ? "success" : c.status === "failing" ? "destructive" : "outline"} className="capitalize">{c.status}</Badge>
            </div>
          ))}
        </TabsContent>

        <TabsContent value="terminal" className="pt-3">
          {sub === "terminal" && <TerminalPanel row={row} />}
        </TabsContent>

        <TabsContent value="preview">
          <PreviewPanel row={row} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

const Back = ({ to }: { to: string }) => <Button variant="ghost" size="sm" onClick={() => navigate(to)}><ArrowLeft /> Back to board</Button>;

export const Markdown = ({ children }: { children: string }) => (
  <div className="prose prose-sm dark:prose-invert max-w-none">
    <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
  </div>
);

// ---- diff rendering with syntax highlighting ----
type DiffLine = { type: "add" | "del" | "ctx"; text: string };
type Hunk = { header: string; lines: DiffLine[] };
type FileDiff = { path: string; lang: string; hunks: Hunk[] };

const LANGS: Record<string, string> = {
  ts: "tsx", tsx: "tsx", js: "jsx", jsx: "jsx", mjs: "jsx", cjs: "jsx",
  py: "python", rb: "ruby", go: "go", rs: "rust", java: "java", kt: "kotlin",
  css: "css", scss: "scss", json: "json", md: "markdown", yml: "yaml", yaml: "yaml",
  sh: "bash", bash: "bash", sql: "sql", html: "markup", tf: "hcl",
};
const langOf = (path: string) => LANGS[path.split(".").pop() ?? ""] ?? "tsx";

function parseDiff(text: string): FileDiff[] {
  const files: FileDiff[] = [];
  let file: FileDiff | null = null;
  let hunk: Hunk | null = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git")) {
      file = { path: line.split(" b/").pop() ?? "", lang: "tsx", hunks: [] };
      file.lang = langOf(file.path);
      files.push(file);
      hunk = null;
    } else if (!file) {
      continue;
    } else if (line.startsWith("+++ b/")) {
      file.path = line.slice(6);
      file.lang = langOf(file.path);
    } else if (line.startsWith("@@")) {
      hunk = { header: line, lines: [] };
      file.hunks.push(hunk);
    } else if (hunk && (line[0] === "+" || line[0] === "-" || line[0] === " ")) {
      hunk.lines.push({ type: line[0] === "+" ? "add" : line[0] === "-" ? "del" : "ctx", text: line.slice(1) });
    }
  }
  return files;
}

export function DiffView({ text }: { text: string }) {
  const files = parseDiff(text);
  if (files.length === 0) return <p className="text-muted-foreground text-sm">No diff.</p>;
  return (
    <Accordion type="multiple" defaultValue={files.map((_, i) => `f${i}`)} className="space-y-2">
      {files.map((f, i) => {
        const lines = f.hunks.flatMap((h) => h.lines);
        const adds = lines.filter((l) => l.type === "add").length;
        const dels = lines.filter((l) => l.type === "del").length;
        return (
          <AccordionItem key={i} value={`f${i}`} className="overflow-hidden rounded-md border last:border-b">
            <AccordionTrigger className="bg-muted/50 px-3 py-2 font-mono text-xs hover:no-underline">
              <span className="flex flex-1 items-center gap-2 overflow-hidden">
                <span className="truncate">{f.path}</span>
                <span className="ml-auto shrink-0">
                  <span className="text-emerald-600 dark:text-emerald-400">+{adds}</span> <span className="text-red-600 dark:text-red-400">−{dels}</span>
                </span>
              </span>
            </AccordionTrigger>
            <AccordionContent className="p-0">
              <div className="overflow-x-auto border-t font-mono text-xs">
                {f.hunks.map((h, j) => (
                  <div key={j}>
                    <div className="bg-muted/30 px-3 py-0.5 text-cyan-700 dark:text-cyan-400">{h.header}</div>
                    <HunkView hunk={h} lang={f.lang} />
                  </div>
                ))}
              </div>
            </AccordionContent>
          </AccordionItem>
        );
      })}
    </Accordion>
  );
}

function HunkView({ hunk, lang }: { hunk: Hunk; lang: string }) {
  const code = hunk.lines.map((l) => l.text).join("\n");
  // prism-react-renderer paints token colors inline, so a light theme is dark-on-dark in dark mode:
  // swap to a dark syntax theme when the `.dark` class is on (useTheme re-renders on toggle).
  useTheme();
  const dark = document.documentElement.classList.contains("dark");
  return (
    <Highlight theme={dark ? themes.vsDark : themes.github} code={code} language={lang}>
      {({ tokens, getLineProps, getTokenProps }) => (
        <>
          {tokens.map((lineTokens, i) => {
            const type = hunk.lines[i]?.type ?? "ctx";
            const bg = type === "add" ? "bg-emerald-500/10 dark:bg-emerald-500/25" : type === "del" ? "bg-red-500/10 dark:bg-red-500/25" : "";
            const signColor = type === "add" ? "text-emerald-600 dark:text-emerald-400" : type === "del" ? "text-red-600 dark:text-red-400" : "text-muted-foreground";
            const sign = type === "add" ? "+" : type === "del" ? "−" : " ";
            return (
              <div key={i} {...getLineProps({ line: lineTokens, className: `flex px-2 ${bg}` })}>
                <span className={`${signColor} w-4 shrink-0 select-none`}>{sign}</span>
                <span className="flex-1 whitespace-pre">{lineTokens.map((token, k) => <span key={k} {...getTokenProps({ token })} />)}</span>
              </div>
            );
          })}
        </>
      )}
    </Highlight>
  );
}
