// Vercel's building blocks, in the Geist tokens (styles.css): a hairline card with a header row, a
// usage ring, a status dot, an environment-style pill, a details grid and a line chart. Every page
// of the console is assembled from these, so the look is decided in one place.
import { useState, type ReactNode } from "react";
import { Bot } from "lucide-react";
import { cn } from "@/lib/utils";
import { MERGE_CLASS_LABEL, niceMax, orchStatusText, sparklineSegments, timeTicks, usageZone, type OrchStatus } from "../workstream";

/** A card: hairline border, no shadow, a 48px header row with the title left and controls right. */
export function VCard({ title, aside, children, className, slot, bodyClass, onHeaderClick, expanded }: {
  title?: ReactNode; aside?: ReactNode; children: ReactNode; className?: string; slot?: string; bodyClass?: string;
  /** Makes the whole header row a toggle (Vercel's collapsible cards); `expanded` is its state. */
  onHeaderClick?: () => void; expanded?: boolean;
}) {
  const toggle = onHeaderClick ? {
    role: "button", tabIndex: 0, "aria-expanded": expanded, onClick: onHeaderClick,
    onKeyDown: (e: React.KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onHeaderClick(); } },
  } : {};
  return (
    <section data-slot={slot} className={cn("bg-card overflow-hidden rounded-lg border", className)}>
      {(title || aside) && (
        <header data-slot="card-header" {...toggle} className={cn("flex min-h-12 items-center justify-between gap-3 border-b px-4 py-2", onHeaderClick && "hover:bg-accent/40 cursor-pointer select-none")}>
          <h3 className="truncate text-sm font-medium">{title}</h3>
          {aside && <div className="flex shrink-0 items-center gap-2">{aside}</div>}
        </header>
      )}
      <div className={bodyClass}>{children}</div>
    </section>
  );
}

/** A section heading above a card, the way Vercel titles "Usage" / "Projects". */
export const SectionTitle = ({ children, aside }: { children: ReactNode; aside?: ReactNode }) => (
  <div className="mb-3 flex items-center justify-between gap-3">
    <h2 className="text-sm font-medium">{children}</h2>
    {aside}
  </div>
);

const ZONE_STROKE = { ok: "var(--geist-blue)", warn: "var(--geist-amber)", danger: "var(--geist-red)" } as const;

/** Vercel's usage ring: a thin circle filled to `pct`, blue until the caution zone. */
export function Ring({ pct, size = 16 }: { pct: number; size?: number }) {
  const r = 6.5, c = 2 * Math.PI * r, p = Math.max(0, Math.min(100, pct));
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} className="shrink-0 -rotate-90" aria-hidden="true">
      <circle cx="8" cy="8" r={r} fill="none" strokeWidth="2" className="stroke-border" />
      {p > 0 && <circle cx="8" cy="8" r={r} fill="none" strokeWidth="2" stroke={ZONE_STROKE[usageZone(p)]} strokeDasharray={`${(p / 100) * c} ${c}`} strokeLinecap="round" />}
    </svg>
  );
}

export type DotTone = "ready" | "error" | "warning" | "building" | "queued" | "neutral";
const DOT_CLASS: Record<DotTone, string> = {
  ready: "bg-geist-teal",
  error: "bg-geist-red",
  warning: "bg-geist-amber",
  building: "bg-geist-amber animate-pulse",
  queued: "bg-geist-blue",
  neutral: "bg-geist-gray",
};
/** Vercel's status dot: Ready teal, Error red, Building amber (pulsing), Queued blue, idle gray. */
export const StatusDot = ({ tone, className, title }: { tone: DotTone; className?: string; title?: string }) => (
  <span data-slot="status-dot" data-tone={tone} title={title} className={cn("inline-block size-2.5 shrink-0 rounded-full", DOT_CLASS[tone], className)} />
);

/** An environment-style pill (Production / Preview): rounded, hairline, an optional leading icon. */
export function Pill({ children, tone = "default", slot, title }: { children: ReactNode; tone?: "default" | "blue" | "green" | "amber" | "red"; slot?: string; title?: string }) {
  const tones = {
    default: "text-foreground border",
    blue: "border-transparent bg-geist-blue/15 text-geist-blue",
    green: "border-transparent bg-geist-green/15 text-geist-green",
    amber: "border-transparent bg-geist-amber/15 text-geist-warning-fg",
    red: "border-transparent bg-geist-red/15 text-geist-red",
  };
  return (
    <span data-slot={slot ?? "pill"} title={title} className={cn("inline-flex h-6 shrink-0 items-center gap-1 rounded-full px-2.5 text-xs font-medium whitespace-nowrap [&>svg]:size-3", tones[tone])}>
      {children}
    </span>
  );
}

/** The orchestrator's `orca status` for a workstream: its plan and what it waits on as one muted
 *  line, its merge class as a chip. `chipOnly` is the Agents row's fixed-height cell, where the line
 *  rides the chip's tooltip instead. Nothing when the orchestrator has set none. */
export function OrchStatusNote({ status, chipOnly, className }: { status?: OrchStatus; chipOnly?: boolean; className?: string }) {
  const text = orchStatusText(status);
  if (!status || !text) return null;
  const line = [status.plan, status.waitingOn && `waiting on ${status.waitingOn}`].filter(Boolean).join(" · ");
  if (chipOnly && !status.mergeClass && !line) return null;
  return (
    <div data-slot="orch-status" title={`Orchestrator — ${text}`} className={cn("text-muted-foreground flex min-w-0 items-center gap-1 text-xs", className)}>
      <Bot className="size-3 shrink-0" aria-hidden="true" />
      {!chipOnly && line && <span className="min-w-0 truncate">{line}</span>}
      {status.mergeClass && (
        <span data-slot="merge-class" className={cn("shrink-0 rounded px-1 text-[10px] leading-4 font-medium",
          status.mergeClass === "small" ? "bg-geist-green/15 text-geist-green" : "bg-geist-amber/15 text-geist-warning-fg")}>
          {MERGE_CLASS_LABEL[status.mergeClass]}
        </span>
      )}
    </div>
  );
}

/** A label over a value — the cells of Vercel's details grids ("Created", "Status", …). */
export const Detail = ({ label, children, slot }: { label: string; children: ReactNode; slot?: string }) => (
  <div data-slot={slot} className="min-w-0">
    <div className="text-muted-foreground mb-1 text-xs">{label}</div>
    <div className="flex min-w-0 items-center gap-1.5 text-sm">{children}</div>
  </div>
);

/** A filter / segmented chip — the "6h | 24h | 7d" range picker and the like. */
export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div role="group" aria-label={label} className="inline-flex h-7 items-center rounded-md border p-0.5">
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={value === o.value} onClick={() => onChange(o.value)}
          className={cn("h-full rounded-[5px] px-2 text-xs font-medium transition-colors", value === o.value ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground")}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** A line chart with a y-axis (0 → a round max), time ticks under it and a hover readout — Vercel's
 *  Observability graphs. Gaps in the samples (a box that was down) break the line. */
export function LineChart({ points, from, to, max, fmt, axis = fmt, label, slot, color = "var(--geist-blue)", height = 120, marks = [] }: {
  points: { at: number; v: number }[]; from: number; to: number; max?: number; fmt: (v: number) => string;
  /** The y-axis labels' format, when the readout's is too long for the gutter ("36G", not "36.0 GB"). */
  axis?: (v: number) => string;
  label: ReactNode; slot?: string; color?: string; height?: number;
  /** Events drawn as red vertical lines at their time (the Memory chart's OOM kills). */
  marks?: { at: number; title: string }[];
}) {
  const W = 600, H = height;
  const top = max ?? niceMax(Math.max(0, ...points.map((p) => p.v)) * 1.1);
  const [hover, setHover] = useState<{ at: number; v: number } | null>(null);
  const last = points[points.length - 1];
  const shown = hover ?? last;
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!points.length) return;
    const r = e.currentTarget.getBoundingClientRect();
    const at = from + ((e.clientX - r.left) / (r.width || W)) * (to - from);
    setHover(points.reduce((a, b) => (Math.abs(b.at - at) < Math.abs(a.at - at) ? b : a)));
  };
  const x = (at: number) => ((at - from) / Math.max(1, to - from)) * W;
  const gapMs = Math.max(5 * 60_000, (to - from) / 150);
  const segs = sparklineSegments(points, { from, to, max: top, w: W, h: H, gapMs });
  return (
    <figure data-slot={slot} className="min-w-0">
      <figcaption className="mb-2 flex items-baseline justify-between gap-2">
        <span className="text-muted-foreground flex min-w-0 items-baseline gap-1.5 text-xs whitespace-nowrap">{label}</span>
        <span data-slot="chart-value" className="text-sm font-medium whitespace-nowrap tabular-nums">
          {shown ? fmt(shown.v) : "—"}
          {hover && <span className="text-muted-foreground ml-1 text-xs font-normal">at {new Date(hover.at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}</span>}
        </span>
      </figcaption>
      <div className="flex gap-2">
        <div className="text-muted-foreground flex w-8 shrink-0 flex-col justify-between text-right font-mono text-[10px] whitespace-nowrap tabular-nums" style={{ height: H }}>
          <span className="-translate-y-1/2">{axis(top)}</span><span>{axis(top / 2)}</span><span className="translate-y-1/2">{axis(0)}</span>
        </div>
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ height: H }} className="w-full min-w-0 overflow-visible" role="img"
          aria-label={`${typeof label === "string" ? label : slot ?? "chart"}${last ? `, now ${fmt(last.v)}` : ", no samples"}`} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
          {[0, 0.5, 1].map((f) => <line key={f} x1={0} x2={W} y1={H * f} y2={H * f} className="stroke-border" strokeWidth={1} strokeDasharray={f === 1 ? undefined : "3 3"} vectorEffect="non-scaling-stroke" />)}
          {segs.map((pts, i) => <polyline key={i} points={pts} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />)}
          {marks.filter((m) => m.at >= from && m.at <= to).map((m) => (
            <line key={m.at} data-slot="chart-mark" x1={x(m.at)} x2={x(m.at)} y1={0} y2={H} stroke="var(--geist-red)" strokeWidth={1.5} vectorEffect="non-scaling-stroke"><title>{m.title}</title></line>
          ))}
          {hover && <line x1={x(hover.at)} x2={x(hover.at)} y1={0} y2={H} className="stroke-muted-foreground" strokeWidth={1} strokeDasharray="2 2" vectorEffect="non-scaling-stroke" />}
        </svg>
      </div>
      <div className="text-muted-foreground mt-1 flex justify-between pl-10 font-mono text-[10px]">
        {timeTicks(from, to, 4).map((t) => <span key={t.at}>{t.label}</span>)}
      </div>
    </figure>
  );
}

/** A loading placeholder — a shimmering block sized like whatever final content it stands in for,
 *  so a card doesn't shift when the real data lands. */
export const Skeleton = ({ className, slot }: { className?: string; slot?: string }) => (
  <div data-slot={slot ?? "skeleton"} aria-hidden="true" className={cn("bg-accent animate-pulse rounded-md", className)} />
);

/** A `LineChart`-shaped placeholder: label + value line, the chart block itself, and the tick row. */
export function ChartSkeleton({ slot }: { slot?: string }) {
  return (
    <div data-slot={slot ?? "chart-skeleton"} className="min-w-0">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <Skeleton className="h-3 w-16" />
        <Skeleton className="h-4 w-12" />
      </div>
      <Skeleton className="h-[120px] w-full" />
      <div className="mt-1 flex justify-between pl-10">
        {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-2.5 w-8" />)}
      </div>
    </div>
  );
}

/** A usage-row-shaped placeholder: ring + label + value. */
/** The Usage card's loading shape: one group (title + subtitle line), its three window rows
 *  (5-hour, weekly, Fable) and the "Show N logins" foot — the collapsed card's exact height. */
export const UsageSkeleton = () => (
  <div data-slot="usage-skeleton" className="p-2">
    <div className="mb-1">
      <div className="flex h-[26px] items-center justify-between gap-2 px-2 pt-1.5 pb-1">
        <Skeleton className="h-3 w-12" />
        <Skeleton className="h-3 w-28" />
      </div>
      <RowSkeleton /><RowSkeleton /><RowSkeleton />
    </div>
    <div className="flex h-7 items-center justify-center"><Skeleton className="h-3 w-24" /></div>
  </div>
);

export const RowSkeleton = ({ slot }: { slot?: string }) => (
  <div data-slot={slot ?? "row-skeleton"} className="flex h-9 items-center gap-2.5 rounded-md px-2">
    <Skeleton className="size-4 shrink-0 rounded-full" />
    <Skeleton className="h-3 flex-1" />
    <Skeleton className="h-3 w-10 shrink-0" />
  </div>
);

/** A `Stat` tile-shaped placeholder (Overview's Agents card numbers). */
export const StatSkeleton = ({ slot }: { slot?: string }) => (
  <div data-slot={slot ?? "stat-skeleton"} className="min-w-0 space-y-2 p-4">
    <Skeleton className="h-3 w-20" />
    <Skeleton className="h-7 w-10" />
    <Skeleton className="h-4 w-24" />
  </div>
);

/** The empty state inside a card (Vercel's centred icon + sentence). */
export const Empty = ({ children, icon }: { children: ReactNode; icon?: ReactNode }) => (
  <div className="text-muted-foreground flex flex-col items-center gap-3 px-6 py-10 text-center text-sm">
    {icon && <span className="rounded-full border p-2.5 [&>svg]:size-4">{icon}</span>}
    {children}
  </div>
);
