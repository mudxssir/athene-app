"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, ArrowRight, MessageSquare, Sparkles, Sun } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const NEXT_STEPS = [
  {
    icon: MessageSquare,
    title: "Ask Athene anything",
    desc: "Query your indexed knowledge in natural language.",
    href: "/chat",
    color: "text-secondary",
    bg: "bg-secondary/10 border-secondary/20",
  },
  {
    icon: Sun,
    title: "Read your morning briefing",
    desc: "Your daily AI-generated digest lands every morning at 7 AM.",
    href: "/briefing",
    color: "text-primary",
    bg: "bg-primary/10 border-primary/20",
  },
];

export default function OnboardingReadyPage() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setVisible(true), 100);
    return () => clearTimeout(t);
  }, []);

  return (
    <div className="min-h-screen bg-[#06080c] text-white flex flex-col font-['Space_Grotesk'] overflow-hidden">
      {/* Background */}
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-full max-w-7xl h-[600px] bg-primary/3 -z-10 rounded-full opacity-50" />
      <div className="absolute bottom-0 right-0 w-96 h-96 bg-primary/3 -z-10 rounded-full" />

      {/* Progress Bar — step 4 of 4 (complete) */}
      <div className="h-1.5 w-full bg-white/5 fixed top-0 left-0 z-50">
        <div className="h-full bg-primary transition-all duration-1000" style={{ width: "100%" }} />
      </div>

      <main className="flex-1 container max-w-2xl mx-auto flex flex-col items-center justify-center p-6 pt-20 pb-16">

        {/* Hero */}
        <div
          className={cn(
            "w-full text-center space-y-6 mb-12 transition-all duration-700",
            visible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4"
          )}
        >
          <div className="flex items-center justify-center mb-6">
            <div className="relative">
              <div className="absolute -inset-4 bg-emerald-400/20 rounded-full blur-xl animate-pulse" />
              <div className="relative w-24 h-24 rounded-full bg-emerald-400/10 border border-emerald-400/30 flex items-center justify-center">
                <CheckCircle2 className="w-12 h-12 text-emerald-400" />
              </div>
            </div>
          </div>

          <div className="flex items-center justify-center gap-2">
            <Sparkles className="w-4 h-4 text-primary" />
            <span className="text-[10px] font-black uppercase tracking-[0.3em] text-primary">Step 4 of 4 — Complete</span>
            <Sparkles className="w-4 h-4 text-primary" />
          </div>

          <h1 className="text-5xl md:text-6xl font-black tracking-tighter leading-none">
            You're all{" "}
            <span className="text-primary">
              set.
            </span>
          </h1>

          <p className="text-slate-400 max-w-xl mx-auto text-lg font-medium leading-relaxed">
            Athene has indexed your knowledge base. Your morning briefing will arrive daily at 7 AM once your sources finish syncing.
          </p>
        </div>

        {/* Next Steps */}
        <div
          className={cn(
            "w-full space-y-4 mb-12 transition-all duration-700 delay-200",
            visible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4"
          )}
        >
          {NEXT_STEPS.map((step) => (
            <Link
              key={step.href}
              href={step.href}
              className={cn(
                "flex items-center gap-5 p-5 rounded-2xl border transition-all hover:scale-[1.01]",
                step.bg
              )}
            >
              <div className={cn("w-11 h-11 rounded-xl bg-white/5 flex items-center justify-center shrink-0", step.bg)}>
                <step.icon className={cn("w-5 h-5", step.color)} />
              </div>
              <div className="flex-1">
                <p className="font-black text-sm">{step.title}</p>
                <p className="text-slate-500 text-xs mt-0.5">{step.desc}</p>
              </div>
              <ArrowRight className={cn("w-4 h-4 shrink-0", step.color)} />
            </Link>
          ))}
        </div>

        {/* Primary CTA */}
        <div
          className={cn(
            "transition-all duration-700 delay-400",
            visible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4"
          )}
        >
          <Button
            asChild
            size="lg"
            className="h-16 px-14 rounded-2xl bg-primary text-white hover:bg-[var(--primary-hover)] font-black uppercase tracking-widest text-[11px] gap-3 shadow-[var(--shadow-3)] group"
          >
            <Link href="/chat">
              Start Chatting
              <ArrowRight className="w-4 h-4 transition-transform group-hover:translate-x-1" />
            </Link>
          </Button>
        </div>
      </main>

      {/* Step indicator — all filled */}
      <div className="pb-8 flex items-center justify-center gap-2">
        {[1, 2, 3, 4].map((step) => (
          <div key={step} className="w-6 h-2 rounded-full bg-primary" />
        ))}
      </div>
    </div>
  );
}
