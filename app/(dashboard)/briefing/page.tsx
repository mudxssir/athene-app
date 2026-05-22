'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { BriefingSection } from '@/components/briefing/section';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { History, Sparkles, RefreshCw, Calendar, BookOpen, Mail, Loader2, FileText, Database, Zap, MessageSquare, AlertCircle, Plug } from 'lucide-react';
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

/* ── Design-kit atoms ───────────────────────────────────── */

function IconTile({ icon: I, size = 44, tone = 'primary' }: { icon: React.ElementType; size?: number; tone?: 'primary' | 'amber' | 'honey' }) {
  const t = {
    primary: { bg: 'rgba(160,74,27,.10)', border: 'rgba(160,74,27,.20)', color: 'var(--primary)' },
    amber:   { bg: 'rgba(217,122,46,.12)', border: 'rgba(217,122,46,.22)', color: 'var(--secondary)' },
    honey:   { bg: 'rgba(230,185,40,.18)', border: 'rgba(230,185,40,.32)', color: '#9E780E' },
  }[tone];
  return (
    <div style={{ width: size, height: size, borderRadius: Math.round(size * 0.32), background: t.bg, border: `1px solid ${t.border}`, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: t.color, flexShrink: 0 }}>
      <I size={Math.round(size * 0.5)} strokeWidth={1.7} />
    </div>
  );
}

function Chip({ kind = 'outline', dot, children }: { kind?: 'primary' | 'amber' | 'honey' | 'outline'; dot?: boolean; children: React.ReactNode }) {
  const k = {
    primary: { background: 'rgba(160,74,27,.10)', color: 'var(--primary)', border: '1px solid rgba(160,74,27,.22)' },
    amber:   { background: 'rgba(217,122,46,.12)', color: 'var(--secondary)', border: '1px solid rgba(217,122,46,.22)' },
    honey:   { background: 'rgba(230,185,40,.18)', color: '#9E780E', border: '1px solid rgba(230,185,40,.32)' },
    outline: { background: 'transparent', color: 'var(--fg-muted)', border: '1px solid var(--border-strong)' },
  }[kind];
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 24, padding: '0 12px', borderRadius: 999, fontFamily: 'var(--font-sans)', fontWeight: 800, fontSize: 9, letterSpacing: '0.3em', textTransform: 'uppercase', ...k }}>
      {dot && <span style={{ width: 6, height: 6, borderRadius: 99, background: 'currentColor' }} />}
      {children}
    </span>
  );
}

/* ── Types ──────────────────────────────────────────────── */
interface Briefing { id: string; org_id: string; user_id: string; content: BriefingContent; summary: string; generated_at: string; calendar_items?: number; email_items?: number; doc_items?: number; }

/* ── Page ───────────────────────────────────────────────── */
export default function BriefingPage() {
  const [loading, setLoading]           = useState(true);
  const [refreshing, setRefreshing]     = useState(false);
  const [histItemLoading, setHIL]       = useState(false);
  const [briefing, setBriefing]         = useState<Briefing | null>(null);
  const [history, setHistory]           = useState<Briefing[]>([]);
  const [stats, setStats]               = useState<UsageStats | null>(null);
  const [enqueuing, setEnqueuing]       = useState(false);
  const [pollingTimedOut, setPTO]       = useState(false);
  const [historyError, setHistErr]      = useState(false);
  const [sheetOpen, setSheetOpen]       = useState(false);
  const [insufficientData, setInsufficientData] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  const fetchToday = useCallback(async (quiet = false) => {
    try {
      const res = await fetchWithTimeout('/api/briefing?type=today');
      if (!res.ok) { if (!quiet) toast.error(`Failed to load briefing (${res.status})`); return null; }
      const data = await res.json();
      const result = data && !data.error ? (data as Briefing) : null;
      setBriefing(result);
      if (result) {
        setInsufficientData(false);
      }
      return result;
    } catch (err) { if (!quiet) toast.error('An unexpected error occurred while loading briefing'); return null; }
  }, []);

  const fetchHistory = useCallback(async () => {
    try {
      setHistErr(false);
      const res = await fetchWithTimeout('/api/briefing?type=history');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setHistory(Array.isArray(data) ? data : []);
    } catch { setHistory([]); setHistErr(true); }
  }, []);

  const fetchStats = useCallback(async () => {
    try {
      const res = await fetchWithTimeout('/api/admin/usage');
      if (res.ok) setStats(await res.json());
    } catch { /* non-admin users silently skip stats */ }
  }, []);


  useEffect(() => {
    const init = async () => { setLoading(true); await Promise.all([fetchToday(), fetchHistory(), fetchStats()]); setLoading(false); };
    init();
  }, [fetchToday, fetchHistory]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([fetchToday(), fetchHistory()]);
    setRefreshing(false);
  }, [fetchToday, fetchHistory]);

  const handleHistoryItem = useCallback(async (item: Briefing) => {
    setSheetOpen(false); setHIL(true);
    try {
      const res = await fetchWithTimeout(`/api/briefing?id=${encodeURIComponent(item.id)}`);
      if (!res.ok) { toast.error(`Failed to load past briefing (${res.status})`); return; }
      const data = await res.json();
      if (data && !data.error) { setBriefing(data as Briefing); toast.success(`Viewing briefing from ${new Date(item.generated_at).toLocaleDateString()}`); }
      else toast.error('Could not load that briefing');
    } catch { toast.error('Failed to load past briefing'); } finally { setHIL(false); }
  }, []);

  const handleGenerate = useCallback(async () => {
    setEnqueuing(true); setPTO(false);
    try {
      const res = await fetchWithTimeout('/api/briefing', { method: 'POST', timeout: 30000 } as any);
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
      toast.success('Synthesis started — polling for results…', { icon: <Sparkles className="h-4 w-4 text-primary" /> });
      let attempts = 0;
      pollRef.current = setInterval(async () => {
        attempts++;
        const result = await fetchToday(true);
        if (result) {
          if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
          setEnqueuing(false);
          await fetchHistory();
          toast.success('Briefing ready!');
        } else if (attempts >= 18) {
          if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
          setEnqueuing(false); setPTO(true);
          toast.info('Synthesis is taking longer than expected. Try again below.');
        }
      }, 5_000);
    } catch { toast.error('An unexpected error occurred'); setEnqueuing(false); }
  }, [fetchToday, fetchHistory]);

  if (loading) {
    return (
      <div style={{ maxWidth: 980, margin: '0 auto', padding: '36px 40px' }}>
        {[280, 220, 220, 220].map((h, i) => (
          <div key={i} style={{ height: h, borderRadius: 32, background: 'var(--bg-muted)', opacity: 0.4, marginBottom: 24 }} />
        ))}
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 980, margin: '0 auto', padding: '36px 40px 80px' }}>

      {/* Hero header card — matches BriefingScreen */}
      <div className="reveal reveal-1" style={{ position: 'relative', overflow: 'hidden', borderRadius: 36, background: 'var(--bg-elevated)', border: '1px solid var(--border)', padding: '40px 48px', marginBottom: 32 }}>
        {/* Radial glow */}
        <div style={{ position: 'absolute', top: -120, right: -120, width: 480, height: 480, borderRadius: '50%', background: 'radial-gradient(ellipse, rgba(160,74,27,.10) 0%, transparent 65%)', pointerEvents: 'none' }} />

        <div style={{ position: 'relative', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 24, flexWrap: 'wrap' }}>
          <div>
            <div style={{ display: 'flex', gap: 8, marginBottom: 18 }}>
              <Chip kind="primary" dot>Cognitive intelligence</Chip>
              {briefing && <Chip kind="honey">Active session</Chip>}
            </div>
            <h1 style={{ fontFamily: 'var(--font-sans)', fontSize: 'clamp(48px,7vw,88px)', fontWeight: 800, letterSpacing: '-0.05em', textTransform: 'uppercase', lineHeight: 0.88, margin: '0 0 14px', color: 'var(--fg)' }}>
              Morning <span style={{ color: 'var(--primary)' }}>Briefing</span>
            </h1>
            <p style={{ color: 'var(--fg-muted)', fontSize: 16, fontWeight: 600, margin: 0, maxWidth: 460 }}>
              {briefing
                ? `Synthesized at ${new Date(briefing.generated_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`
                : 'Athene is ready to synthesize your cross-platform updates into a high-density morning summary.'}
            </p>
          </div>

          <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
            {/* Date widget */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, background: 'var(--bg-muted)', border: '1px solid var(--border)', padding: '14px 18px', borderRadius: 22 }}>
              <IconTile icon={Calendar} size={44} tone="primary" />
              <div>
                <div className="eyebrow" style={{ marginBottom: 4 }}>Temporal context</div>
                <div style={{ fontFamily: 'var(--font-sans)', fontSize: 18, fontWeight: 800, letterSpacing: '-0.02em', textTransform: 'uppercase', color: 'var(--fg)' }}>
                  {new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
                </div>
              </div>
            </div>

            {/* History */}
            <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
              <SheetTrigger asChild>
                <button style={{ width: 58, height: 58, borderRadius: 18, background: 'var(--bg-muted)', border: '1px solid var(--border)', color: 'var(--fg-muted)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', transition: 'all .2s var(--ease-out)' }}
                  onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--border-strong)'; (e.currentTarget as HTMLElement).style.color = 'var(--primary)'; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--border)'; (e.currentTarget as HTMLElement).style.color = 'var(--fg-muted)'; }}
                  title="History">
                  <History size={20} strokeWidth={1.7} />
                </button>
              </SheetTrigger>
              <SheetContent side="right" className="w-[400px] sm:w-[540px] bg-card border-l border-border">
                <SheetHeader className="pb-8 border-b border-border">
                  <SheetTitle style={{ fontFamily: 'var(--font-sans)', fontSize: 28, fontWeight: 800, letterSpacing: '-0.03em', textTransform: 'uppercase', display: 'flex', alignItems: 'center', gap: 14, color: 'var(--fg)' }}>
                    <IconTile icon={History} size={40} tone="primary" />History
                  </SheetTitle>
                  <p className="eyebrow" style={{ marginTop: 6 }}>Last 7 briefings</p>
                </SheetHeader>
                <div style={{ marginTop: 24, display: 'flex', flexDirection: 'column', gap: 12, overflowY: 'auto', maxHeight: 'calc(100vh - 200px)', paddingRight: 4 }} className="custom-scrollbar">
                  {historyError && (
                    <div style={{ padding: 24, borderRadius: 24, background: 'rgba(178,58,26,.06)', border: '1px solid rgba(178,58,26,.2)', textAlign: 'center' }}>
                      <p style={{ fontSize: 12, color: 'var(--danger)', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.2em' }}>Failed to load history</p>
                      <button onClick={fetchHistory} style={{ marginTop: 12, padding: '6px 16px', borderRadius: 10, border: '1px solid rgba(178,58,26,.25)', background: 'transparent', color: 'var(--danger)', fontSize: 10, fontWeight: 800, letterSpacing: '0.2em', textTransform: 'uppercase', cursor: 'pointer' }}>Retry</button>
                    </div>
                  )}
                  {history.length > 0 ? history.map((item) => (
                    <div key={item.id} onClick={() => handleHistoryItem(item)}
                      style={{ padding: '18px 20px', borderRadius: 24, border: `1px solid ${item.id === briefing?.id ? 'rgba(160,74,27,.4)' : 'var(--border)'}`, background: item.id === briefing?.id ? 'rgba(160,74,27,.06)' : 'var(--bg-muted)', cursor: 'pointer', transition: 'all .2s var(--ease-out)' }}
                      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--border-strong)'; }}
                      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = item.id === briefing?.id ? 'rgba(160,74,27,.4)' : 'var(--border)'; }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                        <span style={{ fontSize: 14, fontWeight: 800, letterSpacing: '-0.01em', textTransform: 'uppercase', color: 'var(--fg)' }}>
                          {new Date(item.generated_at).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}
                        </span>
                        {item.id === briefing?.id && <Chip kind="primary">Current</Chip>}
                      </div>
                      {item.summary && <p style={{ fontSize: 12, color: 'var(--fg-muted)', fontWeight: 500, lineHeight: 1.5, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', margin: 0 }}>{item.summary}</p>}
                      <div style={{ display: 'flex', gap: 16, marginTop: 10 }}>
                        <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10, fontWeight: 700, letterSpacing: '0.2em', textTransform: 'uppercase', color: 'var(--fg-subtle)' }}>
                          <Calendar size={11} style={{ color: 'var(--primary)' }} />{item.calendar_items ?? 0} events
                        </span>
                        <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10, fontWeight: 700, letterSpacing: '0.2em', textTransform: 'uppercase', color: 'var(--fg-subtle)' }}>
                          <Mail size={11} style={{ color: 'var(--secondary)' }} />{item.email_items ?? 0} emails
                        </span>
                      </div>
                    </div>
                  )) : !historyError ? (
                    <div style={{ padding: '64px 0', textAlign: 'center', opacity: 0.4 }}>
                      <IconTile icon={BookOpen} size={48} tone="primary" />
                      <p className="eyebrow" style={{ marginTop: 16 }}>No briefings yet</p>
                    </div>
                  ) : null}
                </div>
              </SheetContent>
            </Sheet>

            {/* Refresh */}
            <button onClick={handleRefresh} disabled={refreshing || enqueuing || histItemLoading}
              style={{ width: 58, height: 58, borderRadius: 18, background: 'var(--bg-muted)', border: '1px solid var(--border)', color: 'var(--fg-muted)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', transition: 'all .2s var(--ease-out)' }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = 'rgba(160,74,27,.4)'; (e.currentTarget as HTMLElement).style.color = 'var(--primary)'; }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--border)'; (e.currentTarget as HTMLElement).style.color = 'var(--fg-muted)'; }}>
              <RefreshCw size={20} strokeWidth={1.7} style={{ animation: refreshing ? 'spin 1s linear infinite' : 'none' }} />
            </button>

            {/* Trigger synthesis */}
            <button onClick={handleGenerate} disabled={enqueuing}
              style={{ height: 58, padding: '0 28px', borderRadius: 18, background: 'var(--primary)', color: '#fff', border: 'none', fontFamily: 'var(--font-sans)', fontSize: 11, fontWeight: 800, letterSpacing: '0.28em', textTransform: 'uppercase', display: 'inline-flex', alignItems: 'center', gap: 10, cursor: 'pointer', boxShadow: '0 14px 30px -10px rgba(160,74,27,.55)', transition: 'all .15s var(--ease-out)' }}
              onMouseDown={e => { (e.currentTarget as HTMLElement).style.transform = 'translateY(1px)'; }}
              onMouseUp={e => { (e.currentTarget as HTMLElement).style.transform = 'translateY(0)'; }}>
              {enqueuing ? <><Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} />Synthesizing…</> : <><Sparkles size={16} />{briefing ? 'Refresh' : 'Trigger synthesis'}</>}
            </button>
          </div>
        </div>
      </div>

      {/* Dataset Overview Strip — only shown when admin stats are available */}
      {stats && (
        <div className="reveal reveal-2" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14, marginBottom: 28 }}>
          {[
            { icon: Database,      label: 'Documents Indexed',    value: stats.docs.total.toLocaleString(),                      sub: 'Total knowledge base',                        tone: 'primary' as const },
            { icon: Zap,           label: 'Active Feeds',         value: stats.connections.by_status.active.toLocaleString(),    sub: `${stats.connections.total} connectors total`, tone: 'amber' as const },
            { icon: MessageSquare, label: 'Messages This Week',   value: (stats.queries.messages_7d ?? 0).toLocaleString(),      sub: `${stats.queries.active_threads_7d} active threads`, tone: 'honey' as const },
            { icon: FileText,      label: 'Briefings This Month', value: stats.briefings.this_month.toLocaleString(),            sub: stats.briefings.this_month === 0 ? 'Generate your first below' : 'Synthesized reports', tone: 'primary' as const },
          ].map(({ icon: I, label, value, sub, tone }) => (
            <div key={label} style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 22, padding: '18px 20px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
                <IconTile icon={I} size={32} tone={tone} />
                <span style={{ fontSize: 9, fontWeight: 800, letterSpacing: '0.25em', textTransform: 'uppercase', color: 'var(--fg-muted)' }}>{label}</span>
              </div>
              <div style={{ fontFamily: 'var(--font-sans)', fontSize: 28, fontWeight: 800, letterSpacing: '-0.04em', color: 'var(--fg)', marginBottom: 4 }}>{value}</div>
              <div style={{ fontSize: 10, color: 'var(--fg-subtle)', fontWeight: 700 }}>{sub}</div>
            </div>
          ))}
        </div>
      )}

      {histItemLoading && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '16px 0', color: 'var(--fg-muted)' }}>
          <Loader2 size={16} style={{ animation: 'spin 1s linear infinite', color: 'var(--primary)' }} />
          <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.2em', textTransform: 'uppercase' }}>Loading briefing…</span>
        </div>
      )}

      {/* Content */}
      {!briefing ? (
        insufficientData ? (
          <div className="reveal reveal-2" style={{ padding: '64px 40px', textAlign: 'center', border: '1px dashed rgba(245,158,11,.3)', borderRadius: 36, background: 'rgba(245,158,11,.04)' }}>
            <IconTile icon={AlertCircle} size={80} tone="amber" />
            <h3 style={{ fontFamily: 'var(--font-sans)', fontSize: 36, fontWeight: 800, letterSpacing: '-0.04em', textTransform: 'uppercase', marginTop: 24, color: 'var(--secondary)' }}>Insufficient Data</h3>
            <p style={{ color: 'var(--fg-muted)', fontSize: 15, fontWeight: 600, maxWidth: 440, margin: '14px auto 28px' }}>
              Not enough data to generate a briefing — connect more sources first.
            </p>
            <Link href="/admin/integrations">
              <button style={{ height: 58, padding: '0 30px', borderRadius: 18, background: 'var(--secondary)', border: 'none', color: '#fff', fontFamily: 'var(--font-sans)', fontSize: 11, fontWeight: 800, letterSpacing: '0.28em', textTransform: 'uppercase', display: 'inline-flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
                <Plug size={16} />Connect Sources
              </button>
            </Link>
          </div>
        ) : (
          <div className="reveal reveal-2" style={{ padding: '64px 40px', textAlign: 'center', border: '1px dashed var(--border-strong)', borderRadius: 36, background: 'var(--bg-elevated)' }}>
            <IconTile icon={Sparkles} size={80} tone="primary" />
            <h3 style={{ fontFamily: 'var(--font-sans)', fontSize: 36, fontWeight: 800, letterSpacing: '-0.04em', textTransform: 'uppercase', marginTop: 24, color: 'var(--fg)' }}>Synthesis required</h3>
            <p style={{ color: 'var(--fg-muted)', fontSize: 15, fontWeight: 600, maxWidth: 440, margin: '14px auto 28px' }}>
              {enqueuing ? 'Agents are processing your data — this page will update automatically when ready.' : 'No briefing for today yet. Trigger synthesis to process your connected sources.'}
            </p>
            {pollingTimedOut && !enqueuing && (
              <p style={{ fontSize: 11, color: 'var(--fg-muted)', fontWeight: 700, letterSpacing: '0.2em', textTransform: 'uppercase', marginBottom: 20 }}>
                Synthesis timed out — try again
              </p>
            )}
            <button onClick={handleGenerate} disabled={enqueuing}
              style={{ height: 58, padding: '0 30px', borderRadius: 18, background: 'var(--primary)', border: 'none', color: '#fff', fontFamily: 'var(--font-sans)', fontSize: 11, fontWeight: 800, letterSpacing: '0.28em', textTransform: 'uppercase', display: 'inline-flex', alignItems: 'center', gap: 10, cursor: 'pointer', boxShadow: '0 14px 30px -10px rgba(160,74,27,.55)' }}>
              {enqueuing ? <><Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} />Synthesizing…</> : <><Sparkles size={16} />Trigger neural synthesis</>}
            </button>
          </div>
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

      <style>{`@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}`}</style>
    </div>
  );
}
