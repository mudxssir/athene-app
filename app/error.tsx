"use client"

import { useEffect } from "react"
import { AlertTriangle, RefreshCw, Home } from "lucide-react"
import Link from "next/link"

export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error("[Root error]", error)
  }, [error])

  return (
    <div className="flex flex-col items-center justify-center min-h-screen text-center space-y-8 px-6 bg-background text-foreground">
      <div className="relative">
        <div className="absolute -inset-8 bg-destructive/10 blur-3xl rounded-full" />
        <div className="relative h-24 w-24 bg-destructive/10 rounded-[2rem] border border-destructive/20 flex items-center justify-center">
          <AlertTriangle className="h-12 w-12 text-destructive" />
        </div>
      </div>

      <div className="space-y-3 max-w-md">
        <h1 className="text-3xl font-black tracking-tight">Something went wrong</h1>
        <p className="text-muted-foreground leading-relaxed">
          {error.message || "An unexpected error occurred. Your data is safe — please try again."}
        </p>
        {error.digest && (
          <p className="text-[10px] font-mono text-muted-foreground/40 uppercase tracking-widest mt-2">
            Ref: {error.digest}
          </p>
        )}
      </div>

      <div className="flex items-center gap-4">
        <button
          onClick={reset}
          className="inline-flex items-center gap-2 h-12 px-8 rounded-2xl bg-primary hover:bg-primary/90 text-white font-black uppercase tracking-widest text-[11px] shadow-lg shadow-primary/20 transition-colors"
        >
          <RefreshCw className="w-4 h-4" />
          Try again
        </button>
        <Link
          href="/dashboard"
          className="inline-flex items-center gap-2 h-12 px-8 rounded-2xl border border-white/10 font-bold uppercase tracking-widest text-[11px] hover:bg-white/5 transition-colors"
        >
          <Home className="w-4 h-4" />
          Dashboard
        </Link>
      </div>
    </div>
  )
}
