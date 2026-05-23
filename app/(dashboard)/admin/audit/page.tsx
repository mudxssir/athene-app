"use client";
 
import { TCard } from "@/components/ui/kit";
import { useState, useEffect } from "react";
import {
  Activity,
  Search,
  Shield,
  UserCircle,
  History,
  Database,
  Filter,
  ArrowRight,
  UserCheck,
  UserMinus,
  UserPlus,
  Settings,
  AlertCircle,
  Download,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export default function AuditPage() {
    const [biLogs, setBiLogs] = useState<any[]>([]);
    const [adminLogs, setAdminLogs] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);
    const [search, setSearch] = useState("");
    const [mounted, setMounted] = useState(false);
    const [page, setPage] = useState(1);
    const [total, setTotal] = useState(0);
    const [exportingCSV, setExportingCSV] = useState(false);
    const [exportError, setExportError] = useState<string | null>(null);
    const limit = 50;

    const handleExportCSV = async () => {
      setExportingCSV(true);
      setExportError(null);
      try {
        const res = await fetch(`/api/admin/audit-log?format=csv&search=${encodeURIComponent(search)}`);
        if (!res.ok) throw new Error("Export failed — please try again.");
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `audit-log-${new Date().toISOString().slice(0, 10)}.csv`;
        a.click();
        URL.revokeObjectURL(url);
      } catch (e: any) {
        setExportError(e?.message ?? "Export failed — please try again.");
      } finally {
        setExportingCSV(false);
      }
    };

    useEffect(() => {
        setMounted(true);
        const fetchAll = async () => {
            setLoading(true);
            try {
                const [biRes, adminRes] = await Promise.all([
                    fetch(`/api/admin/bi-audit?page=${page}&limit=${limit}&search=${encodeURIComponent(search)}`),
                    fetch(`/api/admin/audit-log?page=${page}&limit=${limit}&search=${encodeURIComponent(search)}`)
                ]);
                
                if (biRes.ok) {
                    const data = await biRes.json();
                    setBiLogs(data.logs || data);
                }
                if (adminRes.ok) {
                    const data = await adminRes.json();
                    setAdminLogs(data.logs || data);
                    if (data.total) setTotal(data.total);
                }
            } catch (e) {
                console.error("Failed to fetch audit logs", e);
            }
            setLoading(false);
        };
        fetchAll();
    }, [page, search]);

    const getActionIcon = (action: string) => {
      switch (action) {
        case 'invite_user': return <UserPlus className="w-4 h-4 text-emerald-400" />;
        case 'deactivate_user': return <UserMinus className="w-4 h-4 text-red-400" />;
        case 'reactivate_user': return <UserCheck className="w-4 h-4 text-blue-400" />;
        case 'change_role': return <Shield className="w-4 h-4 text-primary" />;
        default: return <Settings className="w-4 h-4 text-slate-400" />;
      }
    };

    const formatAction = (action: string) => {
      return action.split('_').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
    };

    return (
        <div className="space-y-10 pb-20 font-['Space_Grotesk'] transition-colors duration-300">
            
            {/* Header */}
            <TCard i={0} className="flex flex-col lg:flex-row lg:items-end justify-between gap-8">
              <div className="space-y-4">
                <div className="flex items-center gap-3">
                  <div className="p-3 rounded-2xl bg-gradient-to-br from-primary/10 to-secondary/10 border border-border shadow-lg">
                    <History className="w-7 h-7 text-primary" />
                  </div>
                  <h1 className="text-4xl font-black tracking-tighter text-foreground uppercase">
                    Audit <span className="text-primary">Ledger</span>
                  </h1>
                </div>
                <p className="text-muted-foreground text-lg max-w-2xl font-medium leading-relaxed">
                  Transparent record of all administrative modifications and high-privilege analytical access within the organization.
                </p>
              </div>
              <div className="flex flex-col items-end gap-1 shrink-0">
                <Button
                  onClick={handleExportCSV}
                  disabled={exportingCSV}
                  variant="outline"
                  size="sm"
                  className="h-10 px-5 rounded-xl font-black uppercase tracking-widest text-[10px] border-border hover:border-primary/40 gap-2"
                >
                  <Download className="w-3.5 h-3.5" />
                  {exportingCSV ? "Exporting…" : "Export CSV"}
                </Button>
                {exportError && (
                  <p className="text-[10px] text-red-400 font-medium">{exportError}</p>
                )}
              </div>
            </TCard>

            <Tabs defaultValue="admin" className="space-y-8">
              <div className="flex flex-col sm:flex-row gap-6 items-center justify-between p-2 rounded-2xl bg-muted/10 border border-border backdrop-blur-xl">
                <TabsList className="bg-transparent border-none gap-2">
                  <TabsTrigger 
                    value="admin" 
                    className="h-11 px-6 rounded-xl data-[state=active]:bg-primary data-[state=active]:text-primary-foreground text-muted-foreground font-black uppercase tracking-widest text-[10px] transition-all gap-2"
                  >
                    <Shield className="w-4 h-4" /> Admin Actions
                  </TabsTrigger>
                  <TabsTrigger 
                    value="bi" 
                    className="h-11 px-6 rounded-xl data-[state=active]:bg-secondary data-[state=active]:text-secondary-foreground text-muted-foreground font-black uppercase tracking-widest text-[10px] transition-all gap-2"
                  >
                    <Activity className="w-4 h-4" /> BI Access
                  </TabsTrigger>
                </TabsList>

                <div className="relative flex-1 max-w-md group">
                  <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground transition-colors group-focus-within:text-primary" />
                  <input 
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search ledger..." 
                    className="w-full h-11 pl-12 pr-4 bg-muted/20 border border-border rounded-xl outline-none text-sm font-bold text-foreground placeholder:text-muted-foreground/40 focus:border-primary/50 transition-all"
                  />
                </div>
              </div>

              <TabsContent value="admin" className="mt-0 outline-none">
                <div className="rounded-[2.5rem] bg-card/50 border border-border overflow-hidden backdrop-blur-xl shadow-2xl transition-colors duration-300">
                  <div className="overflow-x-auto">
                    <table className="w-full text-left">
                      <thead className="bg-muted/30 border-b border-border">
                        <tr>
                          <th className="py-6 px-8 text-[10px] font-black uppercase tracking-widest text-muted-foreground">Timestamp</th>
                          <th className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Administrator</th>
                          <th className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Action</th>
                          <th className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Target User</th>
                          <th className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Details</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {loading ? (
                          [...Array(3)].map((_, i) => (
                            <tr key={i} className="animate-pulse">
                              <td colSpan={5} className="py-8 px-8 h-20 bg-muted/5" />
                            </tr>
                          ))
                        ) : adminLogs.length === 0 ? (
                          <tr>
                            <td colSpan={5} className="py-20 text-center">
                              <div className="flex flex-col items-center gap-4 text-muted-foreground">
                                <AlertCircle className="w-10 h-10 opacity-20" />
                                <p className="font-bold">No administrative actions recorded yet.</p>
                              </div>
                            </td>
                          </tr>
                        ) : (
                          adminLogs.map((log) => (
                            <tr key={log.id} className="hover:bg-muted/20 transition-colors group">
                              <td className="py-6 px-8 whitespace-nowrap">
                                <div className="flex flex-col">
                                  <span className="text-xs font-black text-foreground">{mounted ? new Date(log.performed_at).toLocaleDateString() : '---'}</span>
                                  <span className="text-[10px] text-muted-foreground font-bold">{mounted ? new Date(log.performed_at).toLocaleTimeString() : '---'}</span>
                                </div>

                              </td>
                              <td className="py-6">
                                <div className="flex items-center gap-3">
                                    <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center text-[10px] font-black text-primary border border-primary/20 shadow-sm">
                                      {log.admin?.display_name?.charAt(0) || log.admin?.email?.charAt(0)}
                                    </div>
                                    <div className="flex flex-col">
                                      <span className="text-xs font-black text-foreground leading-none">{log.admin?.display_name}</span>
                                      <span className="text-[10px] text-muted-foreground font-bold mt-1">{log.admin?.email}</span>
                                  </div>
                                </div>
                              </td>
                              <td>
                                <div className="flex items-center gap-2">
                                  <Badge className="bg-muted border-border text-muted-foreground rounded-lg px-2 py-1 gap-1.5 font-bold text-[9px] uppercase tracking-widest">
                                    {getActionIcon(log.action)}
                                    {formatAction(log.action)}
                                  </Badge>
                                </div>
                              </td>
                              <td className="py-6">
                                {log.target ? (
                                  <div className="flex items-center gap-3">
                                    <div className="w-8 h-8 rounded-lg bg-muted flex items-center justify-center text-[10px] font-black text-muted-foreground border border-border">
                                      {log.target?.display_name?.charAt(0) || log.target?.email?.charAt(0)}
                                    </div>
                                    <div className="flex flex-col">
                                      <span className="text-xs font-black text-foreground leading-none">{log.target?.display_name}</span>
                                      <span className="text-[10px] text-muted-foreground font-bold mt-1">{log.target?.email}</span>
                                    </div>
                                  </div>
                                ) : (
                                  <span className="text-[10px] font-black text-muted-foreground/40 uppercase tracking-widest">System</span>
                                )}
                              </td>
                              <td className="py-6 pr-8">
                                <div className="max-w-xs overflow-hidden">
                                   <pre className="text-[9px] font-mono text-muted-foreground/60 truncate bg-background/50 p-2 rounded-lg border border-border">
                                     {JSON.stringify(log.details)}
                                   </pre>
                                </div>
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </TabsContent>

              <TabsContent value="bi" className="mt-0 outline-none">
                <div className="rounded-[2.5rem] bg-card/50 border border-border overflow-hidden backdrop-blur-xl shadow-2xl transition-colors duration-300">
                  <div className="overflow-x-auto">
                    <table className="w-full text-left">
                      <thead className="bg-muted/30 border-b border-border">
                        <tr>
                          <th className="py-6 px-8 text-[10px] font-black uppercase tracking-widest text-muted-foreground">Timestamp</th>
                          <th className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Analyst ID</th>
                          <th className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Analytical Query</th>
                          <th className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Source Object</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {loading ? (
                          [...Array(3)].map((_, i) => (
                            <tr key={i} className="animate-pulse">
                              <td colSpan={4} className="py-8 px-8 h-20 bg-muted/5" />
                            </tr>
                          ))
                        ) : biLogs.length === 0 ? (
                          <tr>
                            <td colSpan={4} className="py-20 text-center">
                              <div className="flex flex-col items-center gap-4 text-muted-foreground">
                                <AlertCircle className="w-10 h-10 opacity-20" />
                                <p className="font-bold">No high-privilege access events recorded.</p>
                              </div>
                            </td>
                          </tr>
                        ) : (
                          biLogs.map((log) => (
                            <tr key={log.id} className="hover:bg-muted/20 transition-colors">
                              <td className="py-6 px-8 whitespace-nowrap">
                                <div className="flex flex-col">
                                  <span className="text-xs font-black text-foreground">{mounted ? new Date(log.created_at || log.timestamp).toLocaleDateString() : '---'}</span>
                                  <span className="text-[10px] text-muted-foreground font-bold">{mounted ? new Date(log.created_at || log.timestamp).toLocaleTimeString() : '---'}</span>
                                </div>

                              </td>
                              <td className="py-6">
                                <div className="flex items-center gap-2 font-mono text-[10px] text-primary bg-primary/5 px-2 py-1 rounded-lg border border-primary/10 w-fit">
                                  <UserCircle className="w-3 h-3" />
                                  {log.user_id.slice(0, 8)}...
                                </div>
                              </td>
                              <td className="py-6">
                                <p className="text-xs font-bold text-muted-foreground max-w-md line-clamp-2 leading-relaxed">
                                  {log.query}
                                </p>
                              </td>
                              <td className="py-6 pr-8">
                                <div className="flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-muted-foreground/40">
                                  <Database className="w-3 h-3" />
                                  {log.doc_id || "Cross-Department Synthesizer"}
                                </div>
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </TabsContent>
            </Tabs>
        </div>
  );
}

