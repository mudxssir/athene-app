"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Sparkles, Database, Search, Zap, ArrowRight, Brain } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { bootstrapOnboarding } from "@/app/onboarding/actions";

const FEATURES = [
  {
    icon: Database,
    title: "Unified Knowledge",
    desc: "Index every document, email, and message across all your tools.",
    color: "text-secondary",
    bg: "bg-secondary/10",
  },
  {
    icon: Search,
    title: "Instant Retrieval",
    desc: "Answer questions in seconds with hybrid semantic + graph search.",
    color: "text-primary",
    bg: "bg-primary/10",
  },
  {
    icon: Zap,
    title: "AI-Powered Actions",
    desc: "Draft emails, schedule meetings, and generate reports — all in chat.",
    color: "text-amber-400",
    bg: "bg-amber-400/10",
  },
];

export default function OnboardingWelcomePage() {
  const router = useRouter();

  useEffect(() => {
    // Silently bootstrap morning briefing + check connection count
    bootstrapOnboarding().catch(() => {});
  }, []);

  return (
    <div className="min-h-screen bg-[#06080c] text-white flex flex-col font-['Space_Grotesk'] overflow-hidden">
      {/* Background */}
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-full max-w-7xl h-[700px] bg-primary/3 -z-10 rounded-full opacity-60" />
      <div className="absolute bottom-0 left-0 w-96 h-96 bg-primary/3 -z-10 rounded-full" />

      {/* Progress Bar — step 1 of 4 */}
      <div className="h-1.5 w-full bg-white/5 fixed top-0 left-0 z-50">
        <div className="h-full bg-primary transition-all duration-1000" style={{ width: "25%" }} />
      </div>

      <main className="flex-1 container max-w-4xl mx-auto flex flex-col items-center justify-center p-6 pt-20 pb-16">

        {/* Hero */}
        <div className="w-full text-center space-y-6 mb-16 animate-in fade-in slide-in-from-bottom-8 duration-700">
          <div className="flex items-center justify-center mb-6">
            <div className="relative">
              <div className="absolute -inset-3 bg-secondary/20 rounded-3xl blur-xl" />
              <div className="relative w-20 h-20 rounded-3xl bg-primary/10 border border-white/10 flex items-center justify-center">
                <Brain className="w-10 h-10 text-secondary" />
              </div>
            </div>
          </div>

          <div className="flex items-center justify-center gap-2 mb-2">
            <Sparkles className="w-4 h-4 text-primary" />
            <span className="text-[10px] font-black uppercase tracking-[0.3em] text-primary">Step 1 of 4 — Welcome</span>
            <Sparkles className="w-4 h-4 text-primary" />
          </div>

          <h1 className="text-5xl md:text-6xl font-black tracking-tighter leading-none">
            Welcome to{" "}
            <span className="text-primary">
              Athene
            </span>
          </h1>

          <p className="text-slate-400 max-w-2xl mx-auto text-lg font-medium leading-relaxed">
            Your AI-powered knowledge layer. We'll connect your tools, index your knowledge, and get you answering questions in minutes.
          </p>
        </div>

        {/* Feature Cards */}
        <div className="w-full grid grid-cols-1 md:grid-cols-3 gap-5 mb-16 animate-in fade-in slide-in-from-bottom-10 duration-900 delay-150">
          {FEATURES.map((f) => (
            <div
              key={f.title}
              className="bg-white/3 backdrop-blur border border-white/8 rounded-3xl p-7 flex flex-col gap-4 hover:border-white/15 transition-all"
            >
              <div className={`w-11 h-11 rounded-2xl ${f.bg} flex items-center justify-center`}>
                <f.icon className={`w-5 h-5 ${f.color}`} />
              </div>
              <div>
                <h3 className="font-black text-sm mb-1">{f.title}</h3>
                <p className="text-slate-500 text-xs leading-relaxed">{f.desc}</p>
              </div>
            </div>
          ))}
        </div>

        {/* CTA */}
        <div className="flex flex-col items-center gap-4 animate-in fade-in duration-1000 delay-300">
          <Button
            asChild
            size="lg"
            className="h-16 px-12 rounded-2xl bg-primary text-white hover:bg-[var(--primary-hover)] font-black uppercase tracking-widest text-[11px] gap-3 shadow-[var(--shadow-3)] group"
          >
            <Link href="/onboarding/connections">
              Connect Your Sources
              <ArrowRight className="w-4 h-4 transition-transform group-hover:translate-x-1" />
            </Link>
          </Button>
          <Link
            href="/dashboard"
            className="text-[10px] font-black uppercase tracking-widest text-slate-600 hover:text-slate-400 transition-colors"
          >
            Skip setup — go to dashboard
          </Link>
        </div>
      </main>

      {/* Step indicator */}
      <div className="pb-8 flex items-center justify-center gap-2">
        {[1, 2, 3, 4].map((step) => (
          <div
            key={step}
            className={`rounded-full transition-all ${
              step === 1
                ? "w-6 h-2 bg-secondary"
                : "w-2 h-2 bg-white/10"
            }`}
          />
        ))}
      </div>
    </div>
  );
}
