import Link from "next/link"
import { Home, Search } from "lucide-react"

export default function NotFound() {
  return (
    <div className="flex flex-col items-center justify-center min-h-screen text-center space-y-8 px-6 bg-background text-foreground">
      <div className="space-y-2">
        <p className="text-[10px] font-mono uppercase tracking-[0.3em] text-primary">404</p>
        <h1 className="text-5xl font-black tracking-tight">Page not found</h1>
        <p className="text-muted-foreground text-lg max-w-sm leading-relaxed">
          This page does not exist or has been moved.
        </p>
      </div>

      <div className="flex items-center gap-4">
        <Link
          href="/dashboard"
          className="inline-flex items-center gap-2 h-12 px-8 rounded-2xl bg-primary hover:bg-primary/90 text-white font-black uppercase tracking-widest text-[11px] shadow-lg shadow-primary/20 transition-colors"
        >
          <Home className="w-4 h-4" />
          Go home
        </Link>
        <Link
          href="/chat"
          className="inline-flex items-center gap-2 h-12 px-8 rounded-2xl border border-white/10 font-bold uppercase tracking-widest text-[11px] hover:bg-white/5 transition-colors"
        >
          <Search className="w-4 h-4" />
          Ask Athene
        </Link>
      </div>
    </div>
  )
}
