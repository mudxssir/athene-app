// @ts-nocheck
// ── LEGACY ARCHIVE ────────────────────────────────────────────────────────────
// Original integrations page using Nango openConnectUI().
// Replaced by page.tsx which uses nango.auth() (OAuthConnectButton pattern).
// This file is intentionally excluded from type-checking (ts-nocheck) because
// its relative imports point to the parent directory, not this _legacy/ folder.
// ──────────────────────────────────────────────────────────────────────────────
"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import {
  Blocks,
  CheckCircle2,
  AlertCircle,
  X,
  Loader2,
  Plus,
  WifiOff,
  Search,
  RefreshCw,
} from "lucide-react";
import { TCard } from "@/components/ui/kit";
import Nango from "@nangohq/frontend";
import { IntegrationCard, type Integration } from "./integration-card";
import { AddIntegrationDialog } from "./add-integration-dialog";
import { DrivePickerModal } from "./drive-picker-modal";
import { PowerBIPickerModal } from "./powerbi-picker-modal";
import { ProviderConfig, getProvider, PROVIDER_REGISTRY, isBrowsable } from "@/lib/integrations/providers";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { VERTICAL_MODULES } from "@/lib/knowledge-graph/modules/registry";
import { ResourceBrowser } from "@/components/integrations/resource-browser";

// Reverse map: Nango integration ID (e.g. "google-drive") → internal key (e.g. "google_drive")
const NANGO_KEY_MAP: Record<string, string> = Object.fromEntries(
  Object.values(PROVIDER_REGISTRY).map((p) => [p.nangoIntegrationId, p.key])
);

function ConfirmDialog({
  open,
  providerName,
  onConfirm,
  onCancel,
  loading,
}: {
  open: boolean;
  providerName: string;
  onConfirm: () => void;
  onCancel: () => void;
  loading: boolean;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-md animate-in fade-in duration-300">
      <div className="bg-card border border-white/10 shadow-2xl p-8 max-w-sm w-full mx-4 rounded-[2rem] animate-in zoom-in-95 duration-300">
        <div className="flex items-start justify-between mb-6">
          <div className="w-12 h-12 rounded-2xl bg-destructive/10 flex items-center justify-center border border-destructive/20">
            <WifiOff className="w-6 h-6 text-destructive" />
          </div>
          <Button variant="ghost" size="icon" onClick={onCancel} className="rounded-full hover:bg-white/5">
            <X className="w-5 h-5 text-muted-foreground" />
          </Button>
        </div>
        <h3 className="text-xl font-black text-foreground tracking-tight mb-2">
          Disconnect {providerName}?
        </h3>
        <p className="text-sm text-muted-foreground leading-relaxed mb-8">
          This will revoke access for Athene AI and stop all future data synchronization.
          Already-indexed data will remain archived.
        </p>
        <div className="flex gap-3">
          <Button
            variant="outline"
            onClick={onCancel}
            className="flex-1 h-12 rounded-xl border-white/10 hover:bg-white/5 font-bold"
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={onConfirm}
            disabled={loading}
            className="flex-1 h-12 rounded-xl font-bold shadow-lg shadow-destructive/20"
          >
            {loading && <Loader2 className="w-4 h-4 animate-spin mr-2" />}
            Disconnect
          </Button>
        </div>
      </div>
    </div>
  );
}

export default function IntegrationsPage() {
  const [mounted, setMounted] = useState(false);
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [toast, setToast] = useState<{ msg: string; type: "success" | "error" } | null>(null);
  const [disconnecting, setDisconnecting] = useState<Integration | null>(null);
  const [disconnectLoading, setDisconnectLoading] = useState(false);
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [configuringSync, setConfiguringSync] = useState<Integration | null>(null);
  const [syncingAll, setSyncingAll] = useState(false);

  // Queue of configurable providers connected during a single Nango session.
  const pendingConfigureQueue = useRef<Array<{ internalConnectionId: string; provider: string }>>([]);

  useEffect(() => {
    setMounted(true);
  }, []);

  const fetchIntegrations = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/integrations");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setIntegrations(json.integrations ?? []);
      setError(null);
    } catch (e: any) {
      setError("Failed to load active system connectors.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchIntegrations();
    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') {
        fetchIntegrations();
      }
    }, 10000);
    return () => clearInterval(interval);
  }, [fetchIntegrations]);

  // After integrations refresh, open the picker for any configurable provider that was just connected.
  useEffect(() => {
    if (pendingConfigureQueue.current.length === 0 || integrations.length === 0) return;
    const next = pendingConfigureQueue.current[0];
    const found = integrations.find(
      (i) => i.provider === next.provider && i.internalConnectionId === next.internalConnectionId
    );
    if (found) {
      pendingConfigureQueue.current.shift();
      setConfiguringSync(found);
    }
  }, [integrations]);

  const handleConnect = useCallback(async (provider: ProviderConfig) => {
    setConnecting(provider.key);
    try {
      const sessionRes = await fetch("/api/nango/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
      });

      if (!sessionRes.ok) {
        const errBody = await sessionRes.json().catch(() => ({}));
        if (sessionRes.status === 503 && errBody?.error === 'not_configured') {
          setToast({
            msg: "Nango not configured — add NANGO_SECRET_KEY & NEXT_PUBLIC_NANGO_PUBLIC_KEY to .env.local and restart.",
            type: "error",
          });
        } else {
          setToast({ msg: `Connection setup failed (${sessionRes.status}). Check server logs.`, type: "error" });
        }
        setConnecting(null);
        return;
      }

      const { token } = await sessionRes.json();
      if (!token) throw new Error("Nango session token missing");

      const nango = new Nango({ connectSessionToken: token });

      nango.openConnectUI({
        onEvent: async (event) => {
          if (event.type === "close") {
            setConnecting(null);
            setShowAddDialog(false);
            fetchIntegrations();
          }

          if (event.type === "connect") {
            const nangoKey = event.payload.providerConfigKey;
            const internalKey = NANGO_KEY_MAP[nangoKey] ?? nangoKey;
            const displayName = PROVIDER_REGISTRY[internalKey as keyof typeof PROVIDER_REGISTRY]?.displayName ?? internalKey;

            const saveRes = await fetch("/api/admin/integrations", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                connectionId: event.payload.connectionId,
                provider: internalKey,
              }),
            });

            if (!saveRes.ok) {
              setToast({ msg: `Access granted but save failed: ${saveRes.statusText}`, type: "error" });
            } else {
              setToast({ msg: `${displayName} connected successfully.`, type: "success" });
              const saveData = await saveRes.json().catch(() => ({}));

              if (isBrowsable(internalKey as any) && saveData.internalConnectionId) {
                pendingConfigureQueue.current.push({
                  internalConnectionId: saveData.internalConnectionId,
                  provider: internalKey,
                });
              }
            }
            setConnecting(null);
          }
        },
      });
    } catch (e: any) {
      setToast({ msg: `Integration failed: ${e.message}`, type: "error" });
      setConnecting(null);
    }
  }, [fetchIntegrations]);

  const handleDisconnect = useCallback(async () => {
    if (!disconnecting) return;
    setDisconnectLoading(true);
    try {
      const res = await fetch("/api/admin/integrations", { 
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          connectionId: disconnecting.connectionId as string,
          provider: disconnecting.provider,
        })
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const meta = getProvider(disconnecting.provider as any);
      setToast({ msg: `${meta?.displayName ?? "Integration"} successfully removed.`, type: "success" });
      setIntegrations((prev) => prev.filter((c) => c.connectionId !== disconnecting.connectionId));
    } catch (e: any) {
      setToast({ msg: `Disconnection failed: ${e.message}`, type: "error" });
    } finally {
      setDisconnectLoading(false);
      setDisconnecting(null);
    }
  }, [disconnecting]);

  const handleIndex = useCallback(async (integration: Integration) => {
    try {
      const res = await fetch(`/api/connections/${integration.internalConnectionId}/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force: false }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setToast({ msg: `Sync queued for ${integration.displayName}.`, type: "success" });
      setTimeout(fetchIntegrations, 1500);
    } catch (e: any) {
      setToast({ msg: `Manual sync failed: ${e.message}`, type: "error" });
    }
  }, [fetchIntegrations]);

  const handleSyncAll = useCallback(async () => {
    setSyncingAll(true);
    const results = await Promise.allSettled(
      integrations.map((i) =>
        fetch(`/api/connections/${i.internalConnectionId}/sync`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ force: false }),
        })
      )
    );
    // fetch() only rejects on network error — check .ok for HTTP 4xx/5xx too
    const failed = results.filter(
      (r) => r.status === "rejected" || (r.status === "fulfilled" && !r.value.ok)
    ).length;
    setToast({
      msg: failed === 0
        ? `All ${integrations.length} integrations queued for sync.`
        : `${integrations.length - failed} synced, ${failed} failed.`,
      type: failed === 0 ? "success" : "error",
    });
    setSyncingAll(false);
    setTimeout(fetchIntegrations, 1500);
  }, [integrations, fetchIntegrations]);

  const handleCheckStatus = useCallback(async (integration: Integration) => {
    try {
      const res = await fetch(`/api/admin/integrations/${integration.connectionId}/check`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: integration.provider }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) {
        setToast({ msg: `${integration.displayName} connection is healthy.`, type: "success" });
      } else {
        setToast({ msg: `Connection issue for ${integration.displayName}: ${data.error || "reconnect required."}`, type: "error" });
      }
      fetchIntegrations();
    } catch (e: any) {
      setToast({ msg: `Check status failed: ${e.message}`, type: "error" });
    }
  }, [fetchIntegrations]);

  const filteredIntegrations = integrations.filter(i => {
    const meta = getProvider(i.provider as any);
    const searchStr = (meta?.displayName || i.displayName || "").toLowerCase();
    return searchStr.includes(search.toLowerCase());
  });

  const connectedKeys = new Set(integrations.map((i) => i.provider));

  if (!mounted) return null;

  return (
    <div className="space-y-10 pb-20 font-['Space_Grotesk']">
      {toast && (
        <div className={cn(
          "fixed bottom-10 right-10 z-[100] flex items-center gap-4 px-6 py-4 rounded-2xl border shadow-2xl animate-in slide-in-from-right-10 duration-500",
          toast.type === "success" ? "bg-accent/20 border-accent/30 text-accent" : "bg-destructive/10 border-destructive/30 text-destructive"
        )}>
          {toast.type === "success" ? <CheckCircle2 className="w-5 h-5" /> : <AlertCircle className="w-5 h-5" />}
          <span className="font-bold text-sm tracking-tight">{toast.msg}</span>
          <button onClick={() => setToast(null)} className="ml-4 opacity-50 hover:opacity-100 transition-opacity">
             <X className="w-4 h-4" />
          </button>
        </div>
      )}

      <ConfirmDialog
        open={!!disconnecting}
        providerName={getProvider(disconnecting?.provider as any)?.displayName ?? "this system"}
        onConfirm={handleDisconnect}
        onCancel={() => setDisconnecting(null)}
        loading={disconnectLoading}
      />

      <AddIntegrationDialog
        open={showAddDialog}
        onClose={() => setShowAddDialog(false)}
        connectedKeys={connectedKeys}
        onConnect={handleConnect}
        connecting={connecting}
      />

      {configuringSync?.provider === "google_drive" && (
        <DrivePickerModal
          open
          connectionId={configuringSync.internalConnectionId}
          onClose={() => setConfiguringSync(null)}
          onSuccess={() => { setConfiguringSync(null); fetchIntegrations(); }}
        />
      )}

      {configuringSync?.provider === "powerbi" && (
        <PowerBIPickerModal
          open
          connectionId={configuringSync.internalConnectionId}
          onClose={() => setConfiguringSync(null)}
          onSuccess={() => { setConfiguringSync(null); fetchIntegrations(); }}
        />
      )}

      {configuringSync && configuringSync.provider !== "google_drive" && configuringSync.provider !== "powerbi" && (
        <ResourceBrowser
          connectionId={configuringSync.internalConnectionId}
          provider={configuringSync.provider}
          providerName={getProvider(configuringSync.provider as any)?.displayName ?? configuringSync.displayName}
          open={!!configuringSync}
          onClose={() => setConfiguringSync(null)}
          onSaved={() => {
            setToast({ msg: "Sync configuration saved. Re-indexing started.", type: "success" });
            fetchIntegrations();
          }}
        />
      )}

      <TCard i={0} className="flex flex-col lg:flex-row lg:items-end justify-between gap-8">
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <div className="p-3 rounded-2xl bg-gradient-to-br from-primary/10 to-accent/10 border border-border shadow-lg">
              <Blocks className="w-7 h-7 text-primary" />
            </div>
            <h1 className="text-4xl font-black tracking-tighter text-foreground uppercase">
              System <span className="text-primary">Connectors</span>
            </h1>
          </div>
          <p className="text-muted-foreground text-lg max-w-2xl font-medium leading-relaxed">
            Manage your enterprise knowledge sources. Connect tools like SharePoint, 
            Google Drive, and Notion to empower Athene with contextual intelligence.
          </p>
        </div>
        
        <div className="flex items-center gap-4">
           <div className="flex flex-col items-end mr-4 hidden sm:flex">
              <span className="text-[10px] uppercase tracking-widest font-black text-muted-foreground/40 mb-1">Status</span>
              <div className="flex items-center gap-2 px-4 py-2 rounded-xl bg-muted/20 border border-border">
                <div className="h-2 w-2 rounded-full bg-accent animate-pulse" />
                <span className="text-xs font-bold text-foreground tracking-tight">{integrations.length} Active Feeds</span>
              </div>
           </div>
           <Button
            onClick={handleSyncAll}
            disabled={syncingAll || integrations.length === 0}
            variant="outline"
            className="h-14 px-8 rounded-2xl border-white/10 font-black uppercase tracking-widest text-[11px] gap-3 hover:bg-white/5"
           >
             {syncingAll ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
             Sync All
           </Button>
           <Button
            onClick={() => setShowAddDialog(true)}
            className="h-14 px-8 rounded-2xl bg-primary hover:bg-primary/90 text-primary-foreground font-black uppercase tracking-widest text-[11px] gap-3 shadow-xl shadow-primary/10 group"
           >
             <Plus className="w-4 h-4 group-hover:rotate-90 transition-transform" />
             Integrate Tool
           </Button>
        </div>
      </TCard>

      <TCard i={1} className="flex flex-col sm:flex-row gap-4 items-center p-2 rounded-2xl bg-muted/10 border border-border">
         <div className="relative flex-1 group">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground transition-colors group-focus-within:text-primary" />
            <input 
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter system connectors..." 
              className="w-full h-12 pl-12 pr-4 bg-transparent outline-none text-sm font-bold placeholder:text-muted-foreground/40 text-foreground"
            />
         </div>
      </TCard>

      <TCard i={2} className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
        {loading ? (
          [...Array(6)].map((_, i) => (
            <div key={i} className="h-64 rounded-[2.5rem] bg-muted/20 border border-border animate-pulse" />
          ))
        ) : error ? (
          <div className="col-span-full py-20 text-center space-y-4 bg-muted/10 rounded-[3rem] border border-border">
             <AlertCircle className="w-12 h-12 text-destructive mx-auto opacity-20" />
             <p className="text-muted-foreground font-bold">{error}</p>
             <Button variant="outline" onClick={fetchIntegrations} className="rounded-xl border-border">Try Again</Button>
          </div>
        ) : filteredIntegrations.length === 0 ? (
          <div className="col-span-full py-32 flex flex-col items-center justify-center bg-muted/5 rounded-[3rem] border-2 border-dashed border-border text-center">
            <div className="w-20 h-20 rounded-3xl bg-muted/10 flex items-center justify-center mb-6">
              <Blocks className="w-10 h-10 text-muted-foreground/20" />
            </div>
            <h3 className="text-2xl font-black text-foreground mb-2">
              {search ? "No matches found" : "No Active Connectors"}
            </h3>
            <p className="text-muted-foreground max-w-sm font-medium">
              {search ? "Adjust your search parameters to find the connector you're looking for." : "Start by adding your first enterprise integration to build Athene's knowledge base."}
            </p>
            <Button 
              onClick={() => {
                if (search) setSearch("");
                else setShowAddDialog(true);
              }}
              className="mt-8 h-12 px-8 rounded-xl bg-foreground text-background hover:bg-foreground/90 font-bold"
            >
              {search ? "Clear Search" : "Integrate Tool →"}
            </Button>
          </div>
        ) : (
          filteredIntegrations.map((integration) => {
            const meta = getProvider(integration.provider as any);
            return (
              <IntegrationCard
                key={integration.connectionId}
                integration={integration}
                icon={meta?.icon ?? "/integrations/generic.svg"}
                description={meta?.description ?? "Connected enterprise system."}
                onDisconnect={(i) => setDisconnecting(i)}
                onIndex={handleIndex}
                onConfigureSync={(i) => setConfiguringSync(i)}
                onCheckStatus={handleCheckStatus}
              />
            );
          })
        )}
      </TCard>

      {/* Available Integrations — all providers not yet connected */}
      {!loading && (() => {
        const available = Object.values(PROVIDER_REGISTRY).filter(
          (p) => !connectedKeys.has(p.key) &&
            // Skip umbrella entries (google, microsoft) that are sub-divided into specific connectors
            !['google', 'microsoft'].includes(p.key)
        );
        if (available.length === 0) return null;
        return (
          <div className="space-y-6">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div className="space-y-1">
                <h2 className="text-[11px] uppercase tracking-[0.3em] font-black text-muted-foreground">
                  Available Integrations
                </h2>
                <p className="text-xs text-muted-foreground/50 font-medium">
                  {available.length} connectors ready to activate
                </p>
              </div>
              <Badge className="self-start sm:self-auto bg-muted/30 text-muted-foreground/60 border-none text-[9px] font-bold uppercase tracking-widest px-3 py-1.5 rounded-xl">
                {available.length} Available
              </Badge>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
              {available.map((provider) => (
                <div
                  key={provider.key}
                  className="group flex items-center gap-4 p-4 rounded-[1.5rem] bg-muted/5 border border-border hover:border-primary/20 hover:bg-muted/10 transition-all duration-300 cursor-pointer"
                  onClick={() => handleConnect(provider)}
                >
                  <div className="relative h-10 w-10 flex-shrink-0 rounded-xl bg-white/5 border border-white/10 p-1.5 overflow-hidden">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={provider.icon}
                      alt={provider.displayName}
                      className="w-full h-full object-contain opacity-60 group-hover:opacity-100 transition-opacity"
                    />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-black text-foreground tracking-tight truncate group-hover:text-primary transition-colors">
                      {provider.displayName}
                    </p>
                    <p className="text-[10px] text-muted-foreground/40 font-bold uppercase tracking-widest truncate">
                      {provider.category}
                    </p>
                  </div>
                  <Plus className="w-4 h-4 text-muted-foreground/20 group-hover:text-primary group-hover:rotate-90 transition-all flex-shrink-0" />
                </div>
              ))}
            </div>
          </div>
        );
      })()}



      {/* Knowledge Modules — active based on connected integrations */}
      <div className="space-y-6">
        <div className="flex items-center gap-3">
          <h2 className="text-[11px] uppercase tracking-[0.3em] font-black text-muted-foreground">
            Knowledge Modules
          </h2>
          <Badge className="bg-primary/10 text-primary border-none text-[9px] font-bold uppercase tracking-widest">
            Auto-activated
          </Badge>
        </div>
        <p className="text-[13px] text-muted-foreground font-medium max-w-2xl leading-relaxed">
          Domain-specific entity types and extraction rules that activate automatically when the
          matching connector is enabled. No configuration required.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {VERTICAL_MODULES.map((mod) => {
            const active = mod.activating_sources.some((s) => connectedKeys.has(s));
            return (
              <Card
                key={mod.id}
                className={cn(
                  "bg-muted/10 border rounded-[2rem] p-8 space-y-4 transition-all",
                  active ? "border-primary/30 shadow-lg shadow-primary/5" : "border-border opacity-60"
                )}
              >
                <div className="flex items-center justify-between">
                  <h3 className="text-[13px] font-black text-foreground uppercase tracking-tight">
                    {mod.name}
                  </h3>
                  <Badge
                    className={cn(
                      "text-[9px] font-bold uppercase tracking-widest border-none",
                      active ? "bg-accent/10 text-accent" : "bg-muted/30 text-muted-foreground"
                    )}
                  >
                    {active ? "Active" : "Inactive"}
                  </Badge>
                </div>
                <p className="text-[11px] text-muted-foreground font-bold uppercase tracking-widest">
                  Activates via: {mod.activating_sources.join(", ")}
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {mod.entity_types.slice(0, 6).map((et) => (
                    <Badge
                      key={et}
                      className="bg-white/5 text-muted-foreground/60 border-none text-[9px] font-bold"
                    >
                      {et}
                    </Badge>
                  ))}
                  {mod.entity_types.length > 6 && (
                    <Badge className="bg-white/5 text-muted-foreground/40 border-none text-[9px] font-bold">
                      +{mod.entity_types.length - 6} more
                    </Badge>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      </div>
    </div>
  );
}
