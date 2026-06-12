"use client";

import { TCard } from "@/components/ui/kit";
import { useRef, useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  FileText,
  Upload,
  Trash2,
  Download,
  Search,
  Filter,
  HardDrive,
  Cloud,
  Layers,
  RotateCcw,
  AlertCircle,
  WifiOff,
  X,
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
import { classifyFileLayer, type IntelligenceLayer } from "@/lib/files/classify-layer";

// ── Types ────────────────────────────────────────────────────

interface FileRecord {
  id?: string;           // undefined while placeholder upload is in-flight
  name: string;
  type: string;
  size: string;
  date: string;
  status: "Indexed" | "Indexing" | "Uploading" | "Flagged";
  risk: "Low" | "Medium" | "High";
  layer: IntelligenceLayer;
}

const INTELLIGENCE_LAYERS = [
  { label: "Financial Records" as IntelligenceLayer, color: "text-emerald-500" },
  { label: "Legal Discovery"  as IntelligenceLayer, color: "text-amber-500" },
  { label: "Internal Wiki"    as IntelligenceLayer, color: "text-secondary" },
  { label: "Audit Logs"       as IntelligenceLayer, color: "text-secondary" },
];

// ── Delete-confirm dialog ────────────────────────────────────

function DeleteConfirmDialog({
  file,
  onConfirm,
  onCancel,
  loading,
}: {
  file: FileRecord;
  onConfirm: () => void;
  onCancel: () => void;
  loading: boolean;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-md animate-in fade-in duration-300">
      <div className="bg-card border border-border shadow-2xl p-8 max-w-sm w-full mx-4 rounded-3xl animate-in zoom-in-95 duration-300">
        <div className="flex items-start justify-between mb-6">
          <div className="w-12 h-12 rounded-2xl bg-destructive/10 flex items-center justify-center border border-destructive/20">
            <WifiOff className="w-6 h-6 text-destructive" />
          </div>
          <Button variant="ghost" size="icon" onClick={onCancel} className="rounded-full hover:bg-muted">
            <X className="w-5 h-5 text-muted-foreground" />
          </Button>
        </div>
        <h3 className="text-xl font-black text-foreground tracking-tight mb-2">Delete file?</h3>
        <p className="text-sm text-muted-foreground leading-relaxed mb-2">
          <span className="font-bold text-foreground">{file.name}</span>
        </p>
        <p className="text-sm text-muted-foreground leading-relaxed mb-8">
          This will permanently remove the file and all its indexed content from the Knowledge Graph. This action cannot be undone.
        </p>
        <div className="flex gap-3">
          <Button variant="outline" onClick={onCancel} className="flex-1 h-12 rounded-xl border-border hover:bg-muted font-bold">
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={onConfirm}
            disabled={loading}
            className="flex-1 h-12 rounded-xl font-bold shadow-lg shadow-destructive/20"
          >
            {loading ? "Deleting…" : "Delete"}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────

export default function FilesPage() {
  const router = useRouter();
  const [files, setFiles] = useState<FileRecord[]>([]);
  const [totalFiles, setTotalFiles] = useState(0);
  const [loadingFiles, setLoadingFiles] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [selectedLayer, setSelectedLayer] = useState<IntelligenceLayer | null>(null);
  const [pendingDelete, setPendingDelete] = useState<FileRecord | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  // Store original File objects so the "Retry" button can re-upload without
  // re-opening the generic file picker.
  const failedFilesRef = useRef<Map<string, File>>(new Map());

  const loadFiles = useCallback(async () => {
    setLoadingFiles(true);
    setFetchError(null);
    try {
      const res = await fetch('/api/files');
      if (!res.ok) throw new Error(`Server returned ${res.status}`);
      const data = await res.json();
      // API now returns { files, total } — handle both shapes for safety
      const fileList: FileRecord[] = Array.isArray(data) ? data : (data.files ?? []);
      setFiles(fileList);
      setTotalFiles(Array.isArray(data) ? fileList.length : (data.total ?? fileList.length));
    } catch (err: any) {
      setFetchError(err.message ?? 'Failed to load files');
    } finally {
      setLoadingFiles(false);
    }
  }, []);

  useEffect(() => { loadFiles(); }, [loadFiles]);

  const handleUpload = () => { fileInputRef.current?.click(); };

  const uploadFile = useCallback(async (file: File) => {
    const ext = file.name.split(".").pop()?.toUpperCase() || "FILE";
    const sizeMB = file.size / (1024 * 1024);
    const sizeStr = sizeMB >= 1 ? `${sizeMB.toFixed(1)} MB` : `${(file.size / 1024).toFixed(0)} KB`;
    const layer = classifyFileLayer(file.name, ext);

    const placeholder: FileRecord = {
      name: file.name,
      type: ext,
      size: sizeStr,
      date: "Just now",
      status: "Uploading",
      risk: "Low",
      layer,
    };
    setFiles((prev) => [placeholder, ...prev]);
    setTotalFiles((t) => t + 1);

    try {
      const body = new FormData();
      body.append("file", file);
      const res = await fetch("/api/files/upload", { method: "POST", body });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Upload failed");

      setFiles((prev) =>
        prev.map((f) =>
          f.name === file.name && f.status === "Uploading"
            ? { ...f, ...data, status: "Indexing" as const }
            : f
        )
      );
      failedFilesRef.current.delete(file.name);
      toast.success(`Uploaded ${file.name}`, {
        icon: <Upload className="w-4 h-4" />,
        description: "File stored and queued for indexing.",
      });
    } catch (err: any) {
      failedFilesRef.current.set(file.name, file);
      setFiles((prev) =>
        prev.map((f) =>
          f.name === file.name && f.status === "Uploading"
            ? { ...f, status: "Flagged" as const }
            : f
        )
      );
      toast.error(`Failed to upload ${file.name}`, { description: err.message });
    }
  }, []);

  const handleFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files;
    if (!selected || selected.length === 0) return;
    const fileList = Array.from(selected);
    e.target.value = "";
    for (const file of fileList) await uploadFile(file);
  };

  const handleRetry = useCallback((file: FileRecord) => {
    const original = failedFilesRef.current.get(file.name);
    if (original) {
      // Re-upload the exact file object without reopening the picker
      setFiles((prev) => prev.filter((f) => (f.id ?? f.name) !== (file.id ?? file.name)));
      setTotalFiles((t) => Math.max(0, t - 1));
      uploadFile(original);
    } else {
      // Fallback: remove stale entry and let the user pick again
      setFiles((prev) => prev.filter((f) => (f.id ?? f.name) !== (file.id ?? file.name)));
      setTotalFiles((t) => Math.max(0, t - 1));
      fileInputRef.current?.click();
    }
  }, [uploadFile]);

  const handleNewRepo = () => { router.push('/admin/integrations'); };

  const confirmDelete = useCallback(async () => {
    if (!pendingDelete) return;
    const file = pendingDelete;
    const fileKey = file.id ?? file.name;
    setDeletingId(fileKey);

    // Optimistic removal
    setFiles((prev) => prev.filter((f) => (f.id ?? f.name) !== fileKey));
    setTotalFiles((t) => Math.max(0, t - 1));
    setPendingDelete(null);

    if (file.id) {
      try {
        const res = await fetch(`/api/files?id=${encodeURIComponent(file.id)}`, { method: 'DELETE' });
        if (!res.ok) {
          const data = await res.json();
          setFiles((prev) => [file, ...prev]);
          setTotalFiles((t) => t + 1);
          toast.error(`Failed to delete ${file.name}`, { description: data.error });
          setDeletingId(null);
          return;
        }
      } catch {
        setFiles((prev) => [file, ...prev]);
        setTotalFiles((t) => t + 1);
        toast.error(`Network error deleting ${file.name}`);
        setDeletingId(null);
        return;
      }
    }

    toast.success("File removed from Knowledge Graph", { description: file.name });
    setDeletingId(null);
  }, [pendingDelete]);

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

  const handleDownload = async (file: FileRecord) => {
    toast(`Downloading ${file.name}…`);

    if (file.id) {
      try {
        const res = await fetch(`/api/files/download?id=${encodeURIComponent(file.id)}`);
        if (res.ok) {
          const blob = await res.blob();
          downloadBlob(blob, file.name);
          toast.success(`Downloaded ${file.name}`);
          return;
        }
      } catch {
        // fall through to metadata fallback
      }
    }

    // Fallback for placeholder files (upload just completed, no id yet):
    // download the available metadata as JSON so the user has something.
    const blob = new Blob([JSON.stringify(file, null, 2)], { type: "application/json" });
    downloadBlob(blob, `${file.name}.meta.json`);
    toast(`Downloaded metadata for ${file.name} — refresh to download the original file.`);
  };

  const handleBulkExport = () => {
    // Exports a JSON manifest of visible file metadata — NOT the binary files.
    const blob = new Blob([JSON.stringify(filteredFiles, null, 2)], { type: "application/json" });
    downloadBlob(blob, "athene-file-manifest.json");
    toast.success("Exported file manifest (JSON metadata)", {
      icon: <Download className="w-4 h-4" />,
      description: "To download individual files, use the row download button.",
    });
  };

  const layerCounts = INTELLIGENCE_LAYERS.reduce<Record<IntelligenceLayer, number>>((counts, layer) => {
    counts[layer.label] = files.filter((f) => f.layer === layer.label).length;
    return counts;
  }, {} as Record<IntelligenceLayer, number>);

  const filteredFiles = files.filter((file) => {
    const matchesSearch = file.name.toLowerCase().includes(search.toLowerCase());
    const matchesLayer = !selectedLayer || file.layer === selectedLayer;
    return matchesSearch && matchesLayer;
  });

  // Capacity bar: based on real total byte count derived from size strings.
  // Soft cap at 5 GB for display purposes.
  const totalBytes = files.reduce((sum, f) => {
    const match = f.size.match(/([\d.]+)\s*(MB|KB|GB)/i);
    if (!match) return sum;
    const n = parseFloat(match[1]);
    const unit = match[2].toUpperCase();
    if (unit === "GB") return sum + n * 1024 * 1024 * 1024;
    if (unit === "MB") return sum + n * 1024 * 1024;
    if (unit === "KB") return sum + n * 1024;
    return sum;
  }, 0);
  const SOFT_CAP_BYTES = 5 * 1024 * 1024 * 1024; // 5 GB
  const capacityPct = Math.min(totalBytes / SOFT_CAP_BYTES, 1) * 100;
  const totalSizeLabel = totalBytes >= 1024 * 1024 * 1024
    ? `${(totalBytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
    : totalBytes >= 1024 * 1024
      ? `${(totalBytes / (1024 * 1024)).toFixed(1)} MB`
      : `${(totalBytes / 1024).toFixed(0)} KB`;

  return (
    <div className="max-w-7xl mx-auto space-y-12 pb-20">
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept=".pdf,.docx,.doc,.xlsx,.xls,.pptx,.ppt,.csv,.json,.txt,.md"
        className="hidden"
        onChange={handleFileSelected}
      />

      {/* Delete confirmation dialog */}
      {pendingDelete && (
        <DeleteConfirmDialog
          file={pendingDelete}
          onConfirm={confirmDelete}
          onCancel={() => setPendingDelete(null)}
          loading={!!deletingId}
        />
      )}

      {/* Page Header */}
      <TCard i={0} as="section" className="flex flex-col md:flex-row md:items-end justify-between gap-8 border-b border-border pb-10">
        <div className="space-y-4">
          <Badge className="bg-secondary/10 text-secondary border-none px-3 py-1 text-[10px] uppercase tracking-widest font-bold">
            Knowledge Base
          </Badge>
          <h1 className="text-4xl lg:text-5xl font-black tracking-tight text-white">
            Enterprise <span className="text-secondary">Files</span>
          </h1>
          <p className="text-muted-foreground text-lg max-w-xl font-medium leading-relaxed">
            Secure, centralized management of your organization's unstructured data repository.
          </p>
        </div>

        <div className="flex gap-4">
          <Button
            onClick={handleUpload}
            variant="outline"
            className="h-14 px-8 rounded-2xl border-border text-foreground/80 font-bold uppercase tracking-widest text-[10px] gap-3 hover:bg-muted transition-all"
          >
            <Upload className="w-5 h-5 text-secondary" />
            Upload Data
          </Button>
          <button
            onClick={handleNewRepo}
            className="h-14 px-10 rounded-2xl bg-primary text-white font-bold uppercase tracking-widest text-[10px] gap-3 shadow-lg shadow-[var(--shadow-2)] transition-all active:scale-95 flex items-center justify-center relative overflow-visible"
          >
            <div className="absolute -left-2 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full border-2 border-[#06080c] bg-white flex items-center justify-center shadow-lg">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/logo.png" alt="Logo" className="w-4 h-4 object-contain" />
            </div>
            <span className="ml-4">New Repository</span>
          </button>
        </div>
      </TCard>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-10">
        {/* Sidebar Analytics */}
        <div className="space-y-10">
          <Card className="bg-muted backdrop-blur-xl border border-border p-10 space-y-8 rounded-3xl">
            <h3 className="text-[11px] uppercase tracking-[0.2em] font-bold text-muted-foreground">Storage Load</h3>
            <div className="space-y-8">
              <div className="space-y-4">
                <div className="flex items-center justify-between text-[11px] font-bold uppercase tracking-widest">
                  <span className="flex items-center gap-2 text-foreground/80"><HardDrive className="w-4 h-4 text-secondary" /> Capacity</span>
                  <span className="text-secondary">{totalSizeLabel}</span>
                </div>
                <div className="h-1.5 w-full bg-muted rounded-full overflow-hidden">
                  <div className="h-full bg-secondary transition-all duration-500" style={{ width: `${capacityPct}%` }} />
                </div>
                <p className="text-[10px] text-muted-foreground font-bold uppercase tracking-widest">
                  {files.length} file{files.length !== 1 ? 's' : ''} · soft cap 5 GB
                </p>
              </div>
              <div className="space-y-4">
                <div className="flex items-center justify-between text-[11px] font-bold uppercase tracking-widest">
                  <span className="flex items-center gap-2 text-foreground/80"><Cloud className="w-4 h-4 text-secondary" /> AI Sync</span>
                  <span className="text-emerald-500">Stable</span>
                </div>
                <div className="h-1.5 w-full bg-muted rounded-full overflow-hidden">
                  <div className="h-full bg-emerald-500" style={{ width: '100%' }} />
                </div>
              </div>
            </div>
          </Card>

          <div className="space-y-4 px-2">
            <h3 className="text-[11px] uppercase tracking-[0.2em] font-bold text-muted-foreground">Intelligence Layers</h3>
            <div className="space-y-2">
              {INTELLIGENCE_LAYERS.map((cat) => {
                const isSelected = selectedLayer === cat.label;
                return (
                  <button
                    key={cat.label}
                    onClick={() => setSelectedLayer(isSelected ? null : cat.label)}
                    className={`w-full flex items-center justify-between p-3.5 rounded-xl border transition-all group text-left ${
                      isSelected ? "bg-muted border-secondary/30" : "border-transparent hover:bg-muted hover:border-border"
                    }`}
                  >
                    <span className={`text-[13px] font-bold flex items-center gap-3 ${isSelected ? "text-white" : "text-muted-foreground group-hover:text-white"}`}>
                      <Layers className={`w-4 h-4 ${cat.color}`} />
                      {cat.label}
                    </span>
                    <Badge className="bg-muted text-muted-foreground border-none text-[10px] font-bold group-hover:text-secondary transition-colors">
                      {layerCounts[cat.label]}
                    </Badge>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* File Table */}
        <div className="lg:col-span-3 space-y-8">
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

          <div className="flex items-center justify-between bg-muted backdrop-blur-xl border border-border p-5 rounded-2xl shadow-sm">
            <div className="relative group w-80">
              <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4.5 h-4.5 text-muted-foreground group-focus-within:text-secondary transition-colors" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search organizational data..."
                className="h-12 pl-12 rounded-xl bg-black/20 border-border text-[13px] text-white focus:ring-secondary/20 placeholder:text-muted-foreground"
              />
            </div>
            <div className="flex items-center gap-4">
              <Button
                variant="ghost"
                onClick={() => setSelectedLayer(null)}
                className="h-12 px-6 rounded-xl text-muted-foreground font-bold uppercase tracking-widest text-[10px] gap-2 hover:bg-muted hover:text-white"
              >
                <Filter className="w-4 h-4" />
                {selectedLayer ?? "Filters"}
              </Button>
              <div className="h-8 w-px bg-muted" />
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    onClick={handleBulkExport}
                    variant="ghost"
                    size="icon"
                    className="h-12 w-12 rounded-xl hover:bg-secondary/10 text-secondary"
                  >
                    <Download className="w-5 h-5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent className="bg-black text-white border-border text-xs">
                  Export file manifest (JSON metadata)
                </TooltipContent>
              </Tooltip>
            </div>
          </div>

          <Card className="bg-muted backdrop-blur-xl border border-border overflow-hidden rounded-3xl">
            <Table>
              <TableHeader className="bg-muted/40">
                <TableRow className="border-border">
                  <TableHead className="px-10 py-6 text-[11px] font-bold uppercase tracking-widest text-muted-foreground">Asset Name</TableHead>
                  <TableHead className="py-6 text-[11px] font-bold uppercase tracking-widest text-muted-foreground">Size</TableHead>
                  <TableHead className="py-6 text-[11px] font-bold uppercase tracking-widest text-muted-foreground">Status</TableHead>
                  <TableHead className="py-6 text-[11px] font-bold uppercase tracking-widest text-muted-foreground">Risk Profile</TableHead>
                  <TableHead className="py-6 text-[11px] font-bold uppercase tracking-widest text-muted-foreground text-right pr-10">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loadingFiles ? (
                  [...Array(3)].map((_, i) => (
                    <TableRow key={`skeleton-${i}`} className="border-border">
                      <TableCell className="px-10 py-6">
                        <div className="flex items-center gap-4">
                          <div className="h-11 w-11 rounded-xl bg-muted animate-pulse" />
                          <div className="space-y-2">
                            <div className="h-3 w-40 bg-muted rounded-full animate-pulse" />
                            <div className="h-2 w-20 bg-muted rounded-full animate-pulse" />
                          </div>
                        </div>
                      </TableCell>
                      <TableCell><div className="h-3 w-12 bg-muted rounded-full animate-pulse" /></TableCell>
                      <TableCell><div className="h-5 w-16 bg-muted rounded-full animate-pulse" /></TableCell>
                      <TableCell><div className="h-3 w-20 bg-muted rounded-full animate-pulse" /></TableCell>
                      <TableCell />
                    </TableRow>
                  ))
                ) : filteredFiles.length === 0 ? (
                  <TableRow className="border-border">
                    <TableCell colSpan={5} className="py-24 text-center">
                      <div className="flex flex-col items-center justify-center space-y-3">
                        <Search className="w-10 h-10 text-muted-foreground" />
                        <p className="text-[14px] font-bold text-white">No results found</p>
                        <p className="text-[12px] font-medium text-muted-foreground">We couldn't find any files matching your search.</p>
                      </div>
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredFiles.map((file) => {
                    const fileKey = file.id ?? file.name;
                    const isDeleting = deletingId === fileKey;
                    return (
                      <TableRow
                        key={fileKey}
                        className={`border-border hover:bg-muted/40 transition-all group ${isDeleting ? "opacity-40 pointer-events-none" : ""}`}
                      >
                        <TableCell className="px-10 py-6">
                          <div className="flex items-center gap-4">
                            <div className="h-11 w-11 rounded-xl bg-black/20 flex items-center justify-center border border-border shadow-sm group-hover:scale-105 transition-transform">
                              <FileText className={`w-5 h-5 ${
                                file.type === 'PDF' ? 'text-secondary' :
                                file.type === 'XLSX' || file.type === 'XLS' ? 'text-emerald-500' :
                                'text-secondary'
                              }`} />
                            </div>
                            <div className="flex flex-col">
                              <span className="text-[14px] font-bold text-white group-hover:text-secondary transition-colors">{file.name}</span>
                              <span className="text-[11px] font-medium text-muted-foreground mt-0.5">{file.date}</span>
                            </div>
                          </div>
                        </TableCell>
                        <TableCell className="text-[13px] font-bold text-foreground/80">{file.size}</TableCell>
                        <TableCell>
                          <Badge className={`text-[10px] font-bold tracking-widest px-3 py-1 h-6 border-none ${
                            file.status === 'Indexed'   ? 'bg-emerald-500/10 text-emerald-400' :
                            file.status === 'Indexing'  ? 'bg-secondary/10 text-secondary animate-pulse' :
                            file.status === 'Uploading' ? 'bg-muted text-white animate-pulse' :
                            'bg-rose-500/10 text-rose-400'
                          }`}>
                            {file.status}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2.5">
                            <div className={`h-2 w-2 rounded-full ${
                              file.risk === 'Low'    ? 'bg-emerald-500 shadow-[0_0_8px_#10b981]' :
                              file.risk === 'Medium' ? 'bg-amber-500  shadow-[0_0_8px_#f59e0b]' :
                                                       'bg-rose-600   shadow-[0_0_8px_#e11d48]'
                            }`} />
                            <span className="text-[12px] font-bold text-muted-foreground">{file.risk} Profile</span>
                          </div>
                        </TableCell>
                        <TableCell className="text-right pr-10">
                          <div className="flex items-center justify-end gap-3 opacity-0 group-hover:opacity-100 transition-opacity">
                            {file.status === 'Flagged' && (
                              <Button
                                onClick={() => handleRetry(file)}
                                variant="ghost"
                                size="icon"
                                className="h-10 w-10 rounded-xl hover:bg-amber-500/10 text-amber-400"
                                title="Retry upload"
                              >
                                <RotateCcw className="w-4 h-4" />
                              </Button>
                            )}
                            <Button
                              onClick={() => handleDownload(file)}
                              variant="ghost"
                              size="icon"
                              className="h-10 w-10 rounded-xl hover:bg-muted text-muted-foreground"
                              title="Download file"
                            >
                              <Download className="w-4 h-4" />
                            </Button>
                            <Button
                              onClick={() => setPendingDelete(file)}
                              variant="ghost"
                              size="icon"
                              className="h-10 w-10 rounded-xl hover:bg-rose-500/10 text-rose-400"
                              title="Delete file"
                              disabled={isDeleting}
                            >
                              <Trash2 className="w-4 h-4" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </Card>

          <div className="flex items-center justify-center py-10">
            <p className="text-muted-foreground text-[11px] font-bold uppercase tracking-widest">
              Showing {filteredFiles.length} of {totalFiles} file{totalFiles !== 1 ? 's' : ''}
              {totalFiles > 200 && <span className="text-amber-500"> · 200 shown — use search to find more</span>}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
