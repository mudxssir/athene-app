"use client";

import { useState, useEffect } from "react";
import Image from "next/image";
import { 
  X, 
  Search, 
  Plus, 
  Loader2, 
  CheckCircle2, 
  Blocks,
  ExternalLink,
  ChevronRight
} from "lucide-react";

import { ProviderConfig, getAllProviders } from "@/lib/integrations/providers";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

interface AddIntegrationDialogProps {
  open: boolean;
  onClose: () => void;
  connectedKeys: Set<string>;
  onConnect: (provider: ProviderConfig) => Promise<void>;
  connecting: string | null;
}

const CATEGORY_LABELS: Record<string, string> = {
  productivity: "Productivity",
  crm: "Sales & CRM",
  devtools: "Development",
  communication: "Communications",
  data: "Data & BI",
};

export function AddIntegrationDialog({
  open,
  onClose,
  connectedKeys,
  onConnect,
  connecting
}: AddIntegrationDialogProps) {
  const [mounted, setMounted] = useState(false);
  const [search, setSearch] = useState("");
  const providers = getAllProviders();

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!open || !mounted) return null;

  const filteredProviders = providers.filter(
    (p) =>
      search === "" ||
      p.displayName.toLowerCase().includes(search.toLowerCase()) ||
      p.description.toLowerCase().includes(search.toLowerCase()) ||
      CATEGORY_LABELS[p.category]?.toLowerCase().includes(search.toLowerCase())
  );

  const groupedProviders = Object.entries(CATEGORY_LABELS).map(([catKey, catLabel]) => ({
    key: catKey,
    label: catLabel,
    providers: filteredProviders.filter((p) => p.category === catKey),
  })).filter((g) => g.providers.length > 0);

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-md p-4 animate-in fade-in duration-300">
      <div className="bg-card border border-white/10 shadow-2xl w-full max-w-2xl max-h-[85vh] flex flex-col overflow-hidden rounded-[2.5rem] animate-in zoom-in-95 duration-300">
        
        {/* Header */}
        <div className="p-8 border-b border-white/5 flex items-center justify-between">
          <div className="space-y-1">
            <h2 className="text-2xl font-black text-foreground tracking-tight">Add Integration</h2>
            <p className="text-xs font-bold text-muted-foreground/60 uppercase tracking-widest">Select a tool to empower your intelligence</p>
          </div>
          <Button 
            variant="ghost" 
            size="icon" 
            onClick={onClose}
            className="rounded-full hover:bg-white/5"
          >
            <X className="w-5 h-5 text-muted-foreground" />
          </Button>
        </div>

        {/* Search Section */}
        <div className="px-8 py-6 bg-accent/5 border-b border-white/5">
          <div className="relative group">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground transition-colors group-focus-within:text-primary" />
            <input
              type="text"
              placeholder="Search by name, category or tool..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full h-12 pl-12 pr-4 bg-white/5 border border-white/10 rounded-2xl text-sm font-medium focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/40 transition-all placeholder:text-muted-foreground/30"
              autoFocus
            />
          </div>
        </div>

        {/* Providers List */}
        <ScrollArea className="flex-1 p-4">
          <div className="px-4 py-4 space-y-10">
            {groupedProviders.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-20 text-center opacity-40">
                <Blocks className="w-12 h-12 text-muted-foreground mb-4" />
                <p className="text-sm font-bold text-foreground">No integrations match your search</p>
                <p className="text-xs font-medium text-muted-foreground mt-1">Try searching for generic terms like "CRM" or "Files"</p>
              </div>
            ) : (
              groupedProviders.map((group) => (
                <div key={group.key} className="space-y-4">
                  <h3 className="text-[10px] font-black text-muted-foreground/40 uppercase tracking-[0.2em] px-2">
                    {group.label}
                  </h3>
                  <div className="grid grid-cols-1 gap-3">
                    {group.providers.map((provider) => {
                      const isConnecting = connecting === provider.key;
                      const isConnected = connectedKeys.has(provider.key) || connectedKeys.has(provider.nangoIntegrationId);

                      return (
                        <div
                          key={provider.key}
                          className={cn(
                            "group flex items-center justify-between p-5 rounded-[1.5rem] border transition-all duration-300",
                            isConnected 
                              ? "bg-accent/5 border-white/5 opacity-60" 
                              : "bg-white/5 border-white/5 hover:border-primary/20 hover:bg-primary/5 cursor-pointer"
                          )}
                          onClick={() => !isConnected && !isConnecting && onConnect(provider)}
                        >
                          <div className="flex items-center gap-5">
                            <div className="relative w-12 h-12 rounded-2xl bg-white/5 border border-white/10 p-2 flex items-center justify-center shadow-inner group-hover:scale-110 transition-transform duration-500">
                              <Image
                                src={provider.icon}
                                alt={provider.displayName}
                                width={48}
                                height={48}
                                className="object-contain p-1"
                              />
                            </div>
                            <div className="space-y-0.5">
                              <p className="text-sm font-black text-foreground">
                                {provider.displayName}
                              </p>
                              <p className="text-[11px] font-medium text-muted-foreground/60 line-clamp-1 max-w-[300px]">
                                {provider.description}
                              </p>
                            </div>
                          </div>

                          {isConnected ? (
                            <Badge variant="outline" className="rounded-full px-3 py-1 font-black text-[9px] uppercase tracking-widest text-emerald-400 bg-emerald-400/5 border-emerald-400/20">
                              <CheckCircle2 className="w-3 h-3 mr-1.5" />
                              Active
                            </Badge>
                          ) : (
                            <Button
                              variant="ghost"
                              className="h-10 px-4 rounded-xl text-[10px] font-black uppercase tracking-widest text-secondary group-hover:text-primary transition-colors gap-2"
                              disabled={!!connecting}
                            >
                              {isConnecting ? (
                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                              ) : (
                                <>
                                  Connect
                                  <ChevronRight className="w-3.5 h-3.5" />
                                </>
                              )}
                            </Button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))
            )}
          </div>
        </ScrollArea>

        {/* Footer */}
        <div className="p-6 border-t border-white/5 bg-accent/5 flex items-center justify-center">
          <p className="text-[10px] font-bold text-muted-foreground/40 flex items-center gap-2 uppercase tracking-widest">
            Need a custom tool?
            <a href="mailto:support@athene.ai" className="text-secondary hover:text-primary flex items-center gap-1 transition-colors">
              Request Integration
              <ExternalLink className="w-2.5 h-2.5" />
            </a>
          </p>
        </div>
      </div>
    </div>
  );
}
