"use client";

import { useRef, useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  FileText,
  Upload,
  Share2,
  Trash2,
  Download,
  Search,
  Filter,
  HardDrive,
  Cloud,
  Layers,
  RotateCcw,
  AlertCircle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger
} from "@/components/ui/tooltip";
import { toast } from "sonner";

const INTELLIGENCE_LAYERS = [
  { label: "Financial Records", color: "text-emerald-500" },
  { label: "Legal Discovery", color: "text-amber-500" },
  { label: "Internal Wiki", color: "text-secondary" },
  { label: "Audit Logs", color: "text-secondary" },
] as const;

type IntelligenceLayer = (typeof INTELLIGENCE_LAYERS)[number]["label"];

export default function FilesPage() {
  const router = useRouter();
  const [files, setFiles] = useState<any[]>([]);
  const [loadingFiles, setLoadingFiles] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null); // Fix #2
  const [search, setSearch] = useState("");
  const [selectedLayer, setSelectedLayer] = useState<IntelligenceLayer | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Fix #2: extracted so Retry button can call it
  const loadFiles = async () => {
    setLoadingFiles(true);
    setFetchError(null);
    try {
      const res = await fetch('/api/files');
      if (!res.ok) throw new Error(`Server returned ${res.status}`);
      const data = await res.json();
      setFiles(data);
    } catch (err: any) {
      console.error('Failed to load files', err);
      setFetchError(err.message ?? 'Failed to load files');
    } finally {
      setLoadingFiles(false);
    }
  };

  useEffect(() => {
    loadFiles();
  }, []);

  const handleUpload = () => {
    fileInputRef.current?.click();
  };

  const handleFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files;
    if (!selected || selected.length === 0) return;

    const fileList = Array.from(selected);
    e.target.value = "";

    for (const file of fileList) {
      const ext = file.name.split(".").pop()?.toUpperCase() || "FILE";
      const sizeMB = file.size / (1024 * 1024);
      const sizeStr = sizeMB >= 1 ? `${sizeMB.toFixed(1)} MB` : `${(file.size / 1024).toFixed(0)} KB`;

      const nameLower = file.name.toLowerCase();
      let layer = 'Internal Wiki' as IntelligenceLayer;
      if (nameLower.includes('invoice') || nameLower.includes('financial') || nameLower.includes('tax') || ext === 'XLSX' || ext === 'CSV') {
        layer = 'Financial Records';
      } else if (nameLower.includes('contract') || nameLower.includes('legal') || nameLower.includes('nda') || nameLower.includes('agreement')) {
        layer = 'Legal Discovery';
      } else if (nameLower.includes('audit') || nameLower.includes('log')) {
        layer = 'Audit Logs';
      }

      const placeholder = {
        name: file.name,
        type: ext,
        size: sizeStr,
        date: "Just now",
        status: "Uploading" as string,
        risk: "Low" as string,
        layer,
      };
      setFiles((prev) => [placeholder, ...prev]);

      try {
        const body = new FormData();
        body.append("file", file);

        const res = await fetch("/api/files/upload", { method: "POST", body });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Upload failed");

        // Fix #3: spread full API response so id is merged (delete depends on it)
        setFiles((prev) =>
          prev.map((f) =>
            f.name === file.name && f.status === "Uploading"
              ? { ...f, ...data, status: "Indexing" }
              : f
          )
        );

        // Status stays "Indexing" — the real indexed_at is set by the background
        // worker after text extraction completes. GET /api/files returns the live
        // status from last_indexed_at, so a page refresh will show the true state.
        toast.success(`Uploaded ${file.name}`, {
          icon: <Upload className="w-4 h-4" />,
          description: "File stored and queued for indexing.",
        });
      } catch (err: any) {
        setFiles((prev) =>
          prev.map((f) =>
            f.name === file.name && f.status === "Uploading"
              ? { ...f, status: "Flagged" }
              : f
          )
        );
        toast.error(`Failed to upload ${file.name}`, {
          description: err.message,
        });
      }
    }
  };

  // Fix #4: real navigation instead of fake toast
  const handleNewRepo = () => {
    router.push('/admin/integrations');
  };

  // Fix #9: find by id first, fall back to name; caller now passes id when available
  const handleDelete = async (fileId: string) => {
    const file = files.find(f => f.id === fileId || f.name === fileId) as any;
    setFiles(prev => prev.filter(f => (f.id ?? f.name) !== fileId));

    if (file?.id) {
      try {
        const res = await fetch(`/api/files?id=${encodeURIComponent(file.id)}`, { method: 'DELETE' });
        if (!res.ok) {
          const data = await res.json();
          setFiles(prev => [file, ...prev]);
          toast.error(`Failed to delete ${file.name}`, { description: data.error });
          return;
        }
      } catch {
        setFiles(prev => [file, ...prev]);
        toast.error(`Network error deleting ${file.name}`);
        return;
      }
    }

    toast.success(`File removed from Knowledge Graph`, {
      description: file?.name ?? fileId,
    });
  };

  const downloadBlob = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  const handleDownload = async (name: string) => {
    const file = files.find((item) => item.name === name) as any;
    toast(`Downloading ${name}...`);

    if (file?.storagePath) {
      const res = await fetch(`/api/files/download?path=${encodeURIComponent(file.storagePath)}`);
      if (res.ok) {
        const blob = await res.blob();
        downloadBlob(blob, name);
        toast.success(`Downloaded ${name}`);
        return;
      }
    }

    const blob = new Blob([JSON.stringify(file, null, 2)], { type: "application/json" });
    downloadBlob(blob, name);
    toast.success(`Downloaded ${name}`);
  };

  const handleBulkDownload = () => {
    const blob = new Blob(
      [JSON.stringify(filteredFiles, null, 2)],
      { type: "application/json" }
    );
    downloadBlob(blob, "athene-data-sources.json");
    toast.success("Downloaded data sources archive", {
      icon: <Download className="w-4 h-4" />,
    });
  };

  const layerCounts = INTELLIGENCE_LAYERS.reduce<Record<IntelligenceLayer, number>>((counts, layer) => {
    counts[layer.label] = files.filter((file) => file.layer === layer.label).length;
    return counts;
  }, {} as Record<IntelligenceLayer, number>);

  const filteredFiles = files.filter((file) => {
    const matchesSearch = file.name.toLowerCase().includes(search.toLowerCase());
    const matchesLayer = !selectedLayer || file.layer === selectedLayer;
    return matchesSearch && matchesLayer;
  });

  // Fix #7: capacity bar based on real file count
  const capacityPct = Math.min(files.length / 100, 1) * 100;

  return (
    <div className="max-w-7xl mx-auto space-y-12 pb-20 animate-in fade-in duration-700">
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept=".pdf,.docx,.doc,.xlsx,.xls,.pptx,.ppt,.csv,.json,.svg,.txt"
        className="hidden"
        onChange={handleFileSelected}
      />
      {/* Page Header */}
      <section className="flex flex-col md:flex-row md:items-end justify-between gap-8 border-b border-white/5 pb-10">
        <div className="space-y-4">
          <Badge className="bg-secondary/10 text-secondary border-none px-3 py-1 text-[10px] uppercase tracking-widest font-bold">
            Knowledge Base
          </Badge>
          <h1 className="text-4xl lg:text-5xl font-black tracking-tight text-white">
            Enterprise <span className="text-secondary">Files</span>
          </h1>
          <p className="text-slate-400 text-lg max-w-xl font-medium leading-relaxed">
            Secure, centralized management of your organization's unstructured data repository.
          </p>
        </div>

        <div className="flex gap-4">
           <Button
            onClick={handleUpload}
            variant="outline" className="h-14 px-8 rounded-2xl border-white/10 text-slate-300 font-bold uppercase tracking-widest text-[10px] gap-3 hover:bg-white/5 transition-all">
              <Upload className="w-5 h-5 text-secondary" />
              Upload Data
           </Button>
           <button
            onClick={handleNewRepo}
            className="h-14 px-10 rounded-2xl bg-primary text-white font-bold uppercase tracking-widest text-[10px] gap-3 shadow-lg shadow-[var(--shadow-2)] transition-all active:scale-95 flex items-center justify-center relative overflow-visible">
              <div className="absolute -left-2 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full border-2 border-[#06080c] bg-white flex items-center justify-center shadow-lg">
                 <img src="/logo.png" alt="Logo" className="w-4 h-4 object-contain" />
              </div>
              <span className="ml-4">New Repository</span>
           </button>
        </div>
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-10">
        {/* Sidebar Analytics */}
        <div className="space-y-10">
           <Card className="bg-white/5 backdrop-blur-xl border border-white/10 p-10 space-y-8 rounded-[2rem]">
              <h3 className="text-[11px] uppercase tracking-[0.2em] font-bold text-slate-500">Storage Load</h3>
              <div className="space-y-8">
                 {/* Fix #7: real file count instead of hardcoded 84% */}
                 <div className="space-y-4">
                    <div className="flex items-center justify-between text-[11px] font-bold uppercase tracking-widest">
                       <span className="flex items-center gap-2 text-slate-300"><HardDrive className="w-4 h-4 text-secondary" /> Capacity</span>
                       <span className="text-secondary">{files.length} files</span>
                    </div>
                    <div className="h-1.5 w-full bg-white/5 rounded-full overflow-hidden">
                       <div className="h-full bg-secondary" style={{ width: `${capacityPct}%` }} />
                    </div>
                 </div>
                 <div className="space-y-4">
                    <div className="flex items-center justify-between text-[11px] font-bold uppercase tracking-widest">
                       <span className="flex items-center gap-2 text-slate-300"><Cloud className="w-4 h-4 text-secondary" /> AI Sync</span>
                       <span className="text-emerald-500">Stable</span>
                    </div>
                    <div className="h-1.5 w-full bg-white/5 rounded-full overflow-hidden">
                       <div className="h-full bg-emerald-500" style={{ width: '100%' }} />
                    </div>
                 </div>
              </div>
           </Card>

           <div className="space-y-4 px-2">
              <h3 className="text-[11px] uppercase tracking-[0.2em] font-bold text-slate-500">Intelligence Layers</h3>
              <div className="space-y-2">
                 {INTELLIGENCE_LAYERS.map((cat) => {
                    const isSelected = selectedLayer === cat.label;
                    return (
                    <button
                      key={cat.label}
                      onClick={() => setSelectedLayer(isSelected ? null : cat.label)}
                      className={`w-full flex items-center justify-between p-3.5 rounded-xl border transition-all group text-left ${
                        isSelected
                          ? "bg-white/10 border-secondary/30"
                          : "border-transparent hover:bg-white/5 hover:border-white/10"
                      }`}
                    >
                       <span className={`text-[13px] font-bold flex items-center gap-3 ${
                        isSelected ? "text-white" : "text-slate-400 group-hover:text-white"
                       }`}>
                          <Layers className={`w-4 h-4 ${cat.color}`} />
                          {cat.label}
                       </span>
                       <Badge className="bg-white/5 text-slate-500 border-none text-[10px] font-bold group-hover:text-secondary transition-colors">{layerCounts[cat.label]}</Badge>
                    </button>
                    );
                 })}
              </div>
           </div>
        </div>

        {/* File Table Content */}
        <div className="lg:col-span-3 space-y-8">
           {/* Fix #2: error banner with retry */}
           {fetchError && (
             <div className="flex items-center gap-4 bg-rose-500/10 border border-rose-500/20 rounded-2xl px-6 py-4">
               <AlertCircle className="w-5 h-5 text-rose-400 shrink-0" />
               <p className="text-[13px] font-medium text-rose-300 flex-1">Failed to load files: {fetchError}</p>
               <Button
                 onClick={loadFiles}
                 variant="outline"
                 className="h-9 px-4 rounded-xl border-rose-500/30 text-rose-300 text-[11px] font-bold uppercase tracking-widest hover:bg-rose-500/10"
               >
                 Retry
               </Button>
             </div>
           )}

           <div className="flex items-center justify-between bg-white/5 backdrop-blur-xl border border-white/10 p-5 rounded-2xl shadow-sm">
              <div className="relative group w-80">
                 <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4.5 h-4.5 text-slate-500 group-focus-within:text-secondary transition-colors" />
                 <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search organizational data..." className="h-12 pl-12 rounded-xl bg-black/20 border-white/5 text-[13px] text-white focus:ring-secondary/20 placeholder:text-slate-600" />
              </div>
              <div className="flex items-center gap-4">
                 <Button
                  variant="ghost"
                  onClick={() => setSelectedLayer(null)}
                  className="h-12 px-6 rounded-xl text-slate-400 font-bold uppercase tracking-widest text-[10px] gap-2 hover:bg-white/5 hover:text-white"
                 >
                    <Filter className="w-4 h-4" />
                    {selectedLayer ?? "Filters"}
                 </Button>
                 <div className="h-8 w-px bg-white/10" />
                 <Button
                  onClick={handleBulkDownload}
                  variant="ghost" size="icon" className="h-12 w-12 rounded-xl hover:bg-secondary/10 text-secondary">
                    <Download className="w-5 h-5" />
                 </Button>
              </div>
           </div>

           <Card className="bg-white/5 backdrop-blur-xl border border-white/10 overflow-hidden rounded-[2rem]">
              <Table>
                 <TableHeader className="bg-white/[0.02]">
                    <TableRow className="border-white/5">
                       <TableHead className="px-10 py-6 text-[11px] font-bold uppercase tracking-widest text-slate-500">Asset Name</TableHead>
                       <TableHead className="py-6 text-[11px] font-bold uppercase tracking-widest text-slate-500">Size</TableHead>
                       <TableHead className="py-6 text-[11px] font-bold uppercase tracking-widest text-slate-500">Status</TableHead>
                       <TableHead className="py-6 text-[11px] font-bold uppercase tracking-widest text-slate-500">Risk Profile</TableHead>
                       <TableHead className="py-6 text-[11px] font-bold uppercase tracking-widest text-slate-500 text-right pr-10">Actions</TableHead>
                    </TableRow>
                 </TableHeader>
                 <TableBody>
                    {/* Fix #1: skeleton rows while loading */}
                    {loadingFiles ? (
                      [...Array(3)].map((_, i) => (
                        <TableRow key={`skeleton-${i}`} className="border-white/5">
                          <TableCell className="px-10 py-6">
                            <div className="flex items-center gap-4">
                              <div className="h-11 w-11 rounded-xl bg-white/5 animate-pulse" />
                              <div className="space-y-2">
                                <div className="h-3 w-40 bg-white/5 rounded-full animate-pulse" />
                                <div className="h-2 w-20 bg-white/5 rounded-full animate-pulse" />
                              </div>
                            </div>
                          </TableCell>
                          <TableCell><div className="h-3 w-12 bg-white/5 rounded-full animate-pulse" /></TableCell>
                          <TableCell><div className="h-5 w-16 bg-white/5 rounded-full animate-pulse" /></TableCell>
                          <TableCell><div className="h-3 w-20 bg-white/5 rounded-full animate-pulse" /></TableCell>
                          <TableCell />
                        </TableRow>
                      ))
                    ) : filteredFiles.length === 0 ? (
                      <TableRow className="border-white/5">
                        <TableCell colSpan={5} className="py-24 text-center">
                          <div className="flex flex-col items-center justify-center space-y-3">
                            <Search className="w-10 h-10 text-slate-600" />
                            <p className="text-[14px] font-bold text-white">No results found</p>
                            <p className="text-[12px] font-medium text-slate-500">We couldn't find any files matching your search.</p>
                          </div>
                        </TableCell>
                      </TableRow>
                    ) : (
                      // Fix #8: use file.id ?? file.name as key (not array index)
                      filteredFiles.map((file) => (
                         <TableRow key={file.id ?? file.name} className="border-white/5 hover:bg-white/[0.02] transition-all group">
                            <TableCell className="px-10 py-6">
                               <div className="flex items-center gap-4">
                                  <div className="h-11 w-11 rounded-xl bg-black/20 flex items-center justify-center border border-white/5 shadow-sm group-hover:scale-105 transition-transform">
                                     <FileText className={`w-5 h-5 ${
                                        file.type === 'PDF' ? 'text-secondary' :
                                        file.type === 'XLSX' ? 'text-emerald-500' :
                                        file.type === 'DOCX' ? 'text-secondary' :
                                        'text-secondary'
                                     }`} />
                                  </div>
                                  <div className="flex flex-col">
                                     <span className="text-[14px] font-bold text-white group-hover:text-secondary transition-colors">{file.name}</span>
                                     <span className="text-[11px] font-medium text-slate-500 mt-0.5">{file.date}</span>
                                  </div>
                               </div>
                            </TableCell>
                            <TableCell className="text-[13px] font-bold text-slate-300">{file.size}</TableCell>
                            <TableCell>
                               <Badge className={`text-[10px] font-bold tracking-widest px-3 py-1 h-6 border-none ${
                                  file.status === 'Indexed' ? 'bg-emerald-500/10 text-emerald-400' :
                                  file.status === 'Indexing' ? 'bg-secondary/10 text-secondary animate-pulse' :
                                  'bg-rose-500/10 text-rose-400'
                               }`}>
                                  {file.status}
                               </Badge>
                            </TableCell>
                            <TableCell>
                               <div className="flex items-center gap-2.5">
                                  <div className={`h-2 w-2 rounded-full ${
                                     file.risk === 'Low' ? 'bg-emerald-500 shadow-[0_0_8px_#10b981]' :
                                     file.risk === 'Medium' ? 'bg-amber-500 shadow-[0_0_8px_#f59e0b]' : 'bg-rose-600 shadow-[0_0_8px_#e11d48]'
                                  }`} />
                                  <span className="text-[12px] font-bold text-slate-400">{file.risk} Profile</span>
                               </div>
                            </TableCell>
                            <TableCell className="text-right pr-10">
                               <div className="flex items-center justify-end gap-3 opacity-0 group-hover:opacity-100 transition-opacity">
                                  {/* Fix #11: retry button visible only for flagged files */}
                                  {file.status === 'Flagged' && (
                                    <Button
                                      onClick={() => {
                                        setFiles(prev => prev.filter(f => (f.id ?? f.name) !== (file.id ?? file.name)));
                                        fileInputRef.current?.click();
                                      }}
                                      variant="ghost" size="icon"
                                      className="h-10 w-10 rounded-xl hover:bg-amber-500/10 text-amber-400"
                                      title="Retry upload"
                                    >
                                      <RotateCcw className="w-4 h-4" />
                                    </Button>
                                  )}

                                  {/* Fix #5 / #13: share disabled with "Coming soon" tooltip */}
                                  <TooltipProvider>
                                     <Tooltip>
                                        <TooltipTrigger asChild>
                                           <Button
                                            disabled
                                            variant="ghost" size="icon" className="h-10 w-10 rounded-xl text-slate-400 disabled:opacity-40 disabled:cursor-not-allowed">
                                              <Share2 className="w-4 h-4" />
                                           </Button>
                                        </TooltipTrigger>
                                        <TooltipContent className="bg-black text-white border-white/10 text-[10px] font-bold uppercase tracking-widest">Coming soon</TooltipContent>
                                     </Tooltip>
                                  </TooltipProvider>

                                  <Button
                                    onClick={() => handleDownload(file.name)}
                                    variant="ghost" size="icon" className="h-10 w-10 rounded-xl hover:bg-white/5 text-slate-400">
                                     <Download className="w-4 h-4" />
                                  </Button>

                                  {/* Fix #9: pass id (or name fallback) so delete finds the right record */}
                                  <Button
                                    onClick={() => handleDelete(file.id ?? file.name)}
                                    variant="ghost" size="icon" className="h-10 w-10 rounded-xl hover:bg-rose-500/10 text-rose-400">
                                     <Trash2 className="w-4 h-4" />
                                  </Button>
                               </div>
                            </TableCell>
                         </TableRow>
                      ))
                    )}
                 </TableBody>
              </Table>
           </Card>

           {/* Fix #6: static file count instead of fake "Browse Full Archive" toast */}
           <div className="flex items-center justify-center py-10">
              <p className="text-slate-500 text-[11px] font-bold uppercase tracking-widest">
                Showing {filteredFiles.length} of {files.length} files
              </p>
           </div>
        </div>
      </div>
    </div>
  );
}
