"use client"

import { useEffect, useRef, useState } from "react"
import Link from "next/link"
import { cn } from "@/lib/utils"
import { ThemeToggle } from "@/components/theme-toggle"
import {
  ArrowRight, Brain, Globe, Lock, Network, Sparkles,
  Zap, Shield, BarChart3, MessageSquare, Database, Clock,
  ChevronRight, CheckCircle2,
} from "lucide-react"

// ─── Scroll-reveal ───────────────────────────────────────────────────────────

function useReveal(threshold = 0.12) {
  const ref = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const obs = new IntersectionObserver(
      ([e]) => { if (e.isIntersecting) { setVisible(true); obs.disconnect() } },
      { threshold },
    )
    obs.observe(el)
    return () => obs.disconnect()
  }, [threshold])
  return [ref, visible] as const
}

function Reveal({
  children, delay = 0, className = "", from = "bottom",
}: {
  children: React.ReactNode
  delay?: number
  className?: string
  from?: "bottom" | "left" | "right" | "scale"
}) {
  const [ref, visible] = useReveal()
  const hidden = {
    bottom: "opacity-0 translate-y-10",
    left: "opacity-0 -translate-x-10",
    right: "opacity-0 translate-x-10",
    scale: "opacity-0 scale-95",
  }[from]
  return (
    <div
      ref={ref}
      className={cn(
        "transition-all ease-out",
        visible ? "opacity-100 translate-y-0 translate-x-0 scale-100" : hidden,
        className,
      )}
      style={{ transitionDuration: "450ms", transitionDelay: visible ? `${delay}ms` : "0ms" }}
    >
      {children}
    </div>
  )
}

// ─── Data ────────────────────────────────────────────────────────────────────

const FEATURES = [
  { icon: Brain,        title: "Knowledge Graph",      tag: "Core",         desc: "Athene maps the relationships between people, projects, and decisions — automatically, from your actual data." },
  { icon: BarChart3,    title: "Cross-Dept Insights",  tag: "BI Mode",      desc: "Break data silos. Super-users can query across departments with audit-logged, role-gated access." },
  { icon: MessageSquare,title: "Synthesis Chat",       tag: "LLM",          desc: "Ask natural-language questions. Get grounded answers with inline citations pointing back to source documents." },
  { icon: Database,     title: "60+ Integrations",     tag: "Integrations", desc: "Slack, Notion, GitHub, Jira, Salesforce, HubSpot, Google Workspace — all indexed automatically." },
  { icon: Lock,         title: "BYOK Encryption",      tag: "Security",     desc: "Bring your own API keys, encrypted at rest with KMS. Your data never trains third-party models." },
  { icon: Clock,        title: "Morning Briefings",    tag: "Automation",   desc: "Automated daily digests tailored to each person's role, surfacing what actually matters to them." },
]

const STEPS = [
  { step: "01", icon: Globe,     title: "Connect your tools", desc: "OAuth-connect Slack, Notion, GitHub, Salesforce and 57 more in under 5 minutes. No API keys or engineering work required." },
  { step: "02", icon: Database,  title: "Automatic indexing", desc: "Athene fetches, chunks, and embeds your content into a 768-dimensional vector store. Knowledge graph built in parallel." },
  { step: "03", icon: Sparkles,  title: "Ask anything",       desc: "Multi-agent reasoning synthesizes cited answers from your indexed data. Every query is audited and role-gated." },
]

const INTEGRATIONS = [
  "Slack", "Google Drive", "Notion", "GitHub", "Jira", "Confluence",
  "HubSpot", "Salesforce", "Linear", "Zendesk", "Snowflake", "Dropbox",
  "Outlook", "Teams", "Airtable", "Asana", "Monday.com", "Intercom",
  "Figma", "Webflow",
]

const SECURITY = [
  { icon: Shield,       title: "SOC2 Compliant", desc: "Independently audited" },
  { icon: Lock,         title: "KMS Encryption", desc: "BYOK at rest and in transit" },
  { icon: CheckCircle2, title: "RLS-Gated",      desc: "Row-level org isolation" },
  { icon: Globe,        title: "Multi-tenant",   desc: "100% org data isolation" },
]

const STATS = [
  { value: "60+",  label: "Integrations" },
  { value: "768D", label: "Vector embeddings" },
  { value: "<2s",  label: "Query latency" },
  { value: "SOC2", label: "Compliant" },
]

// ─── Component ───────────────────────────────────────────────────────────────

export function LandingPage() {
  const [scrolled, setScrolled] = useState(false)

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24)
    window.addEventListener("scroll", onScroll, { passive: true })
    return () => window.removeEventListener("scroll", onScroll)
  }, [])

  return (
    <div className="min-h-screen bg-background text-foreground overflow-x-hidden font-['Space_Grotesk'] transition-colors duration-300">

      {/* Ambient orbs — subtle in light mode, glowing in dark */}
      <div className="pointer-events-none fixed inset-0 z-0 overflow-hidden opacity-70 dark:opacity-100">
        <div className="absolute -top-60 -left-60 w-[1000px] h-[800px] rounded-full"
          style={{ background: "radial-gradient(ellipse, rgba(217,112,51,0.09) 0%, transparent 65%)" }} />
        <div className="absolute -top-20 right-[-10%] w-[650px] h-[550px] rounded-full"
          style={{ background: "radial-gradient(ellipse, rgba(240,180,41,0.06) 0%, transparent 60%)" }} />
        <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-[1200px] h-[350px] rounded-full"
          style={{ background: "radial-gradient(ellipse, rgba(184,85,32,0.05) 0%, transparent 65%)" }} />
      </div>

      {/* ── Nav ────────────────────────────────────────────────────────── */}
      <nav className={cn(
        "fixed top-0 left-0 right-0 z-50 flex items-center justify-between px-8 lg:px-16 h-20 transition-all duration-500",
        scrolled
          ? "bg-background/92 backdrop-blur-2xl border-b border-border shadow-xl shadow-black/10"
          : "",
      )}>
        <Link href="/" className="flex items-center gap-4 group">
          <div className="w-10 h-10 rounded-xl bg-muted border border-border flex items-center justify-center shadow-sm group-hover:border-primary/40 group-hover:shadow-[0_0_16px_rgba(217,112,51,0.1)] transition-all duration-300">
            <img src="/logo.png" alt="Athene" className="w-6 h-6 object-contain" />
          </div>
          <span className="text-lg font-black tracking-tighter uppercase">
            Athene<span className="text-primary">AI</span>
          </span>
        </Link>

        <div className="hidden md:flex items-center gap-10 text-[11px] font-black uppercase tracking-[0.3em] text-muted-foreground">
          <Link href="#features"      className="hover:text-foreground transition-colors duration-200">Features</Link>
          <Link href="#how-it-works"  className="hover:text-foreground transition-colors duration-200">How It Works</Link>
          <Link href="#integrations"  className="hover:text-foreground transition-colors duration-200">Integrations</Link>
        </div>

        <div className="flex items-center gap-4">
          <ThemeToggle />
          <Link href="/sign-in" className="hidden sm:block text-[11px] font-black uppercase tracking-[0.3em] text-muted-foreground hover:text-foreground transition-colors duration-200">
            Sign In
          </Link>
          <Link
            href="/sign-up"
            className="h-11 px-7 rounded-2xl bg-primary text-white text-[11px] font-black uppercase tracking-[0.2em] hover:opacity-90 transition-all active:scale-95 flex items-center shadow-lg shadow-primary/20"
          >
            Get Started
          </Link>
        </div>
      </nav>

      {/* ── Hero ───────────────────────────────────────────────────────── */}
      <section className="relative min-h-screen flex flex-col items-center justify-center pt-24 pb-32 px-6">
        <div className="max-w-5xl w-full text-center space-y-10 animate-in fade-in slide-in-from-bottom-8 duration-500 relative z-10">

          <div className="inline-flex items-center gap-3 px-5 py-2.5 rounded-full border border-primary/20 bg-primary/5 text-primary text-[10px] font-black uppercase tracking-[0.42em]">
            <Sparkles className="w-3.5 h-3.5 animate-pulse" />
            Enterprise AI · Knowledge Orchestration
          </div>

          <h1 className="text-[3.8rem] sm:text-7xl md:text-8xl lg:text-[7.5rem] font-black tracking-tighter leading-[0.87] uppercase">
            Your organization&apos;s<br />
            intelligence,{" "}
            <span className="text-primary">unified.</span>
          </h1>

          <p className="text-lg md:text-xl text-muted-foreground max-w-2xl mx-auto leading-relaxed font-semibold tracking-tight">
            Athene connects every document, workflow, and tool your team uses — then places a multi-agent reasoning engine on top. Ask anything. Get answers grounded in your actual data.
          </p>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-5 pt-4">
            <Link
              href="/sign-up"
              className="relative group h-16 px-12 rounded-[2rem] bg-primary text-[11px] font-black uppercase tracking-widest flex items-center gap-4 transition-all active:scale-95 shadow-2xl shadow-primary/25 hover:opacity-90"
            >
              <span className="text-white">Start for free</span>
              <ArrowRight className="w-5 h-5 text-white group-hover:translate-x-1 transition-transform" />
            </Link>
            <Link
              href="/sign-in"
              className="h-16 px-12 rounded-[2rem] border border-border bg-muted/30 text-muted-foreground text-[11px] font-black uppercase tracking-widest flex items-center gap-4 hover:border-primary/40 hover:text-foreground hover:bg-muted/60 transition-all active:scale-95"
            >
              View demo
            </Link>
          </div>

          {/* App preview */}
          <div className="mt-16 relative mx-auto max-w-4xl">
            <div className="absolute -inset-4 rounded-[2.5rem] blur-3xl opacity-10 dark:opacity-15 bg-primary" />
            <div className="relative rounded-3xl border border-border bg-card overflow-hidden shadow-2xl dark:shadow-black/60">
              {/* Browser chrome */}
              <div className="flex items-center gap-3 px-6 py-4 border-b border-border bg-muted/30">
                <div className="flex gap-2">
                  {[0.4, 0.25, 0.15].map((o, i) => (
                    <div key={i} className="w-3 h-3 rounded-full" style={{ background: `rgba(200,130,60,${o})` }} />
                  ))}
                </div>
                <div className="flex-1 h-7 rounded-lg bg-muted/50 flex items-center px-4">
                  <span className="text-[10px] text-muted-foreground font-black uppercase tracking-widest">
                    app.atheneai.co / chat
                  </span>
                </div>
              </div>
              {/* Chat content */}
              <div className="p-8 space-y-6 min-h-[280px]">
                <div className="flex justify-end">
                  <div
                    className="max-w-sm px-6 py-4 rounded-2xl bg-primary text-[13px] font-semibold text-white leading-relaxed"
                  >
                    What&apos;s our Q1 renewal risk from enterprise customers?
                  </div>
                </div>
                <div className="flex gap-4 items-start">
                  <div className="w-9 h-9 rounded-xl bg-muted border border-border flex items-center justify-center shrink-0">
                    <img src="/logo.png" alt="A" className="w-5 h-5 object-contain" />
                  </div>
                  <div className="max-w-lg space-y-3">
                    <div className="px-6 py-5 rounded-2xl bg-muted/60 border border-border text-[13px] font-medium text-foreground/80 leading-relaxed">
                      Based on 847 indexed documents across Salesforce, Zendesk, and your internal CRM, I&apos;ve identified{" "}
                      <span className="text-secondary font-black">3 high-risk accounts</span>{" "}
                      with over $2.4M ARR at risk in Q1...
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {["Salesforce", "Zendesk", "CRM Data"].map(s => (
                        <span key={s} className="text-[9px] font-black uppercase tracking-widest px-3 py-1.5 rounded-lg border border-border bg-muted/40 text-muted-foreground">
                          {s}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Stats bar ──────────────────────────────────────────────────── */}
      <section className="relative z-10 py-16 border-y border-border bg-muted/20">
        <div className="max-w-5xl mx-auto px-6 grid grid-cols-2 md:grid-cols-4 gap-8">
          {STATS.map((stat, i) => (
            <Reveal key={stat.label} delay={i * 80} className="text-center">
              <div className="text-4xl font-black tracking-tighter text-primary">
                {stat.value}
              </div>
              <div className="text-[10px] font-black uppercase tracking-[0.38em] text-muted-foreground mt-2">
                {stat.label}
              </div>
            </Reveal>
          ))}
        </div>
      </section>

      {/* ── Features ───────────────────────────────────────────────────── */}
      <section id="features" className="relative z-10 py-32 px-6">
        <div className="max-w-6xl mx-auto space-y-20">

          <Reveal className="text-center space-y-6">
            <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-primary/20 bg-primary/5 text-primary text-[10px] font-black uppercase tracking-[0.4em]">
              <Zap className="w-3 h-3" />
              Capabilities
            </div>
            <h2 className="text-5xl md:text-7xl font-black tracking-tighter uppercase">
              Built for how<br />
              <span className="text-primary">teams actually work</span>
            </h2>
            <p className="text-muted-foreground text-lg font-semibold max-w-xl mx-auto leading-relaxed">
              Six tightly integrated capabilities that turn fragmented data into organizational intelligence.
            </p>
          </Reveal>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
            {FEATURES.map((f, i) => (
              <Reveal key={f.title} delay={i * 75}>
                <div className="h-full p-8 rounded-3xl border border-border bg-card hover:border-primary/30 hover:shadow-lg hover:shadow-primary/5 transition-all duration-300 group cursor-default space-y-5">
                  <div className="flex items-start justify-between">
                    <div className="p-4 rounded-2xl bg-primary/8 border border-primary/15 group-hover:bg-primary/12 group-hover:border-primary/25 transition-all duration-300">
                      <f.icon className="w-6 h-6 text-primary" />
                    </div>
                    <span className="text-[9px] font-black uppercase tracking-widest text-muted-foreground border border-border px-3 py-1.5 rounded-full">
                      {f.tag}
                    </span>
                  </div>
                  <div>
                    <h3 className="text-[15px] font-black tracking-tight text-foreground uppercase mb-3">{f.title}</h3>
                    <p className="text-muted-foreground text-sm font-semibold leading-relaxed">{f.desc}</p>
                  </div>
                  <div className="flex items-center gap-2 text-primary text-[10px] font-black uppercase tracking-widest opacity-0 group-hover:opacity-100 translate-y-1 group-hover:translate-y-0 transition-all duration-300">
                    <span>Learn more</span>
                    <ChevronRight className="w-3.5 h-3.5" />
                  </div>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ── How it works ───────────────────────────────────────────────── */}
      <section id="how-it-works" className="relative z-10 py-32 px-6 bg-muted/20 border-y border-border">
        <div className="max-w-5xl mx-auto space-y-20">

          <Reveal className="text-center space-y-6">
            <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-primary/20 bg-primary/5 text-primary text-[10px] font-black uppercase tracking-[0.4em]">
              <Network className="w-3 h-3" />
              Process
            </div>
            <h2 className="text-5xl md:text-7xl font-black tracking-tighter uppercase">
              Up and running<br />
              <span className="text-primary">in minutes</span>
            </h2>
          </Reveal>

          <div className="grid md:grid-cols-3 gap-10 relative">
            <div className="hidden md:block absolute top-12 left-[28%] right-[28%] h-px bg-border" />

            {STEPS.map((step, i) => (
              <Reveal key={step.step} delay={i * 160} className="relative">
                <div className="space-y-6 text-center flex flex-col items-center">
                  <div className="relative">
                    <div className="w-24 h-24 rounded-3xl flex items-center justify-center border border-border bg-card shadow-sm">
                      <step.icon className="w-10 h-10 text-primary" />
                    </div>
                    <div
                      className="absolute -top-3 -right-3 w-8 h-8 rounded-xl bg-primary flex items-center justify-center text-[10px] font-black text-white shadow-lg shadow-primary/20"
                    >
                      {step.step}
                    </div>
                  </div>
                  <div>
                    <h3 className="text-xl font-black uppercase tracking-tight text-foreground mb-3">{step.title}</h3>
                    <p className="text-muted-foreground font-semibold leading-relaxed text-sm">{step.desc}</p>
                  </div>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ── Integrations ───────────────────────────────────────────────── */}
      <section id="integrations" className="relative z-10 py-32 px-6">
        <div className="max-w-5xl mx-auto space-y-16">
          <Reveal className="text-center space-y-5">
            <h2 className="text-5xl md:text-6xl font-black tracking-tighter uppercase">
              Works with everything<br />
              <span className="text-primary">your team uses</span>
            </h2>
            <p className="text-muted-foreground font-semibold">60+ integrations. OAuth-powered. Continuously synced.</p>
          </Reveal>

          <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-3">
            {INTEGRATIONS.map((name, i) => (
              <Reveal key={name} delay={i * 28} from="scale">
                <div className="h-14 rounded-2xl border border-border bg-card hover:border-primary/35 hover:bg-muted/40 transition-all duration-200 flex items-center justify-center group cursor-default shadow-sm">
                  <span className="text-[10px] font-black uppercase tracking-wider text-muted-foreground group-hover:text-primary transition-colors px-2 text-center leading-tight">
                    {name}
                  </span>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ── Security strip ─────────────────────────────────────────────── */}
      <section className="relative z-10 py-24 px-6 bg-muted/20 border-y border-border">
        <div className="max-w-5xl mx-auto">
          <div className="grid md:grid-cols-4 gap-5">
            {SECURITY.map((item, i) => (
              <Reveal key={item.title} delay={i * 80}>
                <div className="flex items-start gap-4 p-6 rounded-2xl border border-border bg-card hover:border-primary/25 hover:shadow-sm transition-all duration-300 group">
                  <div className="p-3 rounded-xl bg-primary/8 border border-primary/15 shrink-0 group-hover:bg-primary/14 transition-colors">
                    <item.icon className="w-5 h-5 text-primary" />
                  </div>
                  <div>
                    <div className="text-[12px] font-black uppercase tracking-widest text-foreground mb-1">{item.title}</div>
                    <div className="text-[11px] text-muted-foreground font-semibold">{item.desc}</div>
                  </div>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ── CTA ────────────────────────────────────────────────────────── */}
      <section className="relative z-10 py-44 px-6 overflow-hidden">
        <div className="pointer-events-none absolute inset-0">
          <div className="absolute inset-0"
            style={{ background: "radial-gradient(ellipse 70% 55% at 50% 50%, rgba(217,112,51,0.07) 0%, transparent 70%)" }} />
        </div>

        <Reveal className="relative max-w-3xl mx-auto text-center space-y-10">
          <h2 className="text-6xl md:text-8xl font-black tracking-tighter uppercase leading-[0.87]">
            Ready to unify<br />
            <span className="text-primary">your intelligence?</span>
          </h2>
          <p className="text-muted-foreground text-lg font-semibold leading-relaxed">
            Join hundreds of organizations that have replaced scattered knowledge with a single reasoning layer.
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-5">
            <Link
              href="/sign-up"
              className="group h-16 px-12 rounded-[2rem] bg-primary text-[11px] font-black uppercase tracking-widest flex items-center gap-4 transition-all active:scale-95 shadow-2xl shadow-primary/30 hover:opacity-90"
            >
              <span className="text-white">Get started free</span>
              <ArrowRight className="w-5 h-5 text-white group-hover:translate-x-1 transition-transform" />
            </Link>
            <Link
              href="/sign-in"
              className="h-16 px-12 rounded-[2rem] border border-border bg-muted/30 text-muted-foreground text-[11px] font-black uppercase tracking-widest flex items-center gap-4 hover:border-primary/40 hover:text-foreground hover:bg-muted/60 transition-all active:scale-95"
            >
              Sign in
            </Link>
          </div>
        </Reveal>
      </section>

      {/* ── Footer ─────────────────────────────────────────────────────── */}
      <footer className="relative z-10 py-16 px-6 border-t border-border bg-muted/10">
        <div className="max-w-5xl mx-auto">
          <div className="flex flex-col md:flex-row items-center justify-between gap-8">
            <div className="flex items-center gap-4">
              <div className="w-9 h-9 rounded-xl bg-muted border border-border flex items-center justify-center">
                <img src="/logo.png" alt="A" className="w-5 h-5 object-contain" />
              </div>
              <span className="text-sm font-black uppercase tracking-wider">
                Athene<span className="text-primary">AI</span>
              </span>
            </div>

            <div className="flex flex-wrap justify-center gap-8 text-[10px] font-black uppercase tracking-[0.3em] text-muted-foreground">
              {["Features", "Integrations", "Security", "Pricing"].map(l => (
                <span key={l} className="cursor-default hover:text-foreground transition-colors">{l}</span>
              ))}
            </div>

            <div className="flex items-center gap-3 px-5 py-2.5 rounded-full border border-border bg-muted/20">
              <div className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse shadow-[0_0_8px_rgba(16,185,129,0.4)]" />
              <span className="text-[9px] font-black uppercase tracking-[0.42em] text-muted-foreground">Systems Operational</span>
            </div>
          </div>

          <div className="mt-12 pt-8 border-t border-border text-center">
            <p className="text-[10px] font-black uppercase tracking-[0.5em] text-muted-foreground opacity-50">
              © 2026 Athene AI Systems · All Rights Reserved
            </p>
          </div>
        </div>
      </footer>
    </div>
  )
}
