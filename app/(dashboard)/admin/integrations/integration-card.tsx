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
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

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
}

const CONFIGURABLE = new Set(["google_drive", "snowflake", "bigquery", "redshift", "powerbi"]);

function needsConfiguration(integration: Integration): boolean {
  const { provider, metadata, sync_config } = integration;
  if (!CONFIGURABLE.has(provider)) return false;
  
  // Power BI and Google Drive now use sync_config.selected_resources
  if (provider === "google_drive" || provider === "powerbi") {
    return !sync_config?.selected_resources?.length;
  }
  
  if (provider === "google_drive") return !metadata?.selected_folder_ids?.length;
  return !metadata?.allowlist?.length;
}

export function IntegrationCard({
  integration,
  icon,
  description,
  onDisconnect,
  onIndex,
  onConfigureSync,
  onCheckStatus,
}: IntegrationCardProps) {
  const [indexing, setIndexing] = useState(false);
  const [checking, setChecking] = useState(false);
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

  return (
    <div className={cn(
      "group relative rounded-[2rem] sm:rounded-[2.5rem] bg-card border p-4 sm:p-6 md:p-8 transition-all duration-500 hover:scale-[1.02] hover:shadow-2xl",
      isError
        ? "border-amber-400/25 hover:border-amber-400/40 hover:shadow-amber-500/5"
        : isStale
        ? "border-yellow-400/25 hover:border-yellow-400/40 hover:shadow-yellow-500/5"
        : "border-white/5 hover:border-white/10 hover:shadow-[#D96FAB]/5"
    )}>
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
           <h3 className="text-xl font-black text-foreground tracking-tight group-hover:text-[#D96FAB] transition-colors">{integration.displayName}</h3>
           <span className="text-[10px] font-bold text-muted-foreground/40 uppercase tracking-widest">{integration.category}</span>
        </div>
      </div>

      <p className="text-sm text-muted-foreground font-medium leading-relaxed mb-8 line-clamp-2">
        {description}
      </p>

      <div className="grid grid-cols-2 gap-4 mb-8">
         <div className="p-3 rounded-2xl bg-white/5 border border-white/5">
            <div className="flex items-center gap-2 mb-1">
               <Database className="w-3 h-3 text-[#7AADCF]" />
               <span className="text-[9px] font-black uppercase tracking-widest text-muted-foreground/60">Knowledge</span>
            </div>
            <span className="text-sm font-black text-foreground">{(integration.totalDocs || 0).toLocaleString()} <span className="text-[10px] opacity-40">Docs</span></span>
         </div>
         <div className="p-3 rounded-2xl bg-white/5 border border-white/5">
            <div className="flex items-center gap-2 mb-1">
               <Calendar className="w-3 h-3 text-[#D96FAB]" />
               <span className="text-[9px] font-black uppercase tracking-widest text-muted-foreground/60">Last Sync</span>
            </div>
            <span className="text-sm font-black text-foreground">
              {integration.lastSyncedAt && mounted ? new Date(integration.lastSyncedAt).toLocaleDateString() : 'Pending'}
            </span>
         </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 pt-5 sm:pt-6 border-t border-white/5">
        <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
          <Button
            onClick={handleIndex}
            disabled={indexing || checking || integration.status === 'syncing'}
            variant="ghost"
            className={cn(
              "h-10 px-4 rounded-xl text-[11px] font-black uppercase tracking-widest transition-all gap-2",
              isError
                ? "text-amber-400 hover:bg-amber-400/10"
                : "text-foreground hover:bg-[#7AADCF]/10 hover:text-[#7AADCF]"
            )}
          >
            {indexing ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
            {isError ? "Retry Sync" : "Force Sync"}
          </Button>

          <Button
            onClick={handleCheckStatus}
            disabled={checking || indexing || integration.status === 'syncing'}
            variant="ghost"
            className={cn(
              "h-10 px-4 rounded-xl text-[11px] font-black uppercase tracking-widest transition-all gap-2",
              isError
                ? "text-amber-400 hover:bg-amber-400/10"
                : isStale
                ? "text-yellow-400 hover:bg-yellow-400/10"
                : "text-foreground hover:bg-[#7AADCF]/10 hover:text-[#7AADCF]"
            )}
          >
            {checking ? <Loader2 className="w-3 h-3 animate-spin" /> : <CheckCircle2 className="w-3 h-3" />}
            Check Status
          </Button>

          <Button
            variant="ghost"
            onClick={() => onConfigureSync(integration)}
            className={cn(
              "h-10 px-4 rounded-xl text-[11px] font-black uppercase tracking-widest transition-all gap-2",
              needsConfig
                ? "text-amber-400 hover:bg-amber-400/10"
                : "text-foreground hover:bg-[#D96FAB]/10 hover:text-[#D96FAB]"
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
