"use client";

// REFOCUS §6.1 — "My Work" blocker view: the user's open tickets/PRs
// with cross-source blocker chains from the knowledge graph.
// INFERRED / AMBIGUOUS edges are visually distinct — a guessed blocker
// is never presented as fact.

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
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

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

function blockedFor(iso: string | null): string | null {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  if (isNaN(ms) || ms < 0) return null;
  const days = Math.floor(ms / 86_400_000);
  if (days >= 1) return `${days}d`;
  const hours = Math.floor(ms / 3_600_000);
  return `${Math.max(hours, 1)}h`;
}

const PROVENANCE_STYLES: Record<BlockerCard["provenance"], string> = {
  EXTRACTED: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  INFERRED: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  AMBIGUOUS: "bg-red-500/10 text-red-600 dark:text-red-400",
};

function ProvenanceBadge({ provenance, confidence }: { provenance: BlockerCard["provenance"]; confidence: number }) {
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

export default function MyWorkPage() {
  const [data, setData] = useState<MyWorkResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/graph/my-work");
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      setData(await res.json());
    } catch (e: any) {
      setError(e?.message ?? "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const blocked = data?.items.filter((i) => i.blockers.length > 0) ?? [];
  const clear = data?.items.filter((i) => i.blockers.length === 0) ?? [];

  return (
    <div className="p-8 max-w-4xl mx-auto space-y-8">
      <div className="flex items-center gap-3">
        <div className="h-10 w-10 rounded-xl bg-primary/10 flex items-center justify-center">
          <Briefcase className="w-5 h-5 text-primary" />
        </div>
        <div>
          <h1 className="text-[19px] font-extrabold uppercase tracking-[-0.02em] text-foreground leading-none">
            My Work
          </h1>
          <p className="text-[10px] font-bold uppercase tracking-[0.28em] text-muted-foreground mt-1.5">
            Your open items and what&apos;s blocking them
          </p>
        </div>
      </div>

      {loading && (
        <div className="flex items-center justify-center py-24">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      )}

      {!loading && error && (
        <Card className="p-8 rounded-2xl border border-[var(--border-soft)] text-center space-y-3">
          <AlertCircle className="w-6 h-6 text-red-500 mx-auto" />
          <p className="text-[13px] text-muted-foreground">{error}</p>
          <Button variant="outline" size="sm" onClick={load}>
            Retry
          </Button>
        </Card>
      )}

      {!loading && !error && data && !data.person && (
        <Card className="p-10 rounded-2xl border border-[var(--border-soft)] text-center space-y-2">
          <p className="text-[14px] font-bold text-foreground">
            We couldn&apos;t find you in the knowledge graph yet.
          </p>
          <p className="text-[12px] text-muted-foreground">
            Once your connected tools sync items assigned to you, they&apos;ll appear here.
          </p>
        </Card>
      )}

      {!loading && !error && data?.person && data.items.length === 0 && (
        <Card className="p-10 rounded-2xl border border-[var(--border-soft)] text-center space-y-2">
          <p className="text-[14px] font-bold text-foreground">No open items found.</p>
          <p className="text-[12px] text-muted-foreground">
            Tickets and pull requests assigned to you will show up here after the next sync.
          </p>
        </Card>
      )}

      {!loading && !error && blocked.length > 0 && (
        <section className="space-y-4">
          <h2 className="text-[10px] font-extrabold uppercase tracking-[0.4em] text-muted-foreground/70">
            Blocked ({blocked.length})
          </h2>
          {blocked.map((item) => (
            <ItemCard key={item.node.id} item={item} />
          ))}
        </section>
      )}

      {!loading && !error && clear.length > 0 && (
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
  );
}
