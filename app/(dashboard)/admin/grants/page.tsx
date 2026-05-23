'use client';

import { TCard } from "@/components/ui/kit";
import React, { useState, useEffect, useCallback } from 'react';
import { 
  Key, 
  List, 
  Trash2, 
  ShieldCheck, 
  Lock, 
  FileText, 
  Folder,
  Loader2,
  AlertCircle,
  Plus
} from 'lucide-react';
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { 
  Table, 
  TableBody, 
  TableCell, 
  TableHead, 
  TableHeader, 
  TableRow 
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

export default function GrantsPage() {
    const [grants, setGrants] = useState<any[]>([]);
    const [resourceId, setResourceId] = useState('');
    const [resourceType, setResourceType] = useState('document');
    const [loading, setLoading] = useState(true);
    const [isGranting, setIsGranting] = useState(false);
    const [mounted, setMounted] = useState(false);

    useEffect(() => {
        setMounted(true);
        fetchGrants();
    }, []);


    const fetchGrants = async () => {
        setLoading(true);
        try {
            const res = await fetch('/api/admin/bi-grants');
            if (res.ok) {
                const data = await res.json();
                setGrants(data);
            }
        } catch (e) {
            console.error(e);
            toast.error("Failed to load active grants");
        } finally {
            setLoading(false);
        }
    };

    const handleGrant = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!resourceId.trim()) return;
        
        setIsGranting(true);
        try {
            const res = await fetch('/api/admin/bi-grants', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ resource_id: resourceId, resource_type: resourceType })
            });
            
            if (res.ok) {
                setResourceId('');
                toast.success("BI access granted successfully");
                fetchGrants();
            } else {
                const error = await res.json();
                toast.error(error.error || 'Failed to grant access');
            }
        } catch (err) {
            toast.error('Error granting access');
        } finally {
            setIsGranting(false);
        }
    };

    const revokeGrant = async (id: string) => {
        try {
            const res = await fetch(`/api/admin/bi-grants/${id}`, { method: 'DELETE' });
            if (res.ok) {
                toast.success("Grant revoked");
                fetchGrants();
            } else {
                toast.error('Failed to revoke grant');
            }
        } catch (err) {
            toast.error('Error revoking grant');
        }
    };

    return (
        <div className="space-y-10 pb-20 font-['Space_Grotesk'] transition-colors duration-300">
            {/* Header Section */}
            <TCard i={0} className="flex flex-col lg:flex-row lg:items-end justify-between gap-8">
                <div className="space-y-4">
                    <div className="flex items-center gap-3">
                        <div className="p-3 rounded-2xl bg-gradient-to-br from-primary/10 to-secondary/10 border border-border shadow-lg">
                            <Lock className="w-7 h-7 text-primary" />
                        </div>
                        <h1 className="text-4xl font-black tracking-tighter text-foreground uppercase">
                            BI <span className="text-primary">Grants</span>
                        </h1>
                    </div>
                    <p className="text-muted-foreground text-lg max-w-2xl font-medium leading-relaxed">
                        Explicitly authorize cross-department access for specific documents and folders.
                        These overrides bypass standard RLS for Super Users.
                    </p>
                </div>
                
                <div className="flex flex-col items-end mr-4 hidden sm:flex">
                    <span className="text-[10px] uppercase tracking-widest font-black text-muted-foreground/40 mb-1">Active Grants</span>
                    <div className="flex items-center gap-2 px-4 py-2 rounded-xl bg-muted/20 border border-border shadow-sm">
                        <div className="h-2 w-2 rounded-full bg-primary animate-pulse" />
                        <span className="text-xs font-bold text-foreground tracking-tight">{grants.length} Managed Resources</span>
                    </div>
                </div>
            </TCard>

            <div className="grid grid-cols-1 gap-10">
                {/* Grant BI Access Form */}
                <Card className="bg-card/50 border-border rounded-[2.5rem] p-10 overflow-hidden relative shadow-2xl backdrop-blur-xl">
                    <div className="absolute top-0 right-0 w-64 h-64 bg-primary/5 blur-[100px] -z-10" />
                    
                    <div className="flex items-center gap-4 mb-10">
                        <div className="p-3 rounded-xl bg-primary/10 text-primary border border-primary/10 shadow-sm">
                            <Key className="w-5 h-5" />
                        </div>
                        <h2 className="text-xl font-black text-foreground tracking-tight uppercase">Authorize Resource</h2>
                    </div>

                    <form onSubmit={handleGrant} className="flex flex-col lg:flex-row gap-6 items-end">
                        <div className="w-full lg:w-48 space-y-3">
                            <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground/60 ml-1">Type</label>
                            <Select value={resourceType} onValueChange={setResourceType}>
                                <SelectTrigger className="h-14 bg-muted/30 border-border rounded-2xl text-foreground font-black uppercase tracking-widest text-[11px] shadow-sm">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent className="bg-popover border-border text-popover-foreground rounded-xl shadow-2xl backdrop-blur-xl">
                                    <SelectItem value="document" className="font-bold text-xs">Document</SelectItem>
                                    <SelectItem value="folder" className="font-bold text-xs">Folder</SelectItem>
                                </SelectContent>
                            </Select>
                        </div>
                        <div className="flex-1 w-full space-y-3">
                            <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground/60 ml-1">Resource UUID</label>
                            <div className="relative group">
                                <Input
                                    value={resourceId}
                                    onChange={(e) => setResourceId(e.target.value)}
                                    placeholder="00000000-0000-0000-0000-000000000000"
                                    className="h-14 bg-muted/30 border-border rounded-2xl pl-12 text-foreground font-mono text-sm font-bold focus:border-primary/50 transition-all shadow-sm"
                                />
                                {resourceType === 'document' ? (
                                    <FileText className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-muted-foreground/40 group-focus-within:text-primary" />
                                ) : (
                                    <Folder className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-muted-foreground/40 group-focus-within:text-primary" />
                                )}
                            </div>
                        </div>
                        <Button
                            type="submit"
                            disabled={isGranting || !resourceId.trim()}
                            className="h-14 px-10 rounded-2xl bg-primary hover:bg-primary/90 text-primary-foreground font-black uppercase tracking-widest text-[11px] gap-3 shadow-xl shadow-primary/10 transition-all active:scale-95"
                        >
                            {isGranting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                            Grant Access
                        </Button>
                    </form>
                </Card>

                {/* Active BI Grants */}
                <div className="rounded-[2.5rem] bg-card/50 border border-border overflow-hidden backdrop-blur-xl shadow-2xl transition-colors duration-300">
                    <div className="px-10 py-8 border-b border-border flex items-center justify-between bg-muted/30">
                        <div className="flex items-center gap-4">
                            <div className="p-3 rounded-xl bg-secondary/10 text-secondary border border-secondary/10 shadow-sm">
                                <List className="w-5 h-5" />
                            </div>
                            <h2 className="text-xl font-black text-foreground tracking-tight uppercase">Access Registry</h2>
                        </div>
                    </div>
                    
                    <Table>
                        <TableHeader className="bg-muted/10 border-b border-border">
                            <TableRow className="hover:bg-transparent border-none">
                                <TableHead className="py-6 px-10 text-[10px] font-black uppercase tracking-widest text-muted-foreground">Resource</TableHead>
                                <TableHead className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Identity UUID</TableHead>
                                <TableHead className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Authorization Date</TableHead>
                                <TableHead className="text-right py-6 px-10"></TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {loading ? (
                                [...Array(3)].map((_, i) => (
                                    <TableRow key={i} className="border-border">
                                        <TableCell colSpan={4} className="py-12 px-10"><Loader2 className="w-6 h-6 animate-spin text-muted/30 mx-auto" /></TableCell>
                                    </TableRow>
                                ))
                            ) : grants.length === 0 ? (
                                <TableRow className="border-border">
                                    <TableCell colSpan={4} className="py-24 text-center">
                                        <div className="flex flex-col items-center gap-4 opacity-20">
                                            <ShieldCheck className="w-16 h-16 text-muted-foreground" />
                                            <p className="text-muted-foreground font-black uppercase tracking-widest text-xs">No explicit grants registered</p>
                                        </div>
                                    </TableCell>
                                </TableRow>
                            ) : (
                                grants.map((g) => (
                                    <TableRow key={g.grant_id} className="hover:bg-muted/20 border-border group transition-colors">
                                        <TableCell className="py-6 px-10">
                                            <div className="flex items-center gap-4">
                                                <div className={cn(
                                                    "w-10 h-10 rounded-xl flex items-center justify-center border border-border shadow-sm",
                                                    g.resource_type === 'document' ? "bg-primary/10 text-primary" : "bg-secondary/10 text-secondary"
                                                )}>
                                                    {g.resource_type === 'document' ? <FileText className="w-5 h-5" /> : <Folder className="w-5 h-5" />}
                                                </div>
                                                <span className="font-black text-sm text-foreground tracking-tight capitalize">{g.resource_type}</span>
                                            </div>
                                        </TableCell>
                                        <TableCell className="font-mono text-xs text-muted-foreground/60 font-bold">{g.resource_id}</TableCell>
                                        <TableCell className="text-xs font-bold text-muted-foreground">
                                            {mounted ? new Date(g.granted_at).toLocaleDateString(undefined, {
                                                year: 'numeric',
                                                month: 'long',
                                                day: 'numeric',
                                                hour: '2-digit',
                                                minute: '2-digit'
                                            }) : '---'}
                                        </TableCell>

                                        <TableCell className="text-right py-6 px-10">
                                            <Button
                                                onClick={() => revokeGrant(g.grant_id)}
                                                variant="ghost"
                                                className="h-10 px-4 rounded-xl text-destructive hover:text-destructive hover:bg-destructive/10 gap-2 font-black text-[10px] uppercase tracking-widest transition-all"
                                            >
                                                <Trash2 className="w-4 h-4" />
                                                Revoke
                                            </Button>
                                        </TableCell>
                                    </TableRow>
                                ))
                            )}
                        </TableBody>
                    </Table>
                </div>
            </div>
        </div>
    );
}

