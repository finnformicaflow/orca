// Settings > Integrations (docs/research/integrations.md §6.1): a card per integration row — health,
// last event, a Test, the enabled switch (connect / disconnect), its channel links with their level
// and repos — then the people and their identities with the pending pairing codes, the
// subscriptions, and the dead deliveries with Retry. Generic over adapter kinds: the kinds, their
// labels and their Connect fields come from the registry (`overview.kinds`), so a new adapter's
// card and form appear with no change here. The decisions are pure in shared/integrationSettings.ts.
import { useEffect, useState, type ReactNode } from "react";
import { Bell, Bot, Globe, Mail, MessageSquare, MoreHorizontal, Plug, Plus, RotateCw, Trash2, Webhook, X } from "lucide-react";
import { api } from "../api";
import { poll } from "@/lib/poll";
import { notifyLocal } from "@/lib/notificationStore";
import { instanceChoices, thisInstance, useRepos } from "../store";
import { ago } from "../workstream";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Empty, Pill, SectionTitle, StatusDot, VCard } from "@/components/console";
import {
  SUBSCRIPTION_PRESETS, deadTargetLabel, filterText, healthLine, healthTone, integrationProblem, linkProblem, parseFilter, targetLabel,
  type IntegrationCard, type IntegrationsOverview, type LinkRow, type Pairing, type PersonRow,
} from "../../../shared/integrationSettings";
import type { AdapterMeta, Level } from "../../../shared/integrations";

type Overview = IntegrationsOverview;
type LinkLevel = Exclude<Level, "full">;
const LINK_LEVELS: { value: LinkLevel; label: string }[] = [{ value: "notify", label: "Notify" }, { value: "ask", label: "Ask" }, { value: "work", label: "Work" }];
const LEVEL_TONE = { notify: "default", ask: "blue", work: "green" } as const;
// The page's own copy of server/env.ts ORCA_SECRETS (the server checks again): enough to warn early.
const STRIPPED = ["SLACK_TOKEN"] as const;

const KIND_ICON: Record<string, typeof Plug> = { slack: MessageSquare, discord: MessageSquare, email: Mail, webhook: Webhook, web: Globe, github: Bot, linear: Bot };
const KindIcon = ({ kind }: { kind: string }) => { const I = KIND_ICON[kind] ?? Plug; return <I className="text-muted-foreground size-4 shrink-0" />; };

/** Run one write; a failure is the one action-failed notification, never text in the row. */
async function act(label: string, path: string, body: Record<string, unknown>, done: () => void): Promise<Record<string, unknown> | undefined> {
  try { const r = await api.integrationPost(path, body); done(); return r; }
  catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    notifyLocal({ kind: "action_failed", repo: "", title: "Integrations", label: `${label} failed`, body: error, copy: `Action: ${label}\nError:\n${error}`, ask: `Integrations: ${label} failed: ${error}. Please investigate and fix.` });
    return undefined;
  }
}

/** A destructive click asks first, in shadcn's AlertDialog: `ask(title, body, run)` and render `node`. */
function useConfirm(): [(title: string, body: string, run: () => void) => void, ReactNode] {
  const [q, setQ] = useState<{ title: string; body: string; run: () => void } | null>(null);
  const node = (
    <AlertDialog open={!!q} onOpenChange={(o) => { if (!o) setQ(null); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{q?.title}</AlertDialogTitle>
          <AlertDialogDescription>{q?.body}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={() => { q?.run(); setQ(null); }}>Remove</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
  return [(title, body, run) => setQ({ title, body, run }), node];
}

export function IntegrationsPage() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string>();
  const load = () => api.integrations().then((d) => { setData(d); setError(undefined); }).catch((e) => setError(e instanceof Error ? e.message : String(e)));
  useEffect(() => poll(load, 15_000), []);
  const reload = () => void load();
  return (
    <div className="max-w-4xl space-y-6" data-slot="integrations-page">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Integrations</h1>
        {data && <ConnectButton kinds={data.kinds} onSaved={reload} />}
      </div>
      {error && !data && <VCard><Empty>{error}</Empty></VCard>}
      {!data && !error && <VCard><Empty>Loading…</Empty></VCard>}
      {data && (
        <>
          {data.integrations.length === 0
            ? <VCard slot="integrations-empty"><Empty icon={<Plug className="size-5" />}>No integrations yet. Connect one of: {data.kinds.map((k) => k.label).join(", ")}.</Empty></VCard>
            : data.integrations.map((c) => <IntegrationCardView key={c.id} card={c} data={data} onChange={reload} />)}
          <PeopleCard data={data} onChange={reload} />
          <SubscriptionsCard data={data} onChange={reload} />
          <DeadCard data={data} onChange={reload} />
        </>
      )}
    </div>
  );
}

// ── one integration ─────────────────────────────────────────────────────────────────────────────

function IntegrationCardView({ card: c, data, onChange }: { card: IntegrationCard; data: Overview; onChange: () => void }) {
  const meta = data.kinds.find((k) => k.kind === c.kind);
  const links = data.links.filter((l) => l.integrationId === c.id);
  const [test, setTest] = useState<{ busy?: boolean; ok?: boolean; detail?: string }>({});
  const [linkOpen, setLinkOpen] = useState<LinkRow | "new" | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const runTest = async () => {
    setTest({ busy: true });
    const r = await act(`Test ${c.name}`, "test", { id: c.id }, onChange);
    setTest(r ? { ok: r.ok === true, detail: typeof r.detail === "string" ? r.detail : undefined } : {});
  };
  const tone = healthTone(c);
  const [ask, confirmNode] = useConfirm();
  return (
    <VCard slot="integration-card" title={
      <span className="flex min-w-0 items-center gap-2">
        <KindIcon kind={c.kind} />
        <span className="truncate">{c.name}</span>
        <Pill>{meta?.label ?? c.kind}</Pill>
        <span className="max-sm:hidden"><Pill>on {c.instance}</Pill></span>
      </span>
    } aside={
      <>
        <Switch aria-label={`${c.name} connected`} checked={c.enabled} onCheckedChange={(on) => void act(on ? `Connect ${c.name}` : `Disconnect ${c.name}`, "enabled", { id: c.id, on }, onChange)} />
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="size-8" aria-label={`${c.name} actions`}><MoreHorizontal /></Button></DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => setEditOpen(true)}>Edit</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setLinkOpen("new")}>Add {meta?.place ?? "link"}</DropdownMenuItem>
            <DropdownMenuItem className="text-geist-red" onSelect={() => ask(`Remove ${c.name}?`, "Its links and the subscriptions that post to them go too. Past events stay.", () => void act(`Remove ${c.name}`, "remove", { id: c.id }, onChange))}>Remove</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </>
    } bodyClass="divide-y">
      <div className="flex flex-col gap-2 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-start gap-2.5">
          <StatusDot tone={tone} className="mt-1.5" />
          <div className="min-w-0">
            <div data-slot="integration-health" className="break-words">{healthLine(c)}</div>
            <div className="text-muted-foreground mt-0.5 flex flex-wrap items-center gap-x-2 text-xs">
              {c.secretRef
                ? <span data-slot="secret-status"><span className="font-mono">{c.secretRef}</span> · {c.secretSet === undefined ? "not checked yet" : c.secretSet ? "set" : "not set"}</span>
                : <span>no secret</span>}
              <span className="sm:hidden">· on {c.instance}</span>
              {c.running && <span>· running on this bridge</span>}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 sm:shrink-0">
          {test.ok !== undefined && <span data-slot="integration-test-result" className={test.ok ? "text-geist-green text-xs" : "text-geist-red text-xs"}>{test.ok ? "OK" : "Failed"}{test.detail ? ` · ${test.detail}` : ""}</span>}
          <Button variant="secondary" size="sm" disabled={test.busy} onClick={() => void runTest()} className="max-sm:h-10 max-sm:flex-1">Test</Button>
        </div>
      </div>
      {links.length === 0
        ? <div className="text-muted-foreground flex items-center justify-between gap-2 px-4 py-3 text-xs">No {meta?.place ?? "link"}s linked. Orca listens only where a link says so.
            <Button variant="ghost" size="sm" onClick={() => setLinkOpen("new")}><Plus />Add</Button></div>
        : <ul data-slot="integration-links" className="divide-y">{links.map((l) => <LinkRowView key={l.id} link={l} onEdit={() => setLinkOpen(l)} onChange={onChange} />)}</ul>}
      {linkOpen && <LinkDialog integration={c} meta={meta} link={linkOpen === "new" ? undefined : linkOpen} onClose={() => setLinkOpen(null)} onSaved={onChange} />}
      {editOpen && <IntegrationDialog kinds={data.kinds} existing={c} onClose={() => setEditOpen(false)} onSaved={onChange} />}
      {confirmNode}
    </VCard>
  );
}

function LinkRowView({ link: l, onEdit, onChange }: { link: LinkRow; onEdit: () => void; onChange: () => void }) {
  const [test, setTest] = useState<{ busy?: boolean; state?: string; error?: string }>({});
  const run = async () => {
    setTest({ busy: true });
    const r = await act(`Test link ${l.label ?? l.externalId}`, "links/test", { id: l.id }, onChange);
    setTest(r ? { state: String(r.state), ...(typeof r.error === "string" ? { error: r.error } : {}) } : {});
  };
  const [ask, confirmNode] = useConfirm();
  return (
    <li data-slot="integration-link" className="flex flex-col gap-2 px-4 py-3 text-sm md:flex-row md:items-center md:gap-4">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{l.label ?? l.externalId}</span>
          {l.label && <span className="text-muted-foreground font-mono text-xs">{l.externalId}</span>}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          <Pill tone={LEVEL_TONE[l.level]} slot="link-level">{LINK_LEVELS.find((x) => x.value === l.level)?.label}</Pill>
          {l.level === "work" && l.repos.map((r) => <Pill key={r}>{r}</Pill>)}
          {l.requireMention && <Pill>@mention</Pill>}
        </div>
        {test.state && <div data-slot="link-test-result" className={test.state === "sent" ? "text-geist-green mt-1 text-xs" : test.state === "pending" ? "text-muted-foreground mt-1 text-xs" : "text-geist-red mt-1 text-xs"}>
          {test.state === "sent" ? "Test message sent" : test.state === "pending" ? "Test queued — not sent yet" : `Test ${test.state}${test.error ? `: ${test.error}` : ""}`}
        </div>}
      </div>
      <div className="flex items-center gap-1">
        <Button variant="secondary" size="sm" disabled={test.busy} onClick={() => void run()} className="max-md:h-10 max-md:flex-1">Test</Button>
        <Button variant="ghost" size="sm" onClick={onEdit} className="max-md:h-10">Edit</Button>
        <Button variant="ghost" size="icon" className="size-8 max-md:size-10" aria-label={`Remove ${l.label ?? l.externalId}`}
          onClick={() => ask(`Remove ${l.label ?? l.externalId}?`, "Orca stops listening and posting there. Its subscriptions go too.", () => void act("Remove link", "links/remove", { id: l.id }, onChange))}><Trash2 /></Button>
      </div>
      {confirmNode}
    </li>
  );
}

// ── forms ────────────────────────────────────────────────────────────────────────────────────────

const Field = ({ label, htmlFor, hint, children }: { label: string; htmlFor?: string; hint?: ReactNode; children: ReactNode }) => (
  <div className="space-y-1.5">
    <Label htmlFor={htmlFor}>{label}</Label>
    {children}
    {hint && <div className="text-muted-foreground text-xs">{hint}</div>}
  </div>
);

function FormDialog({ title, description, problem, busy, onSubmit, onClose, children }: { title: string; description?: ReactNode; problem?: string; busy?: boolean; onSubmit: () => void; onClose: () => void; children: ReactNode }) {
  const [tried, setTried] = useState(false);
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); setTried(true); if (!problem) onSubmit(); }}>
          {children}
          {tried && problem && <p role="alert" className="text-geist-red text-xs">{problem}</p>}
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={busy}>Save</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ConnectButton({ kinds, onSaved }: { kinds: AdapterMeta[]; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)} data-slot="integration-connect"><Plus />Connect</Button>
      {open && <IntegrationDialog kinds={kinds} onClose={() => setOpen(false)} onSaved={onSaved} />}
    </>
  );
}

function IntegrationDialog({ kinds, existing, onClose, onSaved }: { kinds: AdapterMeta[]; existing?: IntegrationCard; onClose: () => void; onSaved: () => void }) {
  const [kind, setKind] = useState(existing?.kind ?? kinds[0]?.kind ?? "");
  const meta = kinds.find((k) => k.kind === kind);
  const [name, setName] = useState(existing?.name ?? "");
  const [id, setId] = useState(existing?.id ?? "");
  const instances = instanceChoices().length ? instanceChoices() : [thisInstance() ?? "local"];
  const [instance, setInstance] = useState(existing?.instance ?? thisInstance() ?? instances[0]!);
  const [secretRef, setSecretRef] = useState(existing?.secretRef ?? "");
  const [config, setConfig] = useState<Record<string, string>>(() => Object.fromEntries(Object.entries(existing?.config ?? {}).map(([k, v]) => [k, String(v)])));
  const [busy, setBusy] = useState(false);
  const autoId = id || name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const body = { id: autoId, kind, name, instance, secretRef, config, enabled: existing?.enabled ?? true };
  const problem = integrationProblem(body, kinds.map((k) => k.kind), STRIPPED);
  const save = async () => { setBusy(true); const r = await act(existing ? `Save ${name}` : `Connect ${name}`, "save", body, onSaved); setBusy(false); if (r) onClose(); };
  return (
    <FormDialog title={existing ? `Edit ${existing.name}` : "Connect an integration"} problem={problem} busy={busy} onSubmit={() => void save()} onClose={onClose}
      description={meta?.help ?? "The token stays in the instance's environment. Orca stores only the variable name."}>
      <Field label="Kind" htmlFor="int-kind">
        <Select value={kind} onValueChange={setKind} disabled={!!existing}>
          <SelectTrigger id="int-kind" className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent>{kinds.map((k) => <SelectItem key={k.kind} value={k.kind}>{k.label}</SelectItem>)}</SelectContent>
        </Select>
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" htmlFor="int-name"><Input id="int-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={`Work ${meta?.label ?? ""}`.trim()} /></Field>
        <Field label="Id" htmlFor="int-id"><Input id="int-id" value={existing ? existing.id : id} disabled={!!existing} onChange={(e) => setId(e.target.value)} placeholder={autoId || "work-slack"} className="font-mono" /></Field>
      </div>
      <Field label="Runs on" htmlFor="int-instance" hint="One instance opens the connection. Put a personal account on your own machine.">
        <Select value={instance} onValueChange={setInstance}>
          <SelectTrigger id="int-instance" className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent>{[...new Set([...instances, instance])].map((i) => <SelectItem key={i} value={i}>{i}</SelectItem>)}</SelectContent>
        </Select>
      </Field>
      <Field label="Secret variable" htmlFor="int-secret" hint={<>Set it in that instance's <span className="font-mono">.env</span>. It must start with <span className="font-mono">ORCA_SECRET_</span>, so agents never see it.</>}>
        <Input id="int-secret" value={secretRef} onChange={(e) => setSecretRef(e.target.value.toUpperCase())} placeholder={meta?.secretExample ?? "ORCA_SECRET_…"} className="font-mono" />
      </Field>
      {meta?.config?.map((f) => (
        <Field key={f.key} label={f.label} htmlFor={`int-cfg-${f.key}`}>
          <Input id={`int-cfg-${f.key}`} value={config[f.key] ?? ""} placeholder={f.placeholder} onChange={(e) => setConfig({ ...config, [f.key]: e.target.value })} />
        </Field>
      ))}
    </FormDialog>
  );
}

function LinkDialog({ integration: c, meta, link, onClose, onSaved }: { integration: IntegrationCard; meta?: AdapterMeta; link?: LinkRow; onClose: () => void; onSaved: () => void }) {
  const repos = useRepos().map((r) => r.name);
  const [externalId, setExternalId] = useState(link?.externalId ?? "");
  const [label, setLabel] = useState(link?.label ?? "");
  const [level, setLevel] = useState<LinkLevel>(link?.level ?? "notify");
  const [chosen, setChosen] = useState<string[]>(link?.repos ?? []);
  const [mention, setMention] = useState(link?.requireMention ?? true);
  const [busy, setBusy] = useState(false);
  const id = link?.id ?? `${c.id}-${(label || externalId).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}`.slice(0, 63);
  const body = { id, integrationId: c.id, externalId, label, level, repos: level === "work" ? chosen : [], requireMention: mention };
  const problem = linkProblem(body);
  const place = meta?.place ?? "place";
  const save = async () => { setBusy(true); const r = await act(`Save link ${label || externalId}`, "links/save", body, onSaved); setBusy(false); if (r) onClose(); };
  return (
    <FormDialog title={link ? `Edit ${link.label ?? link.externalId}` : `Link a ${place} on ${c.name}`} problem={problem} busy={busy} onSubmit={() => void save()} onClose={onClose}
      description="The level caps what a sender here can ask Orca to do. A person's own level caps it again.">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={`${place[0]!.toUpperCase()}${place.slice(1)} id`} htmlFor="link-ext"><Input id="link-ext" value={externalId} onChange={(e) => setExternalId(e.target.value)} placeholder="C0123ABC" className="font-mono" /></Field>
        <Field label="Label" htmlFor="link-label"><Input id="link-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="#eng" /></Field>
      </div>
      <Field label="Level" htmlFor="link-level" hint={level === "notify" ? "Orca posts here. It ignores messages." : level === "ask" ? "Senders can ask about status, PRs and the board." : "Senders can also start and steer work on the repos below."}>
        <Select value={level} onValueChange={(v) => setLevel(v as LinkLevel)}>
          <SelectTrigger id="link-level" className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent>{LINK_LEVELS.map((l) => <SelectItem key={l.value} value={l.value}>{l.label}</SelectItem>)}</SelectContent>
        </Select>
      </Field>
      {level === "work" && (
        <Field label="Repos">
          <ul className="grid grid-cols-2 gap-x-4 gap-y-1.5">
            {repos.map((r) => (
              <li key={r} className="flex items-center gap-2">
                <Checkbox id={`link-repo-${r}`} checked={chosen.includes(r)} onCheckedChange={(v) => setChosen(v === true ? [...chosen, r] : chosen.filter((x) => x !== r))} />
                <Label htmlFor={`link-repo-${r}`} className="font-normal">{r}</Label>
              </li>
            ))}
          </ul>
        </Field>
      )}
      <div className="flex items-center justify-between gap-4">
        <Label htmlFor="link-mention">Only when @-mentioned</Label>
        <Switch id="link-mention" checked={mention} onCheckedChange={setMention} />
      </div>
    </FormDialog>
  );
}

// ── people and pairing ───────────────────────────────────────────────────────────────────────────

function PeopleCard({ data, onChange }: { data: Overview; onChange: () => void }) {
  const [approve, setApprove] = useState<Pairing | null>(null);
  const integrationName = (id: string) => data.integrations.find((c) => c.id === id)?.name ?? id;
  return (
    <div>
      <SectionTitle>People</SectionTitle>
      <VCard slot="integration-people" bodyClass="divide-y">
        {data.pairings.map((p) => (
          <div key={p.code} data-slot="pairing" className="bg-geist-amber/5 flex flex-col gap-2 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <Pill tone="amber">Pairing {p.code}</Pill>
                <span className="font-medium">{p.name ?? p.externalId}</span>
              </div>
              <div className="text-muted-foreground mt-1 text-xs break-words">{p.adapter} · <span className="font-mono">{p.externalId}</span> · via {integrationName(p.integrationId)} · {ago(p.createdAt)}</div>
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={() => setApprove(p)} className="max-sm:h-10 max-sm:flex-1">Approve</Button>
              <Button size="sm" variant="secondary" onClick={() => void act(`Deny ${p.code}`, "pairing/deny", { code: p.code }, onChange)} className="max-sm:h-10 max-sm:flex-1">Deny</Button>
            </div>
          </div>
        ))}
        {data.people.length === 0 && data.pairings.length === 0 && <Empty>No people yet. An unknown sender gets a pairing code, and it shows here for you to approve.</Empty>}
        {data.people.map((p) => <PersonRowView key={p.id} person={p} onChange={onChange} />)}
      </VCard>
      {approve && <ApproveDialog pairing={approve} people={data.people} onClose={() => setApprove(null)} onSaved={onChange} />}
    </div>
  );
}

function PersonRowView({ person: p, onChange }: { person: PersonRow; onChange: () => void }) {
  const [ask, confirmNode] = useConfirm();
  return (
    <div data-slot="person" className="flex flex-col gap-2 px-4 py-3 text-sm sm:flex-row sm:items-center sm:gap-4">
      <div className="min-w-0 flex-1">
        <div className="font-medium">{p.name}</div>
        <div className="mt-1 flex flex-wrap gap-1.5">
          {p.identities.length === 0 && <span className="text-muted-foreground text-xs">no identities</span>}
          {p.identities.map((i) => (
            <span key={`${i.adapter}:${i.externalId}`} className="bg-muted inline-flex h-6 items-center gap-1 rounded-full pr-1 pl-2.5 text-xs">
              {i.adapter} <span className="font-mono">{i.externalId}</span>
              <button type="button" aria-label={`Unpair ${i.adapter} ${i.externalId}`} className="hover:bg-accent rounded-full p-0.5"
                onClick={() => void act("Unpair identity", "identities/remove", { adapter: i.adapter, externalId: i.externalId }, onChange)}><X className="size-3" /></button>
            </span>
          ))}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Select value={p.maxLevel} onValueChange={(v) => void act(`Set ${p.name}'s level`, "people/save", { ...p, maxLevel: v }, onChange)}>
          <SelectTrigger aria-label={`${p.name} max level`} size="sm" className="w-28 max-sm:h-10 max-sm:flex-1"><SelectValue /></SelectTrigger>
          <SelectContent>{LINK_LEVELS.map((l) => <SelectItem key={l.value} value={l.value}>Up to {l.label}</SelectItem>)}</SelectContent>
        </Select>
        <Button variant="ghost" size="icon" className="size-8 max-sm:size-10" aria-label={`Remove ${p.name}`}
          onClick={() => ask(`Remove ${p.name}?`, "Every identity is unpaired. Their messages are dropped again.", () => void act(`Remove ${p.name}`, "people/remove", { id: p.id }, onChange))}><Trash2 /></Button>
      </div>
      {confirmNode}
    </div>
  );
}

function ApproveDialog({ pairing: p, people, onClose, onSaved }: { pairing: Pairing; people: PersonRow[]; onClose: () => void; onSaved: () => void }) {
  const [personId, setPersonId] = useState("new");
  const [name, setName] = useState(p.name ?? "");
  const [maxLevel, setMaxLevel] = useState<LinkLevel>("ask");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    const r = await act(`Approve ${p.code}`, "pairing/approve", { code: p.code, ...(personId === "new" ? { name, maxLevel } : { principal: personId }) }, onSaved);
    setBusy(false); if (r) onClose();
  };
  return (
    <FormDialog title={`Approve ${p.name ?? p.externalId}`} busy={busy} onSubmit={() => void save()} onClose={onClose}
      problem={personId === "new" && !name.trim() ? "name is required" : undefined}
      description={<>Code <span className="font-mono">{p.code}</span> from {p.adapter} <span className="font-mono">{p.externalId}</span>. Their messages then get min(link level, their level).</>}>
      <Field label="Person" htmlFor="pair-person">
        <Select value={personId} onValueChange={setPersonId}>
          <SelectTrigger id="pair-person" className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="new">A new person</SelectItem>
            {people.map((x) => <SelectItem key={x.id} value={x.id}>{x.name}</SelectItem>)}
          </SelectContent>
        </Select>
      </Field>
      {personId === "new" && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" htmlFor="pair-name"><Input id="pair-name" value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Max level" htmlFor="pair-level">
            <Select value={maxLevel} onValueChange={(v) => setMaxLevel(v as LinkLevel)}>
              <SelectTrigger id="pair-level" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>{LINK_LEVELS.map((l) => <SelectItem key={l.value} value={l.value}>{l.label}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
        </div>
      )}
    </FormDialog>
  );
}

// ── subscriptions ────────────────────────────────────────────────────────────────────────────────

function SubscriptionsCard({ data, onChange }: { data: Overview; onChange: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <SectionTitle aside={<Button variant="ghost" size="sm" onClick={() => setOpen(true)}><Plus />Add</Button>}>Subscriptions</SectionTitle>
      <VCard slot="integration-subscriptions" bodyClass="divide-y">
        {data.subscriptions.length === 0 && <Empty icon={<Bell className="size-5" />}>Nothing goes out yet. Add a subscription to post Orca's events to a link.</Empty>}
        {data.subscriptions.map((s) => (
          <div key={s.id} data-slot="subscription" className="flex items-center gap-3 px-4 py-3 text-sm">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="font-mono text-xs">{s.topicPattern}</span>
                {Object.keys(s.filter).length > 0 && <span className="text-muted-foreground font-mono text-xs">[{filterText(s.filter)}]</span>}
                <span className="text-muted-foreground">→</span>
                <span className="break-words">{targetLabel(s, data.links, data.integrations)}</span>
                {s.digestSeconds && <Pill>digest {Math.round(s.digestSeconds / 60)} min</Pill>}
              </div>
            </div>
            <Button variant="ghost" size="icon" className="size-8 max-sm:size-10" aria-label={`Remove subscription ${s.topicPattern}`}
              onClick={() => void act("Remove subscription", "subscriptions/remove", { id: s.id }, onChange)}><Trash2 /></Button>
          </div>
        ))}
      </VCard>
      {open && <SubscriptionDialog data={data} onClose={() => setOpen(false)} onSaved={onChange} />}
    </div>
  );
}

function SubscriptionDialog({ data, onClose, onSaved }: { data: Overview; onClose: () => void; onSaved: () => void }) {
  const [topicPattern, setTopic] = useState(SUBSCRIPTION_PRESETS[0]!.topicPattern);
  const [digest, setDigest] = useState<number | undefined>();
  const [filter, setFilter] = useState("");
  const [targetKind, setTargetKind] = useState<"link" | "orchestrator" | "workstream" | "web">(data.links.length ? "link" : "web");
  const [targetId, setTargetId] = useState(data.links[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const parsed = parseFilter(filter);
  const problem = !topicPattern.trim() ? "a topic pattern is required" : !parsed ? "filter: repo=…, branch=… or adapter=…, comma-separated"
    : targetKind === "link" && !targetId ? "pick a link" : targetKind === "workstream" && !/^[^:]+::.+$/.test(targetId) ? "workstream: repo::branch" : undefined;
  const save = async () => {
    setBusy(true);
    const r = await act(`Add subscription ${topicPattern}`, "subscriptions/add", { topicPattern, filter: parsed ?? {}, targetKind, ...(targetKind === "link" || targetKind === "workstream" ? { targetId } : {}), ...(digest ? { digestSeconds: digest } : {}) }, onSaved);
    setBusy(false); if (r) onClose();
  };
  return (
    <FormDialog title="Add a subscription" problem={problem} busy={busy} onSubmit={() => void save()} onClose={onClose}
      description="Events whose topic and filter match go to the target.">
      <div className="flex flex-wrap gap-1.5">
        {SUBSCRIPTION_PRESETS.map((p) => (
          <Button key={p.id} type="button" size="sm" variant={topicPattern === p.topicPattern && digest === p.digestSeconds ? "default" : "secondary"}
            onClick={() => { setTopic(p.topicPattern); setDigest(p.digestSeconds); }}>{p.label}</Button>
        ))}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Topic pattern" htmlFor="sub-topic"><Input id="sub-topic" value={topicPattern} onChange={(e) => setTopic(e.target.value)} className="font-mono" /></Field>
        <Field label="Filter" htmlFor="sub-filter"><Input id="sub-filter" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="repo=orca" className="font-mono" /></Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Target" htmlFor="sub-kind">
          <Select value={targetKind} onValueChange={(v) => { setTargetKind(v as typeof targetKind); setTargetId(v === "link" ? data.links[0]?.id ?? "" : ""); }}>
            <SelectTrigger id="sub-kind" className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="link" disabled={!data.links.length}>A link</SelectItem>
              <SelectItem value="orchestrator">The orchestrator</SelectItem>
              <SelectItem value="workstream">A workstream</SelectItem>
              <SelectItem value="web">The web app</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        {targetKind === "link" && (
          <Field label="Link" htmlFor="sub-link">
            <Select value={targetId} onValueChange={setTargetId}>
              <SelectTrigger id="sub-link" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>{data.links.map((l) => <SelectItem key={l.id} value={l.id}>{targetLabel({ targetKind: "link", targetId: l.id }, data.links, data.integrations)}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
        )}
        {targetKind === "workstream" && <Field label="Workstream" htmlFor="sub-ws"><Input id="sub-ws" value={targetId} onChange={(e) => setTargetId(e.target.value)} placeholder="orca::main" className="font-mono" /></Field>}
      </div>
    </FormDialog>
  );
}

// ── dead deliveries ──────────────────────────────────────────────────────────────────────────────

function DeadCard({ data, onChange }: { data: Overview; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const all = async () => { setBusy(true); await act("Retry all deliveries", "deliveries/retry", {}, onChange); setBusy(false); };
  return (
    <div>
      <SectionTitle aside={data.dead.length > 0 && <Button variant="secondary" size="sm" disabled={busy} onClick={() => void all()}><RotateCw />Retry all</Button>}>
        Dead deliveries{data.dead.length > 0 ? ` · ${data.dead.length}` : ""}
      </SectionTitle>
      <VCard slot="integration-dead" bodyClass="divide-y">
        {data.dead.length === 0 && <Empty>No dead deliveries. Every send went out or is still retrying.</Empty>}
        {data.dead.map((d) => (
          <div key={d.id} data-slot="dead-delivery" className="flex flex-col gap-2 px-4 py-3 text-sm sm:flex-row sm:items-center sm:gap-4">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <StatusDot tone="error" />
                <span className="font-medium break-words">{d.title ?? d.topic}</span>
                <span className="text-muted-foreground">→ {deadTargetLabel(d.target)}</span>
              </div>
              <div className="text-muted-foreground mt-1 text-xs break-words">
                <span className="font-mono">{d.topic}</span> · {d.attempts} attempts{d.at ? ` · ${ago(d.at)}` : ""}{d.lastError ? ` · ${d.lastError}` : ""}
              </div>
            </div>
            <Button variant="secondary" size="sm" className="max-sm:h-10" onClick={() => void act(`Retry delivery ${d.id}`, "deliveries/retry", { id: d.id }, onChange)}>Retry</Button>
          </div>
        ))}
      </VCard>
    </div>
  );
}
