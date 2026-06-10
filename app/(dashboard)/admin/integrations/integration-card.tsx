"use client";

import { useState, useEffect } from "react";
import Image from "next/image";
import {
  CheckCircle2,
  RefreshCw,
  AlertCircle,
  Trash2,
  Loader2,
  Calendar,
  Database,
  Settings2,
  PauseCircle,
  PlayCircle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { isBrowsable, type ProviderKey } from "@/lib/integrations/providers";

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

export interface Integration {
  connectionId: string;
  internalConnectionId: string;
  provider: string;
  displayName: string;
  category: string;
  resources: string[];
  status: "connected" | "syncing" | "error" | "stale";
  lastSyncedAt: string | null;
  totalDocs: number;
  createdAt: string | null;
  metadata?: {
    selected_folder_ids?: string[];
    allowlist?: string[];
    sync_paused?: boolean;
    paused_at?: string;
    [key: string]: unknown;
  };
  sync_config?: {
    selected_resources?: Array<{ id: string; name: string; type: string; departmentId?: string }>;
  };
}

interface IntegrationCardProps {
  integration: Integration;
  icon: string;
  description: string;
  onDisconnect: (integration: Integration) => void;
  onIndex: (integration: Integration) => Promise<void>;
  onConfigureSync: (integration: Integration) => void;
  onCheckStatus: (integration: Integration) => Promise<void>;
  onAbortSync: (integration: Integration) => Promise<void>;
}

function needsConfiguration(integration: Integration): boolean {
  if (!isBrowsable(integration.provider as ProviderKey)) return false;
  return !integration.sync_config?.selected_resources?.length;
}

export function IntegrationCard({
  integration,
  icon,
  description,
  onDisconnect,
  onIndex,
  onConfigureSync,
  onCheckStatus,
  onAbortSync,
}: IntegrationCardProps) {
  const [indexing, setIndexing] = useState(false);
  const [checking, setChecking] = useState(false);
  const [aborting, setAborting] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const handleIndex = async () => {
    setIndexing(true);
    try {
      await onIndex(integration);
    } finally {
      setIndexing(false);
    }
  };

  const handleCheckStatus = async () => {
    setChecking(true);
    try {
      await onCheckStatus(integration);
    } finally {
      setChecking(false);
    }
  };

  const handleAbortSync = async () => {
    setAborting(true);
    try {
      await onAbortSync(integration);
    } finally {
      setAborting(false);
    }
  };

  const statusConfig = {
    connected: {
      color: "text-emerald-400 bg-emerald-400/10 border-emerald-400/20",
      icon: <CheckCircle2 className="w-3 h-3" />,
      label: "Healthy"
    },
    syncing: {
      color: "text-blue-400 bg-blue-400/10 border-blue-400/20",
      icon: <RefreshCw className="w-3 h-3 animate-spin" />,
      label: "Syncing"
    },
    error: {
      color: "text-amber-400 bg-amber-400/10 border-amber-400/20",
      icon: <AlertCircle className="w-3 h-3" />,
      label: "Issue"
    },
    stale: {
      color: "text-yellow-400 bg-yellow-400/10 border-yellow-400/20",
      icon: <AlertCircle className="w-3 h-3" />,
      label: "Stale"
    },
  };

  const config = statusConfig[integration.status] ?? statusConfig['connected'];
  const needsConfig = needsConfiguration(integration);

  const isError = integration.status === "error";
  const isStale = integration.status === "stale";
  const isSyncing = integration.status === "syncing";
  const isPaused = !!integration.metadata?.sync_paused;

  return (
    <div className={cn(
      "group relative rounded-[2rem] sm:rounded-[2.5rem] bg-card border overflow-hidden p-4 sm:p-6 md:p-8 transition-all duration-500 hover:scale-[1.02] hover:shadow-2xl",
      isError
        ? "border-amber-400/25 hover:border-amber-400/40 hover:shadow-amber-500/5"
        : isStale
        ? "border-yellow-400/25 hover:border-yellow-400/40 hover:shadow-yellow-500/5"
        : "border-white/5 hover:border-white/10 hover:shadow-primary/5"
    )}>
      {/* Sync progress bar — indeterminate, shown at top of card while syncing */}
      {isSyncing && (
        <div className="absolute top-0 left-0 right-0 h-[3px] bg-blue-400/20 overflow-hidden">
          <div className="h-full w-1/2 bg-blue-400 rounded-full"
            style={{ animation: "athene-sync-slide 1.6s ease-in-out infinite" }}
          />
        </div>
      )}
      <div className="absolute top-0 right-0 p-8 flex flex-col items-end gap-2">
        <Badge className={cn("rounded-full px-3 py-1 font-black text-[9px] uppercase tracking-widest border", config.color)}>
           <div className="flex items-center gap-1.5">
             {config.icon}
             {config.label}
           </div>
        </Badge>
        {needsConfig && (
          <span className="text-[9px] font-black uppercase tracking-widest text-amber-400 border border-amber-400/20 bg-amber-400/10 rounded-full px-2.5 py-0.5 flex items-center gap-1">
            <AlertCircle className="w-2.5 h-2.5" />
            Setup Required
          </span>
        )}
      </div>

      <div className="flex items-start gap-5 mb-8">
        <div className="relative h-16 w-16 rounded-2xl bg-white/5 border border-white/10 p-3 flex items-center justify-center overflow-hidden group-hover:scale-110 transition-transform duration-500 shadow-inner">
           <Image
              src={icon}
              alt={integration.displayName}
              fill
              className="object-contain p-3 opacity-80 group-hover:opacity-100 transition-opacity"
            />
        </div>
        <div className="pt-1">
           <h3 className="text-xl font-black text-foreground tracking-tight group-hover:text-primary transition-colors">{integration.displayName}</h3>
           <span className="text-[10px] font-bold text-muted-foreground/40 uppercase tracking-widest">{integration.category}</span>
        </div>
      </div>

      <p className="text-sm text-muted-foreground font-medium leading-relaxed mb-8 line-clamp-2">
        {description}
      </p>

      <div className="grid grid-cols-2 gap-4 mb-8">
         <div className="p-3 rounded-2xl bg-white/5 border border-white/5">
            <div className="flex items-center gap-2 mb-1">
               <Database className="w-3 h-3 text-secondary" />
               <span className="text-[9px] font-black uppercase tracking-widest text-muted-foreground/60">Knowledge</span>
            </div>
            <span className="text-sm font-black text-foreground">{(integration.totalDocs || 0).toLocaleString()} <span className="text-[10px] opacity-40">Docs</span></span>
         </div>
         <div className="p-3 rounded-2xl bg-white/5 border border-white/5">
            <div className="flex items-center gap-2 mb-1">
               <Calendar className="w-3 h-3 text-primary" />
               <span className="text-[9px] font-black uppercase tracking-widest text-muted-foreground/60">Last Sync</span>
            </div>
            <span className="text-sm font-black text-foreground" title={integration.lastSyncedAt && mounted ? new Date(integration.lastSyncedAt).toLocaleString() : undefined}>
              {integration.lastSyncedAt && mounted ? relativeTime(integration.lastSyncedAt) : 'Pending'}
            </span>
         </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 pt-5 sm:pt-6 border-t border-white/5">
        <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
          {/* Abort button — only while syncing */}
          {isSyncing && (
            <Button
              onClick={handleAbortSync}
              disabled={aborting}
              variant="ghost"
              className="h-10 px-4 rounded-xl text-[11px] font-black uppercase tracking-widest transition-all gap-2 text-orange-400 hover:bg-orange-400/10"
            >
              {aborting ? <Loader2 className="w-3 h-3 animate-spin" /> : <PauseCircle className="w-3 h-3" />}
              Abort Sync
            </Button>
          )}

          {/* Force / Retry / Resume Sync */}
          {!isSyncing && (
            <Button
              onClick={handleIndex}
              disabled={indexing || checking}
              variant="ghost"
              className={cn(
                "h-10 px-4 rounded-xl text-[11px] font-black uppercase tracking-widest transition-all gap-2",
                isError
                  ? "text-amber-400 hover:bg-amber-400/10"
                  : isPaused
                  ? "text-orange-400 hover:bg-orange-400/10"
                  : "text-foreground hover:bg-secondary/10 hover:text-secondary"
              )}
            >
              {indexing
                ? <Loader2 className="w-3 h-3 animate-spin" />
                : isPaused
                ? <PlayCircle className="w-3 h-3" />
                : <RefreshCw className="w-3 h-3" />}
              {isError ? "Retry Sync" : isPaused ? "Resume Sync" : "Force Sync"}
            </Button>
          )}

          <Button
            onClick={handleCheckStatus}
            disabled={checking || indexing || isSyncing}
            variant="ghost"
            className={cn(
              "h-10 px-4 rounded-xl text-[11px] font-black uppercase tracking-widest transition-all gap-2",
              isError
                ? "text-amber-400 hover:bg-amber-400/10"
                : isStale
                ? "text-yellow-400 hover:bg-yellow-400/10"
                : "text-foreground hover:bg-primary/10 hover:text-primary"
            )}
          >
            {checking ? <Loader2 className="w-3 h-3 animate-spin" /> : <CheckCircle2 className="w-3 h-3" />}
            Check Status
          </Button>

          <Button
            variant="ghost"
            onClick={() => onConfigureSync(integration)}
            disabled={isSyncing}
            className={cn(
              "h-10 px-4 rounded-xl text-[11px] font-black uppercase tracking-widest transition-all gap-2",
              needsConfig
                ? "text-amber-400 hover:bg-amber-400/10"
                : "text-foreground hover:bg-primary/10 hover:text-primary"
            )}
          >
            <Settings2 className="w-3 h-3" />
            {needsConfig ? "Configure" : "Reconfigure"}
          </Button>
        </div>
        
        <Button
          variant="ghost"
          size="icon"
          onClick={() => onDisconnect(integration)}
          className="h-10 w-10 rounded-xl text-muted-foreground/40 hover:bg-destructive/10 hover:text-destructive transition-all"
        >
          <Trash2 className="w-4 h-4" />
        </Button>
      </div>
    </div>
  );
}
