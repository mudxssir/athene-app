// ============================================================
// components/integrations/oauth-connect-button.tsx
//
// Shared OAuth connect button that uses nango.auth() instead of
// nango.openConnectUI(). Opens the provider's OAuth consent screen
// directly (Google, Microsoft, Slack, etc.) — no Nango catalog modal.
//
// ISOLATION: This component is not imported anywhere yet. To wire
// it in, replace the handleConnect logic in:
//   - app/onboarding/connections/page.tsx
//   - app/(dashboard)/admin/integrations/page.tsx
//
// Usage:
//   <OAuthConnectButton
//     provider={getProvider("google_drive")}
//     onConnected={(connectionId) => { ... }}
//   />
// ============================================================

"use client"

import { useState, useCallback } from "react"
import { Loader2, Plus, CheckCircle2, AlertCircle, RefreshCw } from "lucide-react"
import Nango from "@nangohq/frontend"
import { Button } from "@/components/ui/button"
import type { ProviderConfig } from "@/lib/integrations/providers"
import { cn } from "@/lib/utils"

// ---- Types ─────────────────────────────────────────────────

export interface OAuthConnectButtonProps {
  /** Provider configuration from PROVIDER_REGISTRY */
  provider: ProviderConfig
  /** Called after successful OAuth + connection save */
  onConnected?: (connectionId: string, provider: ProviderConfig) => void
  /** Called when an error occurs */
  onError?: (error: string, provider: ProviderConfig) => void
  /** Whether the provider is already connected */
  isConnected?: boolean
  /** Custom button className */
  className?: string
  /** Disable the button (e.g., another connection in progress) */
  disabled?: boolean
  /** Button size variant */
  size?: "sm" | "default" | "lg"
  /** Visual variant */
  variant?: "default" | "outline" | "minimal"
}

type ConnectionStatus = "idle" | "connecting" | "saving" | "connected" | "error"

// ---- Component ─────────────────────────────────────────────

export function OAuthConnectButton({
  provider,
  onConnected,
  onError,
  isConnected = false,
  className,
  disabled = false,
  size = "default",
  variant = "default",
}: OAuthConnectButtonProps) {
  const [status, setStatus] = useState<ConnectionStatus>(
    isConnected ? "connected" : "idle"
  )
  const [error, setError] = useState<string | null>(null)

  const handleConnect = useCallback(async () => {
    setStatus("connecting")
    setError(null)

    try {
      // Step 1: Get a connect session token from our API
      const sessionRes = await fetch("/api/nango/session", { method: "POST" })
      if (!sessionRes.ok) {
        throw new Error("Failed to create a secure session. Please try again.")
      }
      const { token } = await sessionRes.json()

      // Step 2: Use nango.auth() instead of openConnectUI()
      // This opens the provider's OAuth consent screen directly in a popup,
      // bypassing the Nango catalog modal entirely.
      const nango = new Nango({ connectSessionToken: token })

      // Generate a stable, collision-free connection ID for this OAuth flow.
      // We use crypto.randomUUID() (available in all modern browsers) rather than
      // Date.now() — the latter can collide if the user opens two tabs or retries
      // quickly, creating duplicate nango_connections rows instead of upserting.
      const connectionId = `${provider.key}_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`

      // nango.auth() returns a Promise — much cleaner than the event-based
      // openConnectUI() which required callback handling.
      const result = await nango.auth(
        provider.nangoIntegrationId,
        connectionId,
      )

      if (!result) {
        throw new Error("OAuth authorization was cancelled or failed.")
      }

      // Step 3: Save the connection mapping in our backend
      setStatus("saving")

      const saveRes = await fetch("/api/admin/integrations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          connectionId: connectionId,
          provider: provider.key,
        }),
      })

      if (!saveRes.ok) {
        const errData = await saveRes.json().catch(() => ({}))
        throw new Error(
          errData.error || "Connection authenticated but failed to save. Please try again."
        )
      }

      // Success
      setStatus("connected")
      onConnected?.(connectionId, provider)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Something went wrong. Please try again."
      setStatus("error")
      setError(message)
      onError?.(message, provider)
    }
  }, [provider, onConnected, onError])

  const handleRetry = useCallback(() => {
    setStatus("idle")
    setError(null)
  }, [])

  // ── Render ──────────────────────────────────────────────────

  const isWorking = status === "connecting" || status === "saving"
  const isDisabled = disabled || isWorking || status === "connected"

  // Size classes
  const sizeClasses = {
    sm: "h-8 px-3 text-[10px]",
    default: "h-10 px-4 text-xs",
    lg: "h-12 px-6 text-sm",
  }

  // Variant classes
  const variantClasses = {
    default: cn(
      "bg-[var(--primary)] text-white hover:bg-[var(--primary-hover)]",
      status === "connected" && "bg-[var(--success)] hover:bg-[var(--success)]",
      status === "error" && "bg-[var(--danger)] hover:bg-[var(--danger)]",
    ),
    outline: cn(
      "border border-[var(--border)] bg-transparent hover:bg-[var(--bg-muted)]",
      "text-[var(--fg)]",
    ),
    minimal: cn(
      "bg-transparent hover:bg-[var(--bg-muted)]",
      "text-[var(--fg-muted)] hover:text-[var(--fg)]",
    ),
  }

  return (
    <div className="flex flex-col items-stretch gap-1">
      <Button
        onClick={status === "error" ? handleRetry : handleConnect}
        disabled={isDisabled}
        className={cn(
          "font-bold uppercase tracking-widest transition-all rounded-xl",
          sizeClasses[size],
          variantClasses[variant],
          className,
        )}
      >
        {status === "connecting" && (
          <>
            <Loader2 className="w-3.5 h-3.5 animate-spin mr-2" />
            Authorizing...
          </>
        )}
        {status === "saving" && (
          <>
            <Loader2 className="w-3.5 h-3.5 animate-spin mr-2" />
            Saving...
          </>
        )}
        {status === "connected" && (
          <>
            <CheckCircle2 className="w-3.5 h-3.5 mr-2" />
            Connected
          </>
        )}
        {status === "error" && (
          <>
            <RefreshCw className="w-3.5 h-3.5 mr-2" />
            Retry
          </>
        )}
        {status === "idle" && (
          <>
            <Plus className="w-3.5 h-3.5 mr-2" />
            Connect
          </>
        )}
      </Button>

      {error && (
        <div className="flex items-start gap-1.5 px-1">
          <AlertCircle className="w-3 h-3 text-[var(--danger)] shrink-0 mt-0.5" />
          <span className="text-[10px] text-[var(--danger)] leading-tight">
            {error}
          </span>
        </div>
      )}
    </div>
  )
}
