"use client";

// REFOCUS §6.1 + §6.2 — My Work: open item blocker chains + personal obligations.
// INFERRED / AMBIGUOUS edges are visually distinct — never presented as fact.

import { useState, useEffect, useCallback } from "react";
import {
  Briefcase,
  ExternalLink,
  User,
  Clock,
  Loader2,
  AlertCircle,
  ShieldQuestion,
  CircleCheck,
  GitPullRequest,
  Ticket,
  ArrowUpRight,
  CalendarClock,
  TriangleAlert,
  Bell,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { WatchlistCreate } from "@/components/watchlists/watchlist-create";

// ── §6.1 types ────────────────────────────────────────────────────────────────

type GraphNode = {
  id: string;
  label: string;
  entity_type: string;
  description?: string | null;
  metadata?: Record<string, unknown>;
};

type BlockerSource = {
  documentId: string;
  title: string | null;
  url: string | null;
  sourceType: string | null;
};

type BlockerCard = {
  node: GraphNode;
  relation: string;
  provenance: "EXTRACTED" | "INFERRED" | "AMBIGUOUS";
  confidence: number;
  blockedSince: string | null;
  owner: { id: string; label: string } | null;
  source: BlockerSource | null;
  upstream: BlockerCard[];
};

type MyWorkItem = {
  node: GraphNode;
  url: string | null;
  blockers: BlockerCard[];
};

type MyWorkResult = {
  person: GraphNode | null;
  items: MyWorkItem[];
};

// ── §6.2 types ────────────────────────────────────────────────────────────────

type ObligationSource = {
  documentId: string;
  title: string | null;
  url: string | null;
  sourceType: string | null;
};

type ObligationItem = {
  node: GraphNode;
  dueDate: string | null;
  status: string | null;
  actor: string | null;
  isOverdue: boolean;
  source: ObligationSource | null;
};

type MyObligationsResult = {
  person: GraphNode | null;
  items: ObligationItem[];
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function blockedFor(iso: string | null): string | null {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  if (isNaN(ms) || ms < 0) return null;
  const days = Math.floor(ms / 86_400_000);
  if (days >= 1) return `${days}d`;
  const hours = Math.floor(ms / 3_600_000);
  return `${Math.max(hours, 1)}h`;
}

function formatDue(iso: string | null): { label: string; overdue: boolean } | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const now = new Date();
  const diff = d.getTime() - now.getTime();
  const overdue = diff < 0;
  const abs = Math.abs(diff);
  const days = Math.floor(abs / 86_400_000);
  if (days === 0) return { label: overdue ? "Due today (overdue)" : "Due today", overdue };
  if (days === 1) return { label: overdue ? "1d overdue" : "Due tomorrow", overdue };
  if (days < 7) return { label: overdue ? `${days}d overdue` : `Due in ${days}d`, overdue };
  return {
    label: overdue
      ? `${Math.floor(days / 7)}w overdue`
      : `Due ${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`,
    overdue,
  };
}

// ── §6.1 components ───────────────────────────────────────────────────────────

const PROVENANCE_STYLES: Record<BlockerCard["provenance"], string> = {
  EXTRACTED: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  INFERRED: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  AMBIGUOUS: "bg-red-500/10 text-red-600 dark:text-red-400",
};

function ProvenanceBadge({
  provenance,
  confidence,
}: {
  provenance: BlockerCard["provenance"];
  confidence: number;
}) {
  const label =
    provenance === "EXTRACTED"
      ? "Stated in source"
      : provenance === "INFERRED"
        ? `Inferred · ${Math.round(confidence * 100)}%`
        : `Ambiguous · ${Math.round(confidence * 100)}%`;
  return (
    <Badge
      className={cn(
        "border-none text-[9px] font-bold uppercase tracking-widest shrink-0",
        PROVENANCE_STYLES[provenance]
      )}
    >
      {provenance !== "EXTRACTED" && <ShieldQuestion className="w-3 h-3 mr-1" />}
      {label}
    </Badge>
  );
}

function RelationLabel({ relation }: { relation: string }) {
  const text = relation === "DEPENDS_ON" ? "Depends on" : "Blocked by";
  return (
    <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
      {text}
    </span>
  );
}

function BlockerRow({ blocker, depth = 0 }: { blocker: BlockerCard; depth?: number }) {
  const uncertain = blocker.provenance !== "EXTRACTED";
  const duration = blockedFor(blocker.blockedSince);
  return (
    <div className={cn(depth > 0 && "ml-6 mt-2")}>
      <div
        className={cn(
          "rounded-[14px] border p-4 space-y-2",
          uncertain
            ? "border-dashed border-amber-500/40 bg-amber-500/[0.04]"
            : "border-[var(--border-soft)] bg-[var(--bg-muted)]"
        )}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <RelationLabel relation={blocker.relation} />
            <span className="text-[13px] font-bold text-foreground truncate">
              {uncertain ? `Possibly: ${blocker.node.label}` : blocker.node.label}
            </span>
          </div>
          <ProvenanceBadge provenance={blocker.provenance} confidence={blocker.confidence} />
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <span className="flex items-center gap-1.5 text-[11px] font-bold text-muted-foreground uppercase tracking-widest">
            <User className="w-3.5 h-3.5" />
            {blocker.owner ? blocker.owner.label : "Owner unknown"}
          </span>
          {duration && (
            <span className="flex items-center gap-1.5 text-[11px] font-bold text-muted-foreground uppercase tracking-widest">
              <Clock className="w-3.5 h-3.5" />
              Blocked {duration}
            </span>
          )}
          {blocker.source?.url ? (
            <a
              href={blocker.source.url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 text-[11px] font-bold text-primary uppercase tracking-widest hover:underline"
            >
              <ExternalLink className="w-3.5 h-3.5" />
              {blocker.source.sourceType ?? "Source"}
            </a>
          ) : blocker.source?.title ? (
            <span className="flex items-center gap-1.5 text-[11px] font-bold text-muted-foreground uppercase tracking-widest truncate max-w-[240px]">
              <ExternalLink className="w-3.5 h-3.5 shrink-0" />
              {blocker.source.title}
            </span>
          ) : null}
        </div>
      </div>
      {blocker.upstream.map((u) => (
        <BlockerRow key={`${blocker.node.id}-${u.node.id}`} blocker={u} depth={depth + 1} />
      ))}
    </div>
  );
}

function ItemCard({ item }: { item: MyWorkItem }) {
  const Icon = item.node.entity_type === "pull_request" ? GitPullRequest : Ticket;
  return (
    <Card className="p-6 rounded-2xl border border-[var(--border-soft)] bg-card space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <div className="h-9 w-9 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
            <Icon className="w-4 h-4 text-primary" />
          </div>
          <div className="min-w-0">
            <h3 className="text-[14px] font-bold text-foreground leading-snug truncate">
              {item.node.label}
            </h3>
            {item.node.description && (
              <p className="text-[12px] text-muted-foreground truncate mt-0.5">
                {item.node.description}
              </p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Badge className="bg-primary/10 text-primary border-none text-[9px] font-bold uppercase tracking-widest">
            {item.node.entity_type === "pull_request" ? "PR" : "Ticket"}
          </Badge>
          <WatchlistCreate
            initialName={`Watch: ${item.node.label}`}
            initialQuery={`What is the current status of "${item.node.label}"? Are there any new blockers or updates?`}
            trigger={
              <span title="Watch this item" aria-label="Watch this item">
                <Bell className="w-4 h-4 text-muted-foreground hover:text-primary transition-colors cursor-pointer" />
              </span>
            }
          />
          {item.url && (
            <a href={item.url} target="_blank" rel="noopener noreferrer" aria-label="Open in source">
              <ArrowUpRight className="w-4 h-4 text-muted-foreground hover:text-foreground" />
            </a>
          )}
        </div>
      </div>
      {item.blockers.length > 0 ? (
        <div className="space-y-3">
          {item.blockers.map((b) => (
            <BlockerRow key={b.node.id} blocker={b} />
          ))}
        </div>
      ) : (
        <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-widest text-muted-foreground">
          <CircleCheck className="w-3.5 h-3.5 text-emerald-500" />
          No known blockers
        </div>
      )}
    </Card>
  );
}

// ── §6.2 components ───────────────────────────────────────────────────────────

function ObligationCard({ item }: { item: ObligationItem }) {
  const due = formatDue(item.dueDate);
  return (
    <Card
      className={cn(
        "p-5 rounded-2xl border bg-card space-y-3",
        item.isOverdue
          ? "border-red-500/30 bg-red-500/[0.03]"
          : "border-[var(--border-soft)]"
      )}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <div
            className={cn(
              "h-8 w-8 rounded-xl flex items-center justify-center shrink-0",
              item.isOverdue ? "bg-red-500/10" : "bg-primary/10"
            )}
          >
            {item.isOverdue ? (
              <TriangleAlert className="w-4 h-4 text-red-500" />
            ) : (
              <CalendarClock className="w-4 h-4 text-primary" />
            )}
          </div>
          <div className="min-w-0">
            <h3 className="text-[14px] font-bold text-foreground leading-snug truncate">
              {item.node.label}
            </h3>
            {item.node.description && (
              <p className="text-[12px] text-muted-foreground truncate mt-0.5">
                {item.node.description}
              </p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {due && (
            <Badge
              className={cn(
                "border-none text-[9px] font-bold uppercase tracking-widest",
                due.overdue
                  ? "bg-red-500/10 text-red-600 dark:text-red-400"
                  : "bg-amber-500/10 text-amber-600 dark:text-amber-400"
              )}
            >
              {due.label}
            </Badge>
          )}
          <WatchlistCreate
            initialName={`Watch: ${item.node.label}`}
            initialQuery={`What is the current status of the obligation "${item.node.label}"? Has there been any progress or updates?`}
            trigger={
              <span title="Watch this obligation" aria-label="Watch this obligation">
                <Bell className="w-4 h-4 text-muted-foreground hover:text-primary transition-colors cursor-pointer" />
              </span>
            }
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-4">
        {item.actor && (
          <span className="flex items-center gap-1.5 text-[11px] font-bold text-muted-foreground uppercase tracking-widest">
            <User className="w-3.5 h-3.5" />
            {item.actor}
          </span>
        )}
        {item.status && (
          <span className="text-[11px] font-bold text-muted-foreground uppercase tracking-widest">
            {item.status}
          </span>
        )}
        {item.source?.url ? (
          <a
            href={item.source.url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 text-[11px] font-bold text-primary uppercase tracking-widest hover:underline"
          >
            <ExternalLink className="w-3.5 h-3.5" />
            {item.source.sourceType ?? "Source"}
          </a>
        ) : item.source?.title ? (
          <span className="flex items-center gap-1.5 text-[11px] font-bold text-muted-foreground uppercase tracking-widest truncate max-w-[240px]">
            <ExternalLink className="w-3.5 h-3.5 shrink-0" />
            {item.source.title}
          </span>
        ) : null}
      </div>
    </Card>
  );
}

// ── Tabs ──────────────────────────────────────────────────────────────────────

type Tab = "work" | "obligations";

// ── Page ──────────────────────────────────────────────────────────────────────

export default function MyWorkPage() {
  const [tab, setTab] = useState<Tab>("work");

  const [workData, setWorkData] = useState<MyWorkResult | null>(null);
  const [workLoading, setWorkLoading] = useState(true);
  const [workError, setWorkError] = useState<string | null>(null);

  const [obData, setObData] = useState<MyObligationsResult | null>(null);
  const [obLoading, setObLoading] = useState(true);
  const [obError, setObError] = useState<string | null>(null);

  const loadWork = useCallback(async () => {
    setWorkLoading(true);
    setWorkError(null);
    try {
      const res = await fetch("/api/graph/my-work");
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      setWorkData(await res.json());
    } catch (e: any) {
      setWorkError(e?.message ?? "Failed to load");
    } finally {
      setWorkLoading(false);
    }
  }, []);

  const loadObligations = useCallback(async () => {
    setObLoading(true);
    setObError(null);
    try {
      const res = await fetch("/api/graph/my-obligations");
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      setObData(await res.json());
    } catch (e: any) {
      setObError(e?.message ?? "Failed to load");
    } finally {
      setObLoading(false);
    }
  }, []);

  useEffect(() => {
    loadWork();
    loadObligations();
  }, [loadWork, loadObligations]);

  const blocked = workData?.items.filter((i) => i.blockers.length > 0) ?? [];
  const clear = workData?.items.filter((i) => i.blockers.length === 0) ?? [];
  const overdueObs = obData?.items.filter((i) => i.isOverdue) ?? [];
  const upcomingObs = obData?.items.filter((i) => !i.isOverdue) ?? [];

  const obBadge = overdueObs.length > 0 ? overdueObs.length : obData?.items.length ?? 0;

  return (
    <div className="p-8 max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="h-10 w-10 rounded-xl bg-primary/10 flex items-center justify-center">
          <Briefcase className="w-5 h-5 text-primary" />
        </div>
        <div>
          <h1 className="text-[19px] font-extrabold uppercase tracking-[-0.02em] text-foreground leading-none">
            My Work
          </h1>
          <p className="text-[10px] font-bold uppercase tracking-[0.28em] text-muted-foreground mt-1.5">
            Your open items, blockers, and obligations
          </p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 p-1 rounded-[14px] bg-muted/50 border border-[var(--border-soft)] w-fit">
        {(
          [
            {
              key: "work" as Tab,
              label: "Open Items",
              badge: blocked.length > 0 ? blocked.length : null,
            },
            {
              key: "obligations" as Tab,
              label: "Obligations",
              badge: overdueObs.length > 0 ? overdueObs.length : null,
              badgeRed: overdueObs.length > 0,
            },
          ] as Array<{ key: Tab; label: string; badge: number | null; badgeRed?: boolean }>
        ).map(({ key, label, badge, badgeRed }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={cn(
              "relative flex items-center gap-2 px-4 py-2 rounded-[10px] text-[11px] font-extrabold uppercase tracking-[0.18em] transition-all duration-150",
              tab === key
                ? "bg-card text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {label}
            {badge !== null && (
              <span
                className={cn(
                  "inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-[9px] font-bold",
                  badgeRed
                    ? "bg-red-500/15 text-red-600 dark:text-red-400"
                    : "bg-primary/15 text-primary"
                )}
              >
                {badge}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* ── Open Items tab ── */}
      {tab === "work" && (
        <div className="space-y-8">
          {workLoading && (
            <div className="flex items-center justify-center py-24">
              <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
            </div>
          )}
          {!workLoading && workError && (
            <Card className="p-8 rounded-2xl border border-[var(--border-soft)] text-center space-y-3">
              <AlertCircle className="w-6 h-6 text-red-500 mx-auto" />
              <p className="text-[13px] text-muted-foreground">{workError}</p>
              <Button variant="outline" size="sm" onClick={loadWork}>Retry</Button>
            </Card>
          )}
          {!workLoading && !workError && workData && !workData.person && (
            <Card className="p-10 rounded-2xl border border-[var(--border-soft)] text-center space-y-2">
              <p className="text-[14px] font-bold text-foreground">
                We couldn&apos;t find you in the knowledge graph yet.
              </p>
              <p className="text-[12px] text-muted-foreground">
                Once your connected tools sync items assigned to you, they&apos;ll appear here.
              </p>
            </Card>
          )}
          {!workLoading && !workError && workData?.person && workData.items.length === 0 && (
            <Card className="p-10 rounded-2xl border border-[var(--border-soft)] text-center space-y-2">
              <p className="text-[14px] font-bold text-foreground">No open items found.</p>
              <p className="text-[12px] text-muted-foreground">
                Tickets and pull requests assigned to you will show up here after the next sync.
              </p>
            </Card>
          )}
          {!workLoading && !workError && blocked.length > 0 && (
            <section className="space-y-4">
              <h2 className="text-[10px] font-extrabold uppercase tracking-[0.4em] text-muted-foreground/70">
                Blocked ({blocked.length})
              </h2>
              {blocked.map((item) => (
                <ItemCard key={item.node.id} item={item} />
              ))}
            </section>
          )}
          {!workLoading && !workError && clear.length > 0 && (
            <section className="space-y-4">
              <h2 className="text-[10px] font-extrabold uppercase tracking-[0.4em] text-muted-foreground/70">
                Moving freely ({clear.length})
              </h2>
              {clear.map((item) => (
                <ItemCard key={item.node.id} item={item} />
              ))}
            </section>
          )}
        </div>
      )}

      {/* ── Obligations tab ── */}
      {tab === "obligations" && (
        <div className="space-y-8">
          {obLoading && (
            <div className="flex items-center justify-center py-24">
              <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
            </div>
          )}
          {!obLoading && obError && (
            <Card className="p-8 rounded-2xl border border-[var(--border-soft)] text-center space-y-3">
              <AlertCircle className="w-6 h-6 text-red-500 mx-auto" />
              <p className="text-[13px] text-muted-foreground">{obError}</p>
              <Button variant="outline" size="sm" onClick={loadObligations}>Retry</Button>
            </Card>
          )}
          {!obLoading && !obError && obData && !obData.person && (
            <Card className="p-10 rounded-2xl border border-[var(--border-soft)] text-center space-y-2">
              <p className="text-[14px] font-bold text-foreground">
                We couldn&apos;t find you in the knowledge graph yet.
              </p>
              <p className="text-[12px] text-muted-foreground">
                Obligations linked to your name will appear here once sources sync.
              </p>
            </Card>
          )}
          {!obLoading && !obError && obData?.person && obData.items.length === 0 && (
            <Card className="p-10 rounded-2xl border border-[var(--border-soft)] text-center space-y-2">
              <p className="text-[14px] font-bold text-foreground">No open obligations found.</p>
              <p className="text-[12px] text-muted-foreground">
                Commitments, deadlines, and regulatory requirements extracted from your documents will appear here.
              </p>
            </Card>
          )}
          {!obLoading && !obError && overdueObs.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-[10px] font-extrabold uppercase tracking-[0.4em] text-red-500/70">
                Overdue ({overdueObs.length})
              </h2>
              {overdueObs.map((item) => (
                <ObligationCard key={item.node.id} item={item} />
              ))}
            </section>
          )}
          {!obLoading && !obError && upcomingObs.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-[10px] font-extrabold uppercase tracking-[0.4em] text-muted-foreground/70">
                Upcoming ({upcomingObs.length})
              </h2>
              {upcomingObs.map((item) => (
                <ObligationCard key={item.node.id} item={item} />
              ))}
            </section>
          )}
        </div>
      )}
    </div>
  );
}
