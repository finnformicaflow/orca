// Handoffs (server/handoff.ts): packs of context for another Orca server, carried by THIS browser —
// the boxes cannot reach each other. A pack is made by the orchestrator (`orca handoff create`) or
// by a card's Hand off (this page's New pack form). Each pending pack shows exactly what goes: the
// message the target's orchestrator gets and every file, text files in full. Send is the only way a
// pack leaves: a click, a confirm with the file list, then GET the pack here, POST it to the target's
// /api/handoff/import, and mark it sent here. A secret or a file over the cap blocks Send.
import { useCallback, useEffect, useState } from "react";
import { Package, Send, Trash2 } from "lucide-react";
import { api } from "../api";
import type { PackView } from "../../../server/handoff";
import { byteSize, handoffTarget, handoffTargets, parseHandoffDraft } from "../workstream";
import { Empty, Pill, VCard } from "@/components/console";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tip } from "@/components/ui/tip";
import { useServers } from "@/components/ServerMenu";
import { apiBase, type ServerEntry } from "@/lib/server";
import { confirmDialog } from "@/lib/dialogs";
import { notifyLocal } from "@/lib/notificationStore";
import { navigate, useSearch } from "@/lib/route";

const failed = (label: string, title: string, e: unknown) => {
  const error = e instanceof Error ? e.message : String(e);
  notifyLocal({ kind: "action_failed", repo: "", title: `Handoff · ${title}`, label, body: error, copy: `Action: ${label} (${title})\nError:\n${error}`, ask: `${label} for the handoff pack "${title}" failed: ${error}. Please investigate.` });
};

export function HandoffsPage() {
  const [data, setData] = useState<{ self: string; packs: PackView[] } | null>(null);
  const load = useCallback(() => api.handoffs().then(setData).catch((e) => { setData({ self: "", packs: [] }); failed("Load handoffs", "list", e); }), []);
  useEffect(() => { void load(); }, [load]);
  const draft = parseHandoffDraft(useSearch());
  const { servers } = useServers();
  // The source is the server this page reads the packs from: its own name, and the chosen API base.
  const source = { name: data?.self ?? "", url: apiBase() || undefined };
  const others = handoffTargets(servers, source);
  const out = data?.packs.filter((p) => p.direction === "out") ?? [];
  const received = data?.packs.filter((p) => p.direction === "in") ?? [];
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Handoffs</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Context for another Orca server{data?.self ? <> from <span className="font-medium">{data.self}</span></> : null}. This browser carries each pack. Nothing goes until you click Send.
        </p>
      </div>
      {draft && <NewPack draft={draft} others={others} onCreated={() => { navigate("/handoffs", true); void load(); }} />}
      <VCard slot="handoffs" title="Packs" bodyClass="divide-y">
        {data === null ? <Empty>Loading…</Empty>
          : out.length === 0 ? <Empty icon={<Package />}>No packs. Ask the orchestrator: <code className="font-mono">orca handoff create --to &lt;server&gt; …</code>, or use Hand off… on a card.</Empty>
          : out.map((p) => <PackRow key={p.id} pack={p} source={source} servers={servers} onChange={load} />)}
      </VCard>
      {received.length > 0 && (
        <VCard slot="handoffs-received" title="Received" bodyClass="divide-y">
          {received.map((p) => (
            <div key={p.id} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
              <span className="min-w-0 truncate"><span className="font-medium">{p.title}</span><span className="text-muted-foreground"> · from {p.source} · {p.files.length} file{p.files.length === 1 ? "" : "s"}</span></span>
              <Pill tone="blue">queued to the orchestrator</Pill>
            </div>
          ))}
        </VCard>
      )}
    </div>
  );
}

function NewPack({ draft, others, onCreated }: { draft: { repo: string; branch: string; title: string }; others: ServerEntry[]; onCreated: () => void }) {
  const [to, setTo] = useState(others[0]?.name ?? "");
  const [title, setTitle] = useState(draft.title);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (!to && others[0]) setTo(others[0].name); }, [others, to]);
  const create = async () => {
    setBusy(true);
    try { await api.createHandoff({ to, title, message, repo: draft.repo, branch: draft.branch }); onCreated(); }
    catch (e) { failed("Create pack", title, e); }
    finally { setBusy(false); }
  };
  return (
    <VCard slot="handoff-new" title={<>New pack · {draft.repo}/{draft.branch}</>}>
      <form className="space-y-3 px-4 py-3 text-sm" onSubmit={(e) => { e.preventDefault(); void create(); }}>
        <p className="text-muted-foreground text-xs">The pack holds this workstream's chat as markdown. You see it in full before you send it.</p>
        <div className="flex flex-col gap-2 md:flex-row">
          {others.length
            ? <Select value={to} onValueChange={setTo}>
                <SelectTrigger aria-label="Send to" className="h-10 md:h-8 md:w-56"><SelectValue placeholder="Server" /></SelectTrigger>
                <SelectContent>{others.map((s) => <SelectItem key={s.url} value={s.name}>{s.name}</SelectItem>)}</SelectContent>
              </Select>
            : <Input aria-label="Send to" placeholder="Server name" value={to} onChange={(e) => setTo(e.target.value)} className="h-10 md:h-8 md:w-56" />}
          <Input aria-label="Title" placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} className="h-10 md:h-8" />
        </div>
        <Textarea aria-label="Message" placeholder="Message for the orchestrator on the other server" value={message} onChange={(e) => setMessage(e.target.value)} rows={3} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={() => navigate("/handoffs", true)}>Cancel</Button>
          <Button type="submit" size="sm" disabled={busy || !to.trim() || !title.trim()}>Create pack</Button>
        </div>
      </form>
    </VCard>
  );
}

function PackRow({ pack, source, servers, onChange }: { pack: PackView; source: { name: string; url?: string }; servers: ServerEntry[]; onChange: () => void }) {
  const [open, setOpen] = useState(!pack.sentAt);
  const [chosen, setChosen] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const others = handoffTargets(servers, source);
  const target = handoffTarget(servers, pack.target, source, chosen);
  const blocked = pack.problems.length > 0;
  const total = pack.files.reduce((n, f) => n + f.size, 0);
  const send = async () => {
    if (!target) return;
    const ok = await confirmDialog({
      title: `Send "${pack.title}" to ${target.name}?`,
      description: (
        <span className="block space-y-1">
          <span className="block">The orchestrator on {target.name} gets the message and {pack.files.length} file{pack.files.length === 1 ? "" : "s"} ({byteSize(total)}):</span>
          {pack.files.map((f) => <span key={f.attachmentId} className="block font-mono text-xs">{f.name} · {byteSize(f.size)}</span>)}
        </span>
      ),
      confirmLabel: "Send",
    });
    if (!ok) return;
    setBusy(true);
    try {
      const wire = await api.exportHandoff(pack.id);
      await api.importHandoff(target.url, wire);
      await api.markHandoffSent(pack.id, target.name);
      onChange();
    } catch (e) { failed(`Send to ${target.name}`, pack.title, e); }
    finally { setBusy(false); }
  };
  const remove = async () => {
    if (!(await confirmDialog({ title: `Delete the pack "${pack.title}"?`, confirmLabel: "Delete", destructive: true }))) return;
    try { await api.deleteHandoff(pack.id); onChange(); } catch (e) { failed("Delete pack", pack.title, e); }
  };
  const sendButton = (
    <Button size="sm" disabled={busy || blocked || !target || !!pack.sentAt} onClick={() => void send()} className="h-10 md:h-8">
      <Send className="size-4" />Send to {target?.name ?? pack.target}
    </Button>
  );
  return (
    <div data-slot="handoff-pack" className="px-4 py-3 text-sm">
      <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <button type="button" className="min-w-0 text-left" aria-expanded={open} onClick={() => setOpen(!open)}>
          <span className="flex items-center gap-2 font-medium">
            {pack.title}
            {pack.sentAt ? <Pill tone="green">sent to {pack.sentTo}</Pill> : blocked ? <Pill tone="red">blocked</Pill> : <Pill tone="blue">ready</Pill>}
          </span>
          <span className="text-muted-foreground block text-xs">
            for {pack.target} · {pack.files.length} file{pack.files.length === 1 ? "" : "s"} · {byteSize(total)} · from {pack.source} · {open ? "hide" : "show"} preview
          </span>
        </button>
        {!pack.sentAt && (
          <div className="flex flex-wrap items-center gap-2">
            {(others.length > 1 || (!target && others.length > 0)) && (
              <Select value={target?.url ?? ""} onValueChange={setChosen}>
                <SelectTrigger aria-label="Send to" className="h-10 md:h-8 md:w-48"><SelectValue placeholder="Choose a server" /></SelectTrigger>
                <SelectContent>{others.map((s) => <SelectItem key={s.url} value={s.url}>{s.name}</SelectItem>)}</SelectContent>
              </Select>
            )}
            {blocked ? <Tip label={pack.problems[0]!}>{sendButton}</Tip>
              : !target ? <Tip label={`No server named ${pack.target} in the server list. Choose one, or add it in the server menu.`}>{sendButton}</Tip>
              : sendButton}
            <Button variant="ghost" size="icon" aria-label="Delete pack" onClick={() => void remove()} className="size-10 md:size-8"><Trash2 className="size-4" /></Button>
          </div>
        )}
      </div>
      {blocked && !pack.sentAt && (
        <ul data-slot="handoff-problems" className="text-geist-red mt-2 list-disc space-y-0.5 pl-5 text-xs">
          {pack.problems.map((p) => <li key={p}>{p}</li>)}
        </ul>
      )}
      {open && (
        <div data-slot="handoff-preview" className="mt-3 space-y-3">
          <div>
            <div className="text-muted-foreground mb-1 text-xs">Message to the orchestrator on {target?.name ?? pack.target}</div>
            <pre className="bg-muted/50 max-h-48 overflow-auto whitespace-pre-wrap rounded-md border p-3 font-mono text-xs">{pack.wouldSay}</pre>
          </div>
          <div>
            <div className="text-muted-foreground mb-1 text-xs">Files ({pack.files.length})</div>
            <div className="divide-y rounded-md border">
              {pack.preview.map((f) => (
                <details key={f.name} className="group">
                  <summary className="flex cursor-pointer items-center justify-between gap-3 px-3 py-2 text-xs">
                    <span className="min-w-0 truncate font-mono">{f.name}</span>
                    <span className="text-muted-foreground shrink-0">{f.kind} · {byteSize(f.size)}{f.missing ? " · missing" : ""}</span>
                  </summary>
                  {f.text !== undefined
                    ? <pre className="bg-muted/50 max-h-72 overflow-auto whitespace-pre-wrap border-t p-3 font-mono text-xs">{f.text}</pre>
                    : <div className="text-muted-foreground border-t px-3 py-2 text-xs">{f.missing ? "Gone from the database." : `Binary file (${f.mimeType}); sent as is.`}</div>}
                </details>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
