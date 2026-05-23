"use client";

import { TCard } from "@/components/ui/kit";
import { useState, useEffect, useCallback } from "react";
import {
  GitBranch,
  Search,
  Calendar,
  User,
  AlertCircle,
  ChevronRight,
  Clock,
  Loader2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type TemporalMetadata = {
  occurred_at?: string;
  decision_maker?: string;
  alternatives_considered?: string[];
  outcome?: string;
  confidence_of_date?: number;
};

type Decision = {
  id: string;
  label: string;
  description?: string | null;
  metadata?: TemporalMetadata | null;
  temporal_metadata?: TemporalMetadata | null; // alias kept for backward compat
  department_ids?: string[] | null;
  created_at: string;
};

type TimelineResult = {
  entity: string;
  decisions: Decision[];
};

const VIEWS = ["Timeline", "By Entity", "Search"] as const;
type View = (typeof VIEWS)[number];

function formatDate(isoString?: string): string {
  if (!isoString) return "Date unknown";
  try {
    return new Date(isoString).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return isoString;
  }
}

function DecisionCard({ decision }: { decision: Decision }) {
  const tm = decision.metadata ?? decision.temporal_metadata;
  return (
    <Card className="bg-white/5 backdrop-blur-xl border border-white/10 p-8 rounded-2xl space-y-4 hover:border-white/20 transition-all">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="h-9 w-9 rounded-xl bg-secondary/10 flex items-center justify-center shrink-0">
            <GitBranch className="w-4 h-4 text-secondary" />
          </div>
          <h3 className="text-[14px] font-bold text-white leading-snug">{decision.label}</h3>
        </div>
        <Badge className="bg-secondary/10 text-secondary border-none text-[9px] font-bold uppercase tracking-widest shrink-0 mt-0.5">
          Decision
        </Badge>
      </div>

      {decision.description && (
        <p className="text-[13px] text-slate-400 font-medium leading-relaxed pl-12">
          {decision.description}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-4 pl-12">
        {tm?.occurred_at && (
          <span className="flex items-center gap-1.5 text-[11px] font-bold text-slate-500 uppercase tracking-widest">
            <Calendar className="w-3.5 h-3.5" />
            {formatDate(tm.occurred_at)}
            {tm.confidence_of_date !== undefined && tm.confidence_of_date < 1 && (
              <span className="text-slate-600">(~{Math.round(tm.confidence_of_date * 100)}% confidence)</span>
            )}
          </span>
        )}
        {tm?.decision_maker && (
          <span className="flex items-center gap-1.5 text-[11px] font-bold text-slate-500 uppercase tracking-widest">
            <User className="w-3.5 h-3.5" />
            {tm.decision_maker}
          </span>
        )}
        {!tm?.occurred_at && (
          <span className="flex items-center gap-1.5 text-[11px] font-bold text-slate-600 uppercase tracking-widest">
            <Clock className="w-3.5 h-3.5" />
            Indexed {formatDate(decision.created_at)}
          </span>
        )}
      </div>

      {tm?.alternatives_considered && tm.alternatives_considered.length > 0 && (
        <div className="pl-12 flex flex-wrap gap-2">
          <span className="text-[10px] font-bold text-slate-600 uppercase tracking-widest self-center">
            Alternatives:
          </span>
          {tm.alternatives_considered.map((alt) => (
            <Badge
              key={alt}
              className="bg-white/5 text-slate-500 border-none text-[10px] font-bold"
            >
              {alt}
            </Badge>
          ))}
        </div>
      )}

      {tm?.outcome && (
        <div className="pl-12">
          <p className="text-[11px] text-slate-500 font-medium">
            <span className="font-bold text-slate-400 uppercase tracking-widest text-[9px]">Outcome: </span>
            {tm.outcome}
          </p>
        </div>
      )}
    </Card>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-24 gap-4">
      <GitBranch className="w-10 h-10 text-slate-600" />
      <p className="text-slate-500 text-[13px] font-bold uppercase tracking-widest">{message}</p>
    </div>
  );
}

export default function DecisionsPage() {
  const [view, setView] = useState<View>("Timeline");

  // Timeline state
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [timelineLoading, setTimelineLoading] = useState(true);
  const [timelineError, setTimelineError] = useState<string | null>(null);
  const [sinceFilter, setSinceFilter] = useState("");
  const [entityFilter, setEntityFilter] = useState("");

  // By-Entity state
  const [entityQuery, setEntityQuery] = useState("");
  const [timeline, setTimeline] = useState<TimelineResult | null>(null);
  const [timelineQuerying, setTimelineQuerying] = useState(false);
  const [timelineQueryError, setTimelineQueryError] = useState<string | null>(null);

  // Search state
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<Decision[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  // Defensive selectors for timeline view and entity queries
  const decisionsList = timeline && !Array.isArray(timeline) && Array.isArray(timeline.decisions)
    ? timeline.decisions
    : [];
  const entityName = timeline && !Array.isArray(timeline) ? timeline.entity : entityFilter || entityQuery;

  const fetchTimeline = useCallback(async () => {
    setTimelineLoading(true);
    setTimelineError(null);
    const params = new URLSearchParams({ limit: "50" });
    if (sinceFilter) params.set("since", sinceFilter);
    if (entityFilter) params.set("entity", entityFilter);
    try {
      const res = await fetch(`/api/graph/decisions?${params}`);
      if (!res.ok) throw new Error(`Server error ${res.status}`);
      setDecisions(await res.json());
    } catch (err: any) {
      setTimelineError(err.message ?? "Failed to load decisions");
    } finally {
      setTimelineLoading(false);
    }
  }, [sinceFilter, entityFilter]);

  useEffect(() => {
    if (view === "Timeline") fetchTimeline();
  }, [view, fetchTimeline]);

  const fetchEntityTimeline = async () => {
    if (!entityQuery.trim()) return;
    setTimelineQuerying(true);
    setTimelineQueryError(null);
    setTimeline(null);
    try {
      const res = await fetch(`/api/graph/timeline?entity=${encodeURIComponent(entityQuery.trim())}`);
      if (!res.ok) throw new Error(`Server error ${res.status}`);
      setTimeline(await res.json());
    } catch (err: any) {
      setTimelineQueryError(err.message ?? "Query failed");
    } finally {
      setTimelineQuerying(false);
    }
  };

  const fetchSearch = async () => {
    if (!searchQuery.trim()) return;
    setSearchLoading(true);
    setSearchError(null);
    try {
      const res = await fetch(
        `/api/graph/decisions?entity=${encodeURIComponent(searchQuery.trim())}&limit=50`
      );
      if (!res.ok) throw new Error(`Server error ${res.status}`);
      setSearchResults(await res.json());
    } catch (err: any) {
      setSearchError(err.message ?? "Search failed");
    } finally {
      setSearchLoading(false);
    }
  };

  return (
    <div className="max-w-5xl mx-auto space-y-10 pb-20">
      {/* Page Header */}
      <TCard i={0} as="section" className="flex flex-col gap-4 border-b border-border pb-10">
        <Badge className="bg-secondary/10 text-secondary border-none px-3 py-1 text-[10px] uppercase tracking-widest font-bold w-fit">
          Organizational Memory
        </Badge>
        <h1 className="text-4xl lg:text-5xl font-black tracking-tight text-white">
          Decision <span className="text-secondary">Timeline</span>
        </h1>
        <p className="text-slate-400 text-lg max-w-xl font-medium leading-relaxed">
          Every resolved choice extracted from your documents — who decided, when, and what alternatives were considered.
        </p>
      </TCard>

      {/* View switcher */}
      <div className="flex items-center gap-2 p-1.5 bg-white/5 rounded-2xl w-fit border border-white/10">
        {VIEWS.map((v) => (
          <button
            key={v}
            onClick={() => setView(v)}
            className={cn(
              "px-6 py-3 rounded-xl text-[11px] font-bold uppercase tracking-widest transition-all",
              view === v
                ? "bg-secondary text-white shadow-lg shadow-[var(--shadow-2)]"
                : "text-slate-400 hover:text-white hover:bg-white/5"
            )}
          >
            {v}
          </button>
        ))}
      </div>

      {/* ── Timeline view ─────────────────────────────────── */}
      {view === "Timeline" && (
        <div className="space-y-6">
          {/* Filters */}
          <div className="flex flex-wrap gap-4">
            <div className="flex items-center gap-2">
              <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Since</label>
              <Input
                type="date"
                value={sinceFilter}
                onChange={(e) => setSinceFilter(e.target.value)}
                className="h-10 w-44 bg-white/5 border-white/10 text-slate-300 text-[12px] rounded-xl"
              />
            </div>
            <div className="flex items-center gap-2">
              <label className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Entity</label>
              <Input
                placeholder="Filter by entity…"
                value={entityFilter}
                onChange={(e) => setEntityFilter(e.target.value)}
                className="h-10 w-48 bg-white/5 border-white/10 text-slate-300 text-[12px] rounded-xl placeholder:text-slate-600"
              />
            </div>
            <Button
              onClick={fetchTimeline}
              variant="outline"
              className="h-10 px-5 rounded-xl border-white/10 text-slate-300 text-[11px] font-bold uppercase tracking-widest hover:bg-white/5"
            >
              Apply
            </Button>
          </div>

          {timelineError && (
            <div className="flex items-center gap-3 bg-rose-500/10 border border-rose-500/20 rounded-2xl px-6 py-4">
              <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
              <p className="text-[13px] text-rose-300 flex-1">{timelineError}</p>
              <Button
                onClick={fetchTimeline}
                variant="outline"
                className="h-8 px-4 rounded-xl border-rose-500/30 text-rose-300 text-[10px] font-bold uppercase tracking-widest"
              >
                Retry
              </Button>
            </div>
          )}

          {timelineLoading ? (
            <div className="flex items-center justify-center py-20">
              <Loader2 className="w-6 h-6 text-secondary animate-spin" />
            </div>
          ) : decisions.length === 0 ? (
            <EmptyState message="No decisions indexed yet — connect document sources to begin extracting decisions" />
          ) : (
            <div className="space-y-4">
              {decisions.map((d) => (
                <DecisionCard key={d.id} decision={d} />
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── By Entity view ────────────────────────────────── */}
      {view === "By Entity" && (
        <div className="space-y-6">
          <div className="flex gap-3">
            <Input
              placeholder="Enter a project or service name…"
              value={entityQuery}
              onChange={(e) => setEntityQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && fetchEntityTimeline()}
              className="h-12 bg-white/5 border-white/10 text-slate-300 text-[13px] rounded-2xl placeholder:text-slate-600 flex-1"
            />
            <Button
              onClick={fetchEntityTimeline}
              disabled={!entityQuery.trim() || timelineQuerying}
              className="h-12 px-8 rounded-2xl bg-secondary text-white font-bold text-[11px] uppercase tracking-widest hover:bg-secondary/90 disabled:opacity-40"
            >
              {timelineQuerying ? <Loader2 className="w-4 h-4 animate-spin" /> : <ChevronRight className="w-4 h-4" />}
            </Button>
          </div>

          {timelineQueryError && (
            <div className="flex items-center gap-3 bg-rose-500/10 border border-rose-500/20 rounded-2xl px-6 py-4">
              <AlertCircle className="w-4 h-4 text-rose-400" />
              <p className="text-[13px] text-rose-300">{timelineQueryError}</p>
            </div>
          )}

          {timeline && (
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                <h2 className="text-[13px] font-bold text-slate-300 uppercase tracking-widest">
                  Decisions applied to
                </h2>
                <Badge className="bg-secondary/10 text-secondary border-none text-[12px] font-bold">
                  {entityName}
                </Badge>
                <span className="text-[11px] text-slate-600 font-bold">
                  {decisionsList.length} found
                </span>
              </div>
              {decisionsList.length === 0 ? (
                <EmptyState message="No decisions found for this entity" />
              ) : (
                decisionsList.map((d) => <DecisionCard key={d.id} decision={d} />)
              )}
            </div>
          )}

          {!timeline && !timelineQuerying && !timelineQueryError && (
            <EmptyState message="Enter a project or service name to see its decision history" />
          )}
        </div>
      )}

      {/* ── Search view ───────────────────────────────────── */}
      {view === "Search" && (
        <div className="space-y-6">
          <div className="flex gap-3">
            <div className="relative flex-1">
              <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
              <Input
                placeholder="Search decisions by keyword…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && fetchSearch()}
                className="h-12 pl-12 bg-white/5 border-white/10 text-slate-300 text-[13px] rounded-2xl placeholder:text-slate-600"
              />
            </div>
            <Button
              onClick={fetchSearch}
              disabled={!searchQuery.trim() || searchLoading}
              className="h-12 px-8 rounded-2xl bg-secondary text-white font-bold text-[11px] uppercase tracking-widest hover:bg-secondary/90 disabled:opacity-40"
            >
              {searchLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : "Search"}
            </Button>
          </div>

          {searchError && (
            <div className="flex items-center gap-3 bg-rose-500/10 border border-rose-500/20 rounded-2xl px-6 py-4">
              <AlertCircle className="w-4 h-4 text-rose-400" />
              <p className="text-[13px] text-rose-300">{searchError}</p>
            </div>
          )}

          {searchResults.length > 0 && (
            <div className="space-y-4">
              <p className="text-[11px] font-bold text-slate-500 uppercase tracking-widest">
                {searchResults.length} result{searchResults.length !== 1 ? "s" : ""}
              </p>
              {searchResults.map((d) => <DecisionCard key={d.id} decision={d} />)}
            </div>
          )}

          {searchResults.length === 0 && !searchLoading && searchQuery && !searchError && (
            <EmptyState message="No decisions matched your search" />
          )}

          {!searchQuery && (
            <EmptyState message="Type a keyword to search across all indexed decisions" />
          )}
        </div>
      )}
    </div>
  );
}
