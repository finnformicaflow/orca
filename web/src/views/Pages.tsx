// The sidebar's other pages. Repos: one row per configured repo with its agents' numbers (a click
// opens Agents scoped to it). Usage: the Usage card with every login expanded, and every machine's
// card. Settings: appearance, the board's density, each machine's hourly cost (editable: the
// instance cards' Cost · this month), and the configuration this bridge runs with (read-only — it
// is edited in orca.config.ts / the config table, not here). Notifications: do not
// disturb, browser notifications, and which kinds pop a toast (the centre keeps every kind).
import { useEffect, useState } from "react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { ChevronRight, FolderGit2, GitBranch, Server, SquareTerminal } from "lucide-react";
import { api, type GithubAccount } from "../api";
import { refreshVitals } from "@/lib/vitals";
import { notifyLocal, setBrowserNotify } from "@/lib/notificationStore";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { browserNotifyAtom, densityAtom, instanceScopeAtom, notifyDndAtom, repoFilterAtom, toastPrefsAtom } from "@/lib/atoms";
import { KIND_META, NOTIFICATION_KINDS, browserNotifyChecked, browserNotifyNote, browserPermission } from "../../../shared/notifications";
import { navigate } from "@/lib/route";
import { useTheme, type Theme } from "@/lib/theme";
import { instanceChoices, setInstanceRate, setInstanceTerminal, staleHours, terminalContext, thisInstance, useAgentProviders, useInstanceRates, useInstanceTerminals, useRepos, useWorkstreams } from "../store";
import { terminalMachines, useOpenTerminal } from "@/components/InstanceTerminal";
import { ago, repoSummaries, terminalBlocked } from "../workstream";
import { Detail, Empty, Pill, SectionTitle, Segmented, StatusDot, VCard } from "@/components/console";
import { FindBox, NAV, THEMES } from "@/components/Shell";
import { InstanceCard, RefreshVitals, UsageCard } from "./Vitals";
import { RunningPreviews, TestMaster } from "./PreviewControl";

export function Repos() {
  const repos = useRepos();
  const rows = useWorkstreams();
  const setRepo = useSetAtom(repoFilterAtom);
  const summaries = repoSummaries(rows, repos.map((r) => r.name));
  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-semibold tracking-tight">Repos</h1>
      <VCard slot="repos-list">
        {summaries.length === 0 ? <Empty>No repos configured.</Empty> : (
          <ul className="divide-y">
            {summaries.map((s) => {
              const info = repos.find((r) => r.name === s.repo)!;
              return (
                <li key={s.repo}>
                  <button type="button" data-slot="repo-row" onClick={() => { setRepo(s.repo); navigate("/agents"); }}
                    className="hover:bg-accent/40 grid w-full grid-cols-[minmax(12rem,1.5fr)_repeat(4,6rem)_7rem] items-center gap-4 px-4 py-3 text-left text-sm">
                    <span className="flex min-w-0 items-center gap-2.5">
                      <span className="bg-muted inline-flex size-8 shrink-0 items-center justify-center rounded-md border"><FolderGit2 className="size-4" /></span>
                      <span className="min-w-0">
                        <span className="block truncate font-medium">{s.repo}</span>
                        <span className="text-muted-foreground flex items-center gap-1 font-mono text-xs"><GitBranch className="size-3" />{info.baseBranch}{info.runsOn ? ` · runs on ${info.runsOn}` : ""}{info.hasRemote ? "" : " · local only"}</span>
                      </span>
                    </span>
                    <Count label="Running" n={s.running} />
                    <Count label="Needs you" n={s.attention} />
                    <Count label="Open PRs" n={s.openPrs} />
                    <Count label="Merged today" n={s.mergedToday} />
                    <span className="text-muted-foreground text-right text-xs">{s.lastActivity ? ago(s.lastActivity) : "no activity"}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </VCard>
    </div>
  );
}

const Count = ({ label, n }: { label: string; n: number }) => (
  <span className="min-w-0">
    <span className="text-muted-foreground block text-xs">{label}</span>
    <span className={`block tabular-nums ${n ? "text-foreground font-medium" : "text-muted-foreground"}`}>{n}</span>
  </span>
);

export function UsagePage() {
  useRepos();
  const here = thisInstance();
  const instances = instanceChoices();
  const machines = instances.length ? instances : here ? [here] : [];
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Usage</h1>
      <UsageCard />
      <div>
        <SectionTitle aside={<RefreshVitals />}>Machines</SectionTitle>
        <div className="space-y-4">{machines.map((m) => <InstanceCard key={m} instance={m} here={m === here || !instances.length} />)}</div>
      </div>
    </div>
  );
}

export function Settings() {
  const [theme, setTheme] = useTheme();
  const [density, setDensity] = useAtom(densityAtom);
  const repos = useRepos();
  const providers = useAgentProviders();
  const here = thisInstance();
  return (
    <div className="max-w-4xl space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
      <MobileNav />
      <VCard slot="settings-appearance" title="Appearance" bodyClass="divide-y">
        <Setting label="Theme" hint="Light, dark, or follow the system.">
          <Segmented label="Theme" value={theme} onChange={(v) => setTheme(v as Theme)} options={THEMES.map((t) => ({ value: t.value, label: t.label }))} />
        </Setting>
        <Setting label="Board density" hint="The Board view's cards: full, or status only.">
          <Segmented label="Density" value={density} onChange={setDensity} options={[{ value: "comfortable", label: "Comfortable" }, { value: "dense", label: "Dense" }]} />
        </Setting>
      </VCard>
      <VCard slot="settings-integrations" bodyClass="divide-y">
        <button type="button" onClick={() => navigate("/settings/integrations")} className="hover:bg-accent/40 flex w-full items-center justify-between gap-4 px-4 py-3 text-left">
          <span className="min-w-0">
            <span className="block text-sm font-medium">Integrations</span>
            <span className="text-muted-foreground block text-xs">Slack, webhooks and other channels: links, people, subscriptions and failed sends.</span>
          </span>
          <ChevronRight className="text-muted-foreground size-4 shrink-0" />
        </button>
      </VCard>
      <NotificationSettings />
      <MachineCostSettings />
      <InstancesSettings />
      <VCard slot="settings-config" title="Configuration" aside={<span className="text-muted-foreground text-xs">read-only · orca.config.ts</span>}>
        <div className="grid grid-cols-2 gap-x-6 gap-y-4 border-b p-4 sm:grid-cols-4">
          <Detail label="This instance"><StatusDot tone="ready" />{here ?? "—"}</Detail>
          <Detail label="Instances">{instanceChoices().join(", ") || here || "—"}</Detail>
          <Detail label="Agent CLIs">{providers.map((p) => <Pill key={p}>{p}</Pill>)}</Detail>
          <Detail label="Bump after">{staleHours()}h</Detail>
        </div>
        <ul className="divide-y">
          {repos.map((r) => (
            <li key={r.name} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-sm">
              <span className="font-medium">{r.name}</span>
              <span className="text-muted-foreground font-mono text-xs">base {r.baseBranch}</span>
              {r.runsOn && <Pill>runs on {r.runsOn}</Pill>}
              {r.slackChannel && <Pill>#{r.slackChannel.replace(/^#/, "")}</Pill>}
              {r.defaultModel && <Pill>{r.defaultModel}</Pill>}
              {!r.hasRemote && <Pill>local only</Pill>}
            </li>
          ))}
        </ul>
      </VCard>
    </div>
  );
}

/** Phone-only (there is no off-canvas drawer any more): everything the sidebar carried that isn't
 *  one of the bottom bar's five destinations (Overview, Agents, New agent, Orchestrator, Settings
 *  itself) — Find, the instance switcher, and links to Previews/Repos/Usage. Hidden on desktop,
 *  where the sidebar already has all of this. */
function MobileNav() {
  const [scope, setScope] = useAtom(instanceScopeAtom);
  const choices = instanceChoices();
  const links = NAV.filter((n) => ["Previews", "Repos", "GitHub", "Usage"].includes(n.label));
  return (
    <VCard slot="settings-mobile-nav" title="Navigate" className="md:hidden" bodyClass="divide-y">
      <Setting label="Find agents" hint="Filters the Agents list.">
        <FindBox />
      </Setting>
      {choices.length > 1 && (
        <Setting label="Instance" hint="Scope the Overview and Agents pages to one machine.">
          <Segmented label="Instance" value={scope} onChange={setScope}
            options={[{ value: "all", label: "All" }, ...choices.map((i) => ({ value: i, label: i }))]} />
        </Setting>
      )}
      <nav aria-label="More pages">
        {links.map(({ to, label, Icon }) => (
          <button key={to} type="button" onClick={() => navigate(to)} className="hover:bg-accent/40 flex w-full items-center gap-3 px-4 py-3 text-left text-sm">
            <Icon className="text-muted-foreground size-4" />{label}
          </button>
        ))}
      </nav>
    </VCard>
  );
}

function NotificationSettings() {
  const [dnd, setDnd] = useAtom(notifyDndAtom);
  const browser = useAtomValue(browserNotifyAtom);
  const [prefs, setPrefs] = useAtom(toastPrefsAtom);
  // Read again when the tab comes back: the user may have changed the site settings meanwhile.
  const [permission, setPermission] = useState(() => browserPermission());
  useEffect(() => {
    const reread = () => setPermission(browserPermission());
    window.addEventListener("focus", reread);
    return () => window.removeEventListener("focus", reread);
  }, []);
  const browserNote = browserNotifyNote(permission);
  return (
    <VCard slot="settings-notifications" title="Notifications" bodyClass="divide-y">
      <Setting label="Do not disturb" hint="Silence the toasts; the centre still collects everything." htmlFor="setting-dnd">
        <Switch id="setting-dnd" checked={dnd} onCheckedChange={setDnd} />
      </Setting>
      <Setting label="Browser notifications" hint="When this tab is hidden: an agent needing input, a failure, a failed check."
        htmlFor={browserNote ? undefined : "setting-browser-notify"}
        note={browserNote && <p role="note" data-slot="browser-notify-note" className="text-foreground mt-1 text-xs">{browserNote}</p>}>
        {!browserNote && (
          <Switch id="setting-browser-notify" data-slot="browser-notify" checked={browserNotifyChecked(browser, permission)}
            onCheckedChange={(on) => { void setBrowserNotify(on).then(setPermission); }} />
        )}
      </Setting>
      <div className="px-4 py-3">
        <div className="text-sm font-medium">Toasts</div>
        <div className="text-muted-foreground mb-2 text-xs">Which kinds pop up in the corner.</div>
        <ul data-slot="notification-kinds" className="grid grid-cols-2 gap-x-6 gap-y-1.5 sm:grid-cols-3">
          {NOTIFICATION_KINDS.map((k) => (
            <li key={k} className="flex items-start gap-2">
              <Checkbox id={`toast-kind-${k}`} className="mt-0.5" checked={prefs[k] !== false}
                onCheckedChange={(v) => setPrefs({ ...prefs, [k]: v === true })} />
              <Label htmlFor={`toast-kind-${k}`} className="leading-5 font-normal">{KIND_META[k].label}</Label>
            </li>
          ))}
        </ul>
      </div>
    </VCard>
  );
}

/** Each machine's USD/hour — `instanceHourlyUsd` in the app config, what its card's Cost · this month
 *  cell accrues. Empty means automatic: an EC2 on-demand estimate, else 0. Read from the store's
 *  config mirror (no fetch of its own), written through the bridge. */
function MachineCostSettings() {
  const rates = useInstanceRates();
  const here = thisInstance();
  const machines = instanceChoices().length ? instanceChoices() : here ? [here] : [];
  if (!machines.length) return null;
  return (
    <VCard slot="settings-machine-cost" title="Machine cost" bodyClass="divide-y">
      {machines.map((m) => <MachineRate key={m} instance={m} saved={rates[m]} />)}
    </VCard>
  );
}

/** Settings → Instances: one row per machine, with its web terminal — the on/off Switch (`terminal`
 *  in the app config, OFF unless turned on here; this row is the only way to set it, as the bridge
 *  keeps it out of a pasted config document) and Open terminal, which opens the terminal panel
 *  (components/InstanceTerminal.tsx) on that machine. A disabled Open says why on the row. */
function InstancesSettings() {
  const on = useInstanceTerminals();
  const here = thisInstance();
  const machines = terminalMachines();
  const openTerminal = useOpenTerminal();
  const [busy, setBusy] = useState<string | null>(null);
  if (!machines.length) return null;
  const ctx = terminalContext();
  const set = async (instance: string, value: boolean) => {
    setBusy(instance);
    try { await setInstanceTerminal(instance, value); }
    catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      notifyLocal({
        kind: "action_failed", repo: "", title: `Terminal · ${instance}`, label: "Terminal setting failed", body: error,
        copy: `Action: Turn the terminal ${value ? "on" : "off"} for ${instance}\nError:\n${error}`,
        ask: `Turning the terminal ${value ? "on" : "off"} for ${instance} failed: ${error}. Please investigate and fix.`,
      });
    }
    finally { setBusy(null); }
  };
  return (
    <VCard slot="settings-instances" title="Instances" bodyClass="divide-y">
      {machines.map((m) => {
        const why = terminalBlocked(m, on[m] === true, ctx);
        return (
          <div key={m} data-slot="instance-row" data-instance={m} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-sm font-medium"><Server className="text-muted-foreground size-4" />{m}{m === here && <span className="text-muted-foreground font-normal">· this machine</span>}</div>
              <div className="text-muted-foreground text-xs">Terminal: a shell as the Orca user. Owner only, 2 sessions, 30 minutes idle.</div>
            </div>
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2">
                <Label htmlFor={`terminal-${m}`} className="text-muted-foreground text-xs font-normal">Terminal</Label>
                <Switch id={`terminal-${m}`} data-slot="terminal-switch" aria-label={`${m} terminal`} checked={on[m] === true}
                  disabled={busy === m} onCheckedChange={(v) => void set(m, v)} />
              </div>
              {why && <span data-slot="terminal-blocked" className="text-muted-foreground text-xs">{why}</span>}
              <Button type="button" size="sm" variant="secondary" data-slot="terminal-open" disabled={why !== null} onClick={() => openTerminal(m)}>
                <SquareTerminal className="size-4" />Open terminal
              </Button>
            </div>
          </div>
        );
      })}
    </VCard>
  );
}

function MachineRate({ instance, saved }: { instance: string; saved: number | undefined }) {
  const [text, setText] = useState(saved === undefined ? "" : String(saved));
  useEffect(() => { setText(saved === undefined ? "" : String(saved)); }, [saved]);
  const [busy, setBusy] = useState(false);
  const value = text.trim() === "" ? null : Number(text);
  const valid = value === null || (Number.isFinite(value) && value >= 0);
  const dirty = (saved ?? null) !== value;
  const save = async () => {
    setBusy(true);
    try { await setInstanceRate(instance, value); void refreshVitals(); }
    catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      notifyLocal({
        kind: "action_failed", repo: "", title: `Machine cost · ${instance}`, label: "Save rate failed", body: error,
        copy: `Action: Save rate for ${instance}\nError:\n${error}`,
        ask: `Save rate for ${instance} failed: ${error}. Please investigate and fix.`,
      });
    }
    finally { setBusy(false); }
  };
  return (
    <Setting label={instance} hint="USD per hour. Empty: an EC2 on-demand estimate, else 0.">
      <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); if (valid && dirty) void save(); }}>
        <span className="text-muted-foreground text-sm">$</span>
        <Input data-slot="machine-rate" aria-label={`${instance} USD per hour`} inputMode="decimal" placeholder="auto" value={text}
          onChange={(e) => setText(e.target.value)} aria-invalid={!valid}
          className="bg-background w-24 tabular-nums" />
        <span className="text-muted-foreground text-sm">/h</span>
        <Button type="submit" variant="secondary" size="sm" disabled={!valid || !dirty || busy}>Save</Button>
      </form>
    </Setting>
  );
}

/** One settings row: the label and hint on the left, the control on the right. `htmlFor` names the
 *  control, so a click on the label works it; `note` goes under the hint (a control that can't work). */
const Setting = ({ label, hint, htmlFor, note, children }: { label: string; hint: string; htmlFor?: string; note?: React.ReactNode; children?: React.ReactNode }) => (
  <div className="flex items-center justify-between gap-4 px-4 py-3">
    <div className="min-w-0">
      {htmlFor ? <Label htmlFor={htmlFor}>{label}</Label> : <div className="text-sm font-medium">{label}</div>}
      <div className="text-muted-foreground text-xs">{hint}</div>
      {note}
    </div>
    {children}
  </div>
);

/** GitHub: the `gh` accounts signed in on THIS machine (a work one and a personal one), which repos
 *  use each, and the name + email their commits carry — the GitHub profile's unless set here; a save
 *  goes to the shared config (`githubAccounts`), so no clone needs its own `git config`. Signing in
 *  another account is `gh auth login` in a terminal — a device-code flow Orca does not wrap. */
export function GitHubPage() {
  const [accounts, setAccounts] = useState<GithubAccount[] | null>(null);
  useEffect(() => { void api.githubAccounts().then((r) => setAccounts(r.accounts)).catch(() => setAccounts([])); }, []);
  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-semibold tracking-tight">GitHub</h1>
      <VCard slot="github-accounts" bodyClass="divide-y">
        {accounts === null ? <Empty>Loading…</Empty>
          : accounts.length === 0 ? <Empty>No gh account is signed in on this machine.</Empty>
          : accounts.map((a) => <AccountRowView key={a.login} account={a} onSaved={setAccounts} />)}
        <div className="text-muted-foreground px-4 py-3 text-xs">
          Add an account on this machine: <code className="font-mono">gh auth login</code>. Pin a repo to one with <code className="font-mono">githubUser</code> in its config, or ask the orchestrator to add the repo — it picks the account that owns it.
        </div>
      </VCard>
    </div>
  );
}

/** The account's GitHub profile image, round, left of the login — on a failed load (a dead login,
 *  no network) it falls back to the first letter of the login, same size and position. */
function AccountAvatar({ login, avatarUrl }: { login: string; avatarUrl?: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <span className="bg-muted relative inline-flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-full border text-xs font-medium">
      {avatarUrl && !failed
        ? <img src={avatarUrl} alt="" className="size-full object-cover" onError={() => setFailed(true)} />
        : login.charAt(0).toUpperCase()}
    </span>
  );
}

function AccountRowView({ account: a, onSaved }: { account: GithubAccount; onSaved: (rows: GithubAccount[]) => void }) {
  const [name, setName] = useState(a.configured.name ?? "");
  const [email, setEmail] = useState(a.configured.email ?? "");
  const [busy, setBusy] = useState(false);
  useEffect(() => { setName(a.configured.name ?? ""); setEmail(a.configured.email ?? ""); }, [a.configured.name, a.configured.email]);
  const dirty = name !== (a.configured.name ?? "") || email !== (a.configured.email ?? "");
  const save = async () => {
    setBusy(true);
    try { onSaved((await api.setGithubAccount(a.login, { name, email })).accounts); }
    catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      notifyLocal({ kind: "action_failed", repo: "", title: `GitHub · ${a.login}`, label: "Save identity failed", body: error, copy: `Action: Save identity for ${a.login}\nError:\n${error}`, ask: `Save identity for ${a.login} failed: ${error}. Please investigate and fix.` });
    } finally { setBusy(false); }
  };
  const reposText = a.repos.length ? a.repos.join(", ") : "no repos";
  return (
    <div data-slot="github-account" className="flex flex-col gap-3 px-4 py-3 text-sm md:grid md:grid-cols-[minmax(12rem,1fr)_auto] md:items-center md:gap-4">
      <div className="flex min-w-0 items-start gap-2.5 md:items-center">
        <AccountAvatar login={a.login} avatarUrl={a.avatarUrl} />
        <span className="min-w-0">
          <span className="flex items-center gap-2 font-medium">{a.login}{a.active && <Pill>active</Pill>}</span>
          <span className="text-muted-foreground block break-words text-xs md:truncate">
            commits as {a.name ?? "—"} &lt;{a.email ?? "—"}&gt;<span className="hidden md:inline"> · {reposText}</span>
          </span>
          <span className="text-muted-foreground mt-0.5 block text-xs md:hidden">{reposText}</span>
        </span>
      </div>
      <form className="flex flex-col gap-2 md:flex-row md:items-center" onSubmit={(e) => { e.preventDefault(); if (dirty) void save(); }}>
        <Input aria-label={`${a.login} name`} placeholder={a.name ?? "name"} value={name} onChange={(e) => setName(e.target.value)}
          className="bg-background h-10 md:h-8 md:w-36" />
        <Input aria-label={`${a.login} email`} placeholder={a.email ?? "email"} value={email} onChange={(e) => setEmail(e.target.value)} type="email"
          className="bg-background h-10 md:h-8 md:w-56" />
        <Button type="submit" variant="secondary" size="sm" disabled={!dirty || busy} className="h-10 w-full md:h-8 md:w-auto">Save</Button>
      </form>
    </div>
  );
}

/** Previews: every live preview across instances (Open / Stop), and Test master — a preview of each
 *  repo's base branch. The sidebar's Previews item carries the badges (running count, base preview). */
export function PreviewsPage() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Previews</h1>
      <div><SectionTitle>Running</SectionTitle><VCard slot="running-previews"><RunningPreviews /></VCard></div>
      <div><SectionTitle>Test master</SectionTitle><VCard slot="test-master"><TestMaster /></VCard></div>
    </div>
  );
}
