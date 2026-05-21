'use client';

import { useState, useEffect, useCallback, useRef } from 'react';

import { BriefingSection } from '@/components/briefing/section';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import {
  History,
  Sparkles,
  RefreshCw,
  Clock,
  Calendar,
  BookOpen,
  Mail,
  Loader2,
  Database,
  Zap,
  MessageSquare,
  FileText,
  AlertCircle,
  Plug,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { fetchWithTimeout } from '@/lib/fetch-timeout';
import Link from 'next/link';

interface UsageStats {
  docs: { total: number };
  connections: { total: number; by_status: { active: number; syncing: number; error: number } };
  queries: { total_messages: number; messages_7d: number; active_threads_7d: number };
  briefings: { this_month: number };
}

interface BriefingContent {
  calendar?: string;
  emails?: string;
  docs?: string;
  knowledge?: string;
  section_status?: Record<string, 'ok' | 'failed' | 'no_data'>;
  [key: string]: any;
}

interface Briefing {
  id: string;
  org_id: string;
  user_id: string;
  content: BriefingContent;
  summary: string;
  generated_at: string;
  calendar_items?: number;
  email_items?: number;
  doc_items?: number;
}

export default function BriefingPage() {
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [historyItemLoading, setHistoryItemLoading] = useState(false);
  const [briefing, setBriefing] = useState<Briefing | null>(null);
  const [history, setHistory] = useState<Briefing[]>([]);
  const [stats, setStats] = useState<UsageStats | null>(null);
  const [enqueuing, setEnqueuing] = useState(false);
  const [pollingTimedOut, setPollingTimedOut] = useState(false);
  const [historyError, setHistoryError] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [insufficientData, setInsufficientData] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Clean up polling on unmount
  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  // Fetch today's briefing — quiet mode skips the toast (used for polling)
  const fetchTodayBriefing = useCallback(async (quiet = false) => {
    try {
      const res = await fetchWithTimeout('/api/briefing?type=today');
      if (!res.ok) {
        if (!quiet) toast.error(`Failed to load briefing (${res.status})`);
        return null;
      }
      const data = await res.json();
      const result = data && !data.error ? (data as Briefing) : null;
      setBriefing(result);
      if (result) {
        setInsufficientData(false);
      }
      return result;
    } catch (err) {
      console.error('[briefing] fetch today failed:', err);
      if (!quiet) toast.error('An unexpected error occurred while loading briefing');
      return null;
    }
  }, []);

  const fetchHistory = useCallback(async () => {
    try {
      setHistoryError(false);
      const res = await fetchWithTimeout('/api/briefing?type=history');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      // Guard: data must be an array, not an error object
      setHistory(Array.isArray(data) ? data : []);
    } catch (err) {
      setHistory([]); // clear stale data so error banner is unambiguous
      setHistoryError(true);
      console.error('[briefing] fetch history failed:', err);
    }
  }, []);

  const fetchStats = useCallback(async () => {
    try {
      const res = await fetchWithTimeout('/api/admin/usage');
      if (res.ok) setStats(await res.json());
    } catch { /* non-admin users silently skip stats */ }
  }, []);

  // Initial load
  useEffect(() => {
    const init = async () => {
      setLoading(true);
      await Promise.all([fetchTodayBriefing(), fetchHistory(), fetchStats()]);
      setLoading(false);
    };
    init();
  }, [fetchTodayBriefing, fetchHistory, fetchStats]);

  // Manual refresh — spins the icon, refreshes both today + history
  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([fetchTodayBriefing(), fetchHistory()]);
    setRefreshing(false);
  }, [fetchTodayBriefing, fetchHistory]);

  // Click a history item: close sheet, load full content without full-page skeleton
  const handleHistoryItemClick = useCallback(async (item: Briefing) => {
    setSheetOpen(false);
    setHistoryItemLoading(true);
    try {
      const res = await fetchWithTimeout(`/api/briefing?id=${encodeURIComponent(item.id)}`);
      if (!res.ok) {
        toast.error(`Failed to load past briefing (${res.status})`);
        return;
      }
      const data = await res.json();
      if (data && !data.error) {
        setBriefing(data as Briefing);
        toast.success(`Viewing briefing from ${new Date(item.generated_at).toLocaleDateString()}`);
      } else {
        toast.error('Could not load that briefing');
      }
    } catch (err) {
      toast.error('Failed to load past briefing');
    } finally {
      setHistoryItemLoading(false);
    }
  }, []);

  // Generate / trigger synthesis — check res.ok BEFORE res.json(), then poll for result
  const handleGenerateNow = useCallback(async () => {
    setEnqueuing(true);
    setPollingTimedOut(false);
    try {
      const res = await fetchWithTimeout('/api/briefing', { method: 'POST', timeout: 30000 });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const errMsg = (data as any).error || `Failed to trigger synthesis (${res.status})`;
        toast.error(errMsg);
        if (res.status === 400 && errMsg.includes('Not enough data')) {
          setInsufficientData(true);
        }
        setEnqueuing(false);
        return;
      }

      toast.success('Synthesis started — polling for results…', {
        description: 'This page will update automatically when the briefing is ready.',
        icon: <Sparkles className="h-4 w-4 text-primary" />,
      });

      // Poll every 5 s for up to 90 s for the new briefing to appear
      let attempts = 0;
      const MAX_ATTEMPTS = 18; // 18 × 5s = 90s
      pollRef.current = setInterval(async () => {
        attempts++;
        const result = await fetchTodayBriefing(true /* quiet */);
        if (result) {
          // New briefing found — stop polling and refresh history
          if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
          setEnqueuing(false);
          await fetchHistory();
          toast.success('Briefing ready!');
        } else if (attempts >= MAX_ATTEMPTS) {
          if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
          setEnqueuing(false);
          setPollingTimedOut(true);
          toast.info('Synthesis is taking longer than expected. Try again below.');
        }
      }, 5_000);

    } catch (err) {
      toast.error('An unexpected error occurred');
      setEnqueuing(false);
    }
  }, [fetchTodayBriefing, fetchHistory]);

  if (loading) {
    return (
      <div className="max-w-5xl mx-auto space-y-12 py-10 px-6 animate-pulse">
        <div className="h-64 w-full rounded-[2.5rem] bg-muted/20 border border-white/5" />
        <div className="grid gap-8">
          <div className="h-80 w-full rounded-3xl bg-muted/10 border border-white/5" />
          <div className="h-80 w-full rounded-3xl bg-muted/10 border border-white/5" />
          <div className="h-80 w-full rounded-3xl bg-muted/10 border border-white/5" />
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto space-y-12 pb-20 animate-in fade-in slide-in-from-bottom-4 duration-1000 font-['Space_Grotesk'] transition-colors duration-300">
      {/* Page Header */}
      <header className="relative overflow-hidden rounded-[3.5rem] bg-card/50 border border-border p-10 lg:p-14 transition-all duration-500 hover:shadow-2xl hover:shadow-primary/5 group backdrop-blur-3xl">
        <div className="absolute top-0 right-0 w-[600px] h-[600px] bg-primary/10 blur-[140px] -z-10 translate-x-1/3 -translate-y-1/3 animate-pulse" />

        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-6 lg:gap-12 relative z-10">
          <div className="space-y-5 lg:space-y-8">
            <div className="flex flex-wrap items-center gap-2 sm:gap-3">
              <Badge variant="outline" className="bg-primary/10 text-primary border-primary/20 px-3 sm:px-5 py-1.5 sm:py-2 text-[10px] uppercase tracking-[0.4em] font-black rounded-xl">
                Cognitive Intelligence
              </Badge>
              {briefing && (
                <Badge variant="secondary" className="bg-accent/20 text-accent border-accent/20 px-3 sm:px-4 py-1.5 sm:py-2 text-[10px] uppercase tracking-[0.2em] font-black rounded-xl shadow-sm">
                  Active Session
                </Badge>
              )}
            </div>

            <div className="space-y-3">
              <h1 className="text-4xl sm:text-6xl lg:text-8xl font-black tracking-tighter leading-[0.85] uppercase">
                Morning <span className="text-primary">Briefing</span>
              </h1>
              <p className="text-muted-foreground text-xl max-w-xl leading-relaxed font-bold tracking-tight">
                {briefing
                  ? `Synthesized at ${new Date(briefing.generated_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`
                  : 'Athene is ready to synthesize your cross-platform updates into a high-density morning summary.'
                }
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-4 lg:gap-6">
            <div className="flex items-center gap-3 sm:gap-5 bg-muted/30 border border-border p-4 sm:p-6 rounded-[2rem] sm:rounded-[2.5rem] shadow-xl backdrop-blur-xl group/temporal hover:border-primary/20 transition-all">
              <div className="h-10 w-10 sm:h-14 sm:w-14 rounded-2xl bg-primary/10 flex items-center justify-center border border-primary/20 shadow-lg group-hover/temporal:scale-110 transition-transform">
                <Calendar className="h-5 w-5 sm:h-7 sm:w-7 text-primary" />
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-[0.3em] font-black text-muted-foreground/40 leading-none mb-1 sm:mb-2">Temporal Context</p>
                <p className="text-base sm:text-xl font-black text-foreground leading-none uppercase tracking-tighter">
                  {new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-3 sm:gap-4">
              {/* History Sheet */}
              <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
                <SheetTrigger asChild>
                  <Button variant="outline" size="icon" className="h-12 w-12 sm:h-16 sm:w-16 md:h-20 md:w-20 rounded-[1.5rem] md:rounded-[2rem] border-border bg-card/50 hover:bg-muted hover:border-primary/40 group shadow-2xl transition-all active:scale-95">
                    <History className="w-5 h-5 sm:w-6 sm:h-6 md:w-7 md:h-7 text-muted-foreground group-hover:text-primary group-hover:scale-110 transition-all duration-500" />
                  </Button>
                </SheetTrigger>
                <SheetContent side="right" className="w-[400px] sm:w-[540px] border-l border-border bg-card/90 backdrop-blur-3xl shadow-2xl font-['Space_Grotesk']">
                  <SheetHeader className="pb-10 border-b border-border">
                    <SheetTitle className="text-4xl font-black tracking-tighter flex items-center gap-4 uppercase">
                      <div className="p-3 bg-primary/10 rounded-2xl border border-primary/20">
                        <Clock className="w-8 h-8 text-primary" />
                      </div>
                      History
                    </SheetTitle>
                    <p className="text-muted-foreground text-sm font-bold uppercase tracking-widest opacity-60">Last 7 briefings</p>
                  </SheetHeader>
                  <div className="mt-10 space-y-6 overflow-y-auto max-h-[calc(100vh-220px)] pr-4 custom-scrollbar">
                    {historyError && (
                      <div className="p-8 rounded-3xl bg-destructive/5 border border-destructive/20 text-center space-y-4">
                        <p className="text-xs text-destructive font-black uppercase tracking-[0.2em]">Failed to load history</p>
                        <Button variant="outline" size="sm" onClick={fetchHistory} className="h-10 px-6 text-[10px] uppercase tracking-widest font-black rounded-xl border-destructive/20 hover:bg-destructive/10 hover:text-destructive">
                          Retry
                        </Button>
                      </div>
                    )}
                    {history.length > 0 ? (
                      history.map((item, i) => (
                        <div
                          key={item.id}
                          className={cn(
                            "group flex flex-col gap-4 p-6 rounded-[2.5rem] border transition-all duration-300 cursor-pointer animate-in fade-in slide-in-from-right-4 shadow-sm",
                            item.id === briefing?.id
                              ? "bg-primary/10 border-primary/40 shadow-xl shadow-primary/5"
                              : "bg-muted/10 border-border hover:bg-muted/30 hover:border-primary/20"
                          )}
                          style={{ animationDelay: `${i * 80}ms` }}
                          onClick={() => handleHistoryItemClick(item)}
                        >
                          <div className="flex items-center justify-between">
                            <span className="font-black text-lg tracking-tighter uppercase">
                              {new Date(item.generated_at).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}
                            </span>
                            <Badge variant={item.id === briefing?.id ? 'default' : 'outline'} className={cn(
                              "rounded-lg text-[9px] px-3 py-1 font-black uppercase tracking-widest",
                              item.id === briefing?.id ? "bg-primary text-primary-foreground border-none" : "border-border text-muted-foreground"
                            )}>
                              {item.id === briefing?.id ? 'Current' : 'Archive'}
                            </Badge>
                          </div>
                          {/* Only show summary if it's real content, otherwise nothing */}
                          {item.summary ? (
                            <p className="text-[13px] text-muted-foreground leading-relaxed line-clamp-2 font-bold">{item.summary}</p>
                          ) : null}
                          <div className="flex items-center gap-5 pt-2">
                            <div className="flex items-center gap-2 text-[10px] font-black text-muted-foreground/40 uppercase tracking-widest">
                              <Calendar className="w-3.5 h-3.5 text-primary" /> {item.calendar_items ?? 0} Events
                            </div>
                            <div className="flex items-center gap-2 text-[10px] font-black text-muted-foreground/40 uppercase tracking-widest">
                              <Mail className="w-3.5 h-3.5 text-secondary" /> {item.email_items ?? 0} Emails
                            </div>
                          </div>
                        </div>
                      ))
                    ) : !historyError ? (
                      <div className="flex flex-col items-center justify-center py-32 text-center space-y-6 opacity-30">
                        <div className="p-6 bg-muted rounded-[2rem] border border-border">
                          <BookOpen className="h-12 w-12 text-muted-foreground" />
                        </div>
                        <p className="text-xs font-black text-muted-foreground uppercase tracking-[0.3em]">No briefings yet</p>
                      </div>
                    ) : null}
                  </div>
                </SheetContent>
              </Sheet>

              {/* Refresh button */}
              <Button
                onClick={handleRefresh}
                variant="outline"
                size="icon"
                className="h-12 w-12 sm:h-16 sm:w-16 md:h-20 md:w-20 rounded-[1.5rem] md:rounded-[2rem] border-border bg-card/50 hover:bg-muted hover:border-primary/40 group shadow-2xl transition-all active:scale-95"
                disabled={refreshing || enqueuing || historyItemLoading}
                title={enqueuing ? "Synthesis in progress…" : "Refresh"}
              >
                <RefreshCw className={cn(
                  "w-5 h-5 sm:w-6 sm:h-6 md:w-7 md:h-7 text-muted-foreground group-hover:text-primary transition-all duration-700",
                  refreshing && "animate-spin text-primary"
                )} />
              </Button>
            </div>
          </div>
        </div>
      </header>

      {/* Dataset Overview Strip — only shown when admin stats are available */}
      {stats && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4 animate-in fade-in duration-700">
          {[
            {
              icon: <Database className="h-4 w-4 sm:h-5 sm:w-5 text-[#7AADCF]" />,
              label: 'Documents Indexed',
              value: stats.docs.total.toLocaleString(),
              sub: 'Total knowledge base',
            },
            {
              icon: <Zap className="h-4 w-4 sm:h-5 sm:w-5 text-[#D96FAB]" />,
              label: 'Active Feeds',
              value: stats.connections.by_status.active.toLocaleString(),
              sub: `${stats.connections.total} connectors total`,
            },
            {
              icon: <MessageSquare className="h-4 w-4 sm:h-5 sm:w-5 text-primary" />,
              label: 'Messages This Week',
              value: (stats.queries.messages_7d ?? 0).toLocaleString(),
              sub: `${stats.queries.active_threads_7d} active threads`,
            },
            {
              icon: <FileText className="h-4 w-4 sm:h-5 sm:w-5 text-accent" />,
              label: 'Briefings This Month',
              value: stats.briefings.this_month.toLocaleString(),
              sub: stats.briefings.this_month === 0 ? 'Generate your first briefing below' : 'Synthesized reports',
            },
          ].map(({ icon, label, value, sub }) => (
            <div key={label} className="flex flex-col gap-2 p-4 sm:p-5 rounded-[1.5rem] sm:rounded-[2rem] bg-card/50 border border-border hover:border-primary/20 transition-all group backdrop-blur-xl">
              <div className="flex items-center gap-2">
                {icon}
                <span className="text-[9px] sm:text-[10px] uppercase tracking-[0.25em] font-black text-muted-foreground/50">{label}</span>
              </div>
              <span className="text-2xl sm:text-3xl font-black text-foreground tracking-tighter">{value}</span>
              <span className="text-[10px] sm:text-[11px] text-muted-foreground/50 font-bold">{sub}</span>
            </div>
          ))}
        </div>
      )}

      {/* Loading overlay for history-item navigation — no full-page skeleton */}
      {historyItemLoading && (
        <div className="flex items-center justify-center gap-3 py-6 text-muted-foreground">
          <Loader2 className="w-5 h-5 animate-spin text-primary" />
          <span className="text-sm font-bold uppercase tracking-widest">Loading briefing…</span>
        </div>
      )}

      {!briefing ? (
        insufficientData ? (
          <Card className="p-24 flex flex-col items-center justify-center min-h-[500px] text-center space-y-12 border border-dashed border-amber-500/30 bg-amber-500/5 rounded-[3.5rem] group overflow-hidden relative backdrop-blur-xl shadow-2xl transition-all hover:border-amber-500/50">
            <div className="absolute inset-0 bg-gradient-to-br from-amber-500/5 via-transparent to-orange-500/5 opacity-100 transition-opacity duration-1000" />
            <div className="h-40 w-40 bg-amber-500/10 rounded-[3rem] flex items-center justify-center mb-4 transition-all duration-700 group-hover:scale-110 group-hover:rotate-6 border border-amber-500/20 shadow-2xl relative z-10">
              <AlertCircle className="h-20 w-20 text-amber-500 animate-pulse" />
            </div>
            <div className="space-y-5 relative z-10">
              <h3 className="text-4xl lg:text-5xl font-black tracking-tighter text-amber-500 leading-none uppercase">Insufficient Data</h3>
              <p className="text-muted-foreground text-xl max-w-lg mx-auto leading-relaxed font-bold tracking-tight">
                Not enough data to generate a briefing — connect more sources first.
              </p>
            </div>
            <Link href="/admin/integrations" passHref>
              <Button
                size="lg"
                className="h-20 px-16 rounded-[2.5rem] bg-amber-600 hover:bg-amber-500 text-white font-black uppercase tracking-[0.3em] text-[11px] gap-5 group relative z-10 shadow-2xl shadow-amber-500/20 transition-all active:scale-95 cursor-pointer"
              >
                <Plug className="w-6 h-6 group-hover:animate-bounce" /> Connect Sources
              </Button>
            </Link>
          </Card>
        ) : (
          <Card className="p-24 flex flex-col items-center justify-center min-h-[500px] text-center space-y-12 border-dashed border-border bg-card/30 rounded-[3.5rem] group overflow-hidden relative backdrop-blur-xl shadow-2xl transition-all hover:border-primary/20">
            <div className="absolute inset-0 bg-gradient-to-br from-primary/5 via-transparent to-secondary/5 opacity-0 group-hover:opacity-100 transition-opacity duration-1000" />
            <div className="h-40 w-40 bg-muted/50 rounded-[3rem] flex items-center justify-center mb-4 transition-all duration-700 group-hover:scale-110 group-hover:rotate-6 border border-border shadow-2xl relative z-10 group-hover:bg-primary/5 group-hover:border-primary/20">
              <Sparkles className="h-20 w-20 text-primary animate-pulse" />
            </div>
            <div className="space-y-5 relative z-10">
              <h3 className="text-4xl lg:text-6xl font-black tracking-tighter text-foreground leading-none uppercase">Synthesis Required</h3>
              <p className="text-muted-foreground text-xl max-w-lg mx-auto leading-relaxed font-bold tracking-tight">
                {enqueuing
                  ? "Agents are processing your data — this page will update automatically when ready."
                  : "No briefing for today yet. Trigger synthesis to process your connected sources."}
              </p>
            </div>
            <Button
              size="lg"
              className="h-20 px-16 rounded-[2.5rem] bg-primary hover:bg-primary/90 text-primary-foreground font-black uppercase tracking-[0.3em] text-[11px] gap-5 group relative z-10 shadow-2xl shadow-primary/20 transition-all active:scale-95"
              onClick={handleGenerateNow}
              disabled={enqueuing}
            >
              {enqueuing
                ? <><Loader2 className="w-5 h-5 animate-spin" /> Synthesizing…</>
                : <><Sparkles className="w-6 h-6 group-hover:animate-pulse" /> Trigger Neural Synthesis</>
              }
            </Button>
            {pollingTimedOut && !enqueuing && (
              <p className="text-xs text-muted-foreground font-bold uppercase tracking-widest relative z-10 opacity-70">
                Synthesis timed out after 90s — click above to try again
              </p>
            )}
          </Card>
        )
      ) : (
        <div className="grid gap-12 animate-in fade-in slide-in-from-bottom-8 duration-1000">
          <BriefingSection
            type="calendar"
            title="Calendar & Strategic Alignment"
            content={briefing.content?.calendar ?? ""}
            status={briefing.content?.section_status?.calendar}
            className="stagger-1"
          />
          <BriefingSection
            type="emails"
            title="High-Priority Communications"
            content={briefing.content?.emails ?? ""}
            status={briefing.content?.section_status?.emails}
            className="stagger-2"
          />
          <BriefingSection
            type="docs"
            title="Knowledge & Document Evolution"
            content={briefing.content?.docs ?? ""}
            status={briefing.content?.section_status?.docs}
            className="stagger-3"
          />
          {briefing.content?.knowledge && (
            <BriefingSection
              type="knowledge"
              title="Executive Summary"
              content={briefing.content.knowledge}
              status={briefing.content?.section_status?.knowledge}
              className="stagger-4"
            />
          )}
        </div>
      )}
    </div>
  );
}
