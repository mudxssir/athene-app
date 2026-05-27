"use client";

import { useState, useEffect, useCallback } from "react";
import {
  X,
  Folder,
  FileText,
  ChevronRight,
  ChevronLeft,
  Loader2,
  Search,
  AlertCircle,
  CheckSquare,
  Square,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  webViewLink?: string;
  modifiedTime?: string;
  owners?: Array<{ displayName: string; emailAddress: string }>;
}

const FOLDER_MIME = "application/vnd.google-apps.folder";
const UNSYNCABLE_MIMES = new Set([
  "application/vnd.google-apps.shortcut",
  "application/vnd.google-apps.map",
  "application/vnd.google-apps.site",
  "application/vnd.google-apps.form",
  "application/vnd.google-apps.drawing",
  "application/vnd.google-apps.fusiontable",
  "application/vnd.google-apps.script",
]);

interface SelectedItem {
  id: string;
  name: string;
  type: "folder" | "file";
}

interface Breadcrumb {
  id: string | undefined;
  name: string;
}

interface DrivePickerModalProps {
  open: boolean;
  connectionId: string;
  onClose: () => void;
  onSuccess: () => void;
}

export function DrivePickerModal({ open, connectionId, onClose, onSuccess }: DrivePickerModalProps) {
  const [files, setFiles] = useState<DriveFile[]>([]);
  const [nextPageToken, setNextPageToken] = useState<string | null>(null);
  const [currentFolderId, setCurrentFolderId] = useState<string | undefined>(undefined);
  const [breadcrumbs, setBreadcrumbs] = useState<Breadcrumb[]>([{ id: undefined, name: "My Drive" }]);
  const [selectedItems, setSelectedItems] = useState<Map<string, SelectedItem>>(new Map());
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [departments, setDepartments] = useState<{ id: string; name: string }[]>([]);
  const [departmentId, setDepartmentId] = useState<string | null>(null);
  const [excludedMimeTypes, setExcludedMimeTypes] = useState<string[]>([]);

  useEffect(() => {
    if (!open) return;
    fetch("/api/admin/departments").then(res => res.json()).then(data => {
      setDepartments(data.departments ?? []);
    }).catch(console.error);
  }, [open]);

  const MIME_OPTIONS = [
    { label: "PDF Documents", value: "application/pdf" },
    { label: "Word (DOCX)", value: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
    { label: "Google Docs", value: "application/vnd.google-apps.document" },
    { label: "Google Sheets", value: "application/vnd.google-apps.spreadsheet" },
    { label: "Google Slides", value: "application/vnd.google-apps.presentation" },
    { label: "Images & Video", value: "application/vnd.google-apps.photo" },
  ];

  const toggleMimeType = (mimeType: string) => {
    setExcludedMimeTypes((prev) =>
      prev.includes(mimeType) ? prev.filter(m => m !== mimeType) : [...prev, mimeType]
    );
  };

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  const browse = useCallback(
    async (folderId?: string, pageToken?: string, searchQuery?: string) => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams();
        if (folderId) params.set("parentId", folderId);
        if (pageToken) params.set("pageToken", pageToken);
        if (searchQuery) params.set("search", searchQuery);

        const res = await fetch(`/api/connections/${connectionId}/browse?${params}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();

        const mapped: DriveFile[] = (data.resources ?? []).map((r: any) => ({
          id: r.id,
          name: r.name,
          mimeType: r.metadata?.mimeType ?? '',
          webViewLink: r.metadata?.webViewLink,
          modifiedTime: r.metadata?.modifiedTime,
          owners: r.metadata?.owner ? [{ displayName: r.metadata.owner, emailAddress: '' }] : [],
        }));
        setFiles((prev) => (pageToken ? [...prev, ...mapped] : mapped));
        setNextPageToken(data.nextPageToken ?? null);
      } catch (e: any) {
        setError(e.message ?? "Failed to load Drive files");
      } finally {
        setLoading(false);
      }
    },
    [connectionId]
  );

  useEffect(() => {
    if (!open) return;
    setFiles([]);
    setNextPageToken(null);
    browse(currentFolderId, undefined, debouncedSearch || undefined);
  }, [open, currentFolderId, debouncedSearch, browse]);

  useEffect(() => {
    if (open) {
      setCurrentFolderId(undefined);
      setBreadcrumbs([{ id: undefined, name: "My Drive" }]);
      setSelectedItems(new Map());
      setSearch("");
      setDebouncedSearch("");
      setError(null);
      setDepartmentId(null);
      setExcludedMimeTypes([]);
    }
  }, [open]);

  const drillIntoFolder = (folder: DriveFile) => {
    setBreadcrumbs((prev) => [...prev, { id: folder.id, name: folder.name }]);
    setCurrentFolderId(folder.id);
    setFiles([]);
    setNextPageToken(null);
  };

  const navigateToBreadcrumb = (crumb: Breadcrumb, index: number) => {
    setBreadcrumbs((prev) => prev.slice(0, index + 1));
    setCurrentFolderId(crumb.id);
    setFiles([]);
    setNextPageToken(null);
  };

  const toggleItem = (file: DriveFile) => {
    const type = file.mimeType === FOLDER_MIME ? "folder" : "file";
    setSelectedItems((prev) => {
      const next = new Map(prev);
      if (next.has(file.id)) {
        next.delete(file.id);
      } else {
        next.set(file.id, { id: file.id, name: file.name, type });
      }
      return next;
    });
  };

  const handleSave = async () => {
    if (selectedItems.size === 0) return;
    setSaving(true);
    setError(null);
    try {
      const selectedResources = Array.from(selectedItems.values()).map(item => ({
        id: item.id,
        name: item.name,
        type: item.type,
        includeChildren: item.type === "folder",
      }));

      const res = await fetch(`/api/connections/${connectionId}/configure`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "google_drive",
          selectedResources,
          departmentId,
          excludedMimeTypes,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      onSuccess();
      onClose();
    } catch (e: any) {
      setError(e.message ?? "Failed to save configuration");
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;

  const isSearching = !!debouncedSearch;
  const folderCount = Array.from(selectedItems.values()).filter(i => i.type === "folder").length;
  const fileCount = Array.from(selectedItems.values()).filter(i => i.type === "file").length;

  const selectionLabel = selectedItems.size === 0
    ? "Nothing selected"
    : [folderCount > 0 && `${folderCount} folder${folderCount !== 1 ? "s" : ""}`, fileCount > 0 && `${fileCount} file${fileCount !== 1 ? "s" : ""}`]
        .filter(Boolean).join(", ") + " selected";

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-md p-4 animate-in fade-in duration-300">
      <div className="bg-card border border-white/10 shadow-2xl w-full max-w-2xl max-h-[85vh] flex flex-col overflow-hidden rounded-[2.5rem] animate-in zoom-in-95 duration-300">

        {/* Header */}
        <div className="px-8 pt-8 pb-6 border-b border-white/5 flex-shrink-0">
          <div className="flex items-start justify-between mb-4">
            <div>
              <h2 className="text-2xl font-black text-foreground tracking-tight">Select Files & Folders</h2>
              <p className="text-xs text-muted-foreground font-bold mt-1">
                Choose individual files or entire folders for Athene to index.
              </p>
            </div>
            <Button variant="ghost" size="icon" onClick={onClose} className="rounded-full hover:bg-white/5 -mt-1">
              <X className="w-5 h-5 text-muted-foreground" />
            </Button>
          </div>

          {/* Breadcrumb */}
          {!isSearching && breadcrumbs.length > 1 && (
            <div className="flex items-center gap-1 flex-wrap mb-4">
              {breadcrumbs.map((crumb, i) => (
                <span key={i} className="flex items-center gap-1">
                  {i > 0 && <ChevronRight className="w-3 h-3 text-muted-foreground/40" />}
                  <button
                    onClick={() => navigateToBreadcrumb(crumb, i)}
                    className={
                      i === breadcrumbs.length - 1
                        ? "text-xs font-black text-foreground"
                        : "text-xs font-bold text-muted-foreground hover:text-foreground transition-colors"
                    }
                  >
                    {crumb.name}
                  </button>
                </span>
              ))}
            </div>
          )}

          {/* Back button */}
          {!isSearching && breadcrumbs.length > 1 && (
            <button
              onClick={() => navigateToBreadcrumb(breadcrumbs[breadcrumbs.length - 2], breadcrumbs.length - 2)}
              className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-widest text-muted-foreground hover:text-foreground transition-colors mb-3"
            >
              <ChevronLeft className="w-3 h-3" /> Back
            </button>
          )}

          {/* Search */}
          <div className="relative">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground/40" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search your Drive..."
              className="w-full h-11 pl-11 pr-4 bg-white/5 border border-white/10 rounded-2xl text-sm font-bold placeholder:text-muted-foreground/30 text-foreground outline-none focus:border-primary/30 transition-colors"
            />
            {search && (
              <button
                onClick={() => setSearch("")}
                className="absolute right-4 top-1/2 -translate-y-1/2 text-muted-foreground/40 hover:text-foreground"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>

        {/* Configuration Section */}
        {!isSearching && (
          <div className="px-8 py-4 border-b border-white/5 flex flex-col sm:flex-row gap-6 bg-muted/5">
            <div className="flex-1 space-y-2">
              <label className="text-xs font-bold text-muted-foreground uppercase tracking-widest">Department Access</label>
              <Select value={departmentId || "none"} onValueChange={(val) => setDepartmentId(val === "none" ? null : val)}>
                <SelectTrigger className="w-full bg-white/5 border-white/10 rounded-xl">
                  <SelectValue placeholder="Map to department..." />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No specific department (Org-wide)</SelectItem>
                  {departments.map(dept => (
                    <SelectItem key={dept.id} value={dept.id}>{dept.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex-[2] space-y-2">
              <label className="text-xs font-bold text-muted-foreground uppercase tracking-widest">Exclude File Types</label>
              <div className="flex flex-wrap gap-2">
                {MIME_OPTIONS.map(opt => {
                  const isExcluded = excludedMimeTypes.includes(opt.value);
                  return (
                    <Badge
                      key={opt.value}
                      variant="outline"
                      className={`cursor-pointer transition-colors ${isExcluded ? 'bg-destructive/10 text-destructive border-destructive/20 hover:bg-destructive/20' : 'bg-white/5 border-white/10 text-muted-foreground hover:bg-white/10'}`}
                      onClick={() => toggleMimeType(opt.value)}
                    >
                      {opt.label}
                    </Badge>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* File List */}
        <div className="flex-1 min-h-0 overflow-y-auto">
          <div className="px-8 py-4 space-y-1">
            {loading && files.length === 0 && (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="w-6 h-6 animate-spin text-muted-foreground/40" />
              </div>
            )}

            {error && (
              <div className="flex items-center gap-3 p-4 rounded-2xl bg-destructive/10 border border-destructive/20">
                <AlertCircle className="w-4 h-4 text-destructive flex-shrink-0" />
                <span className="text-sm text-destructive font-bold">{error}</span>
              </div>
            )}

            {!loading && !error && files.length === 0 && (
              <div className="py-12 text-center">
                <Folder className="w-10 h-10 text-muted-foreground/20 mx-auto mb-3" />
                <p className="text-sm font-bold text-muted-foreground/40">
                  {isSearching ? "No results found" : "This folder is empty"}
                </p>
              </div>
            )}

            {files.map((file) => {
              const isFolder = file.mimeType === FOLDER_MIME;
              const isUnsyncable = UNSYNCABLE_MIMES.has(file.mimeType);
              const isSelected = selectedItems.has(file.id);

              if (isUnsyncable) return null;

              return (
                <div
                  key={file.id}
                  onClick={() => toggleItem(file)}
                  className={`flex items-center gap-3 p-3 rounded-2xl transition-all cursor-pointer
                    ${isSelected ? "bg-primary/10 border border-primary/20" : "border border-transparent hover:bg-white/5"}
                  `}
                >
                  {/* Checkbox */}
                  <div className="flex-shrink-0 text-muted-foreground/60">
                    {isSelected
                      ? <CheckSquare className="w-4 h-4 text-primary" />
                      : <Square className="w-4 h-4" />}
                  </div>

                  {/* Icon */}
                  {isFolder
                    ? <Folder className="w-4 h-4 text-secondary flex-shrink-0" />
                    : <FileText className="w-4 h-4 text-muted-foreground/60 flex-shrink-0" />}

                  {/* Name */}
                  <span className="flex-1 text-sm font-bold text-foreground truncate">
                    {file.name}
                  </span>

                  {/* Modified date */}
                  {file.modifiedTime && (
                    <span className="text-[10px] text-muted-foreground/40 font-bold flex-shrink-0">
                      {new Date(file.modifiedTime).toLocaleDateString()}
                    </span>
                  )}

                  {/* Drill-in button for folders */}
                  {isFolder && !isSearching && (
                    <button
                      onClick={(e) => { e.stopPropagation(); drillIntoFolder(file); }}
                      className="flex-shrink-0 p-1.5 rounded-xl hover:bg-white/10 text-muted-foreground/40 hover:text-foreground transition-all"
                      title="Browse folder"
                    >
                      <ChevronRight className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              );
            })}

            {/* Load more */}
            {nextPageToken && !loading && (
              <div className="pt-2 text-center">
                <button
                  onClick={() => browse(isSearching ? undefined : currentFolderId, nextPageToken, debouncedSearch || undefined)}
                  className="text-xs font-black uppercase tracking-widest text-muted-foreground/40 hover:text-foreground transition-colors px-4 py-2"
                >
                  Load more
                </button>
              </div>
            )}

            {loading && files.length > 0 && (
              <div className="flex justify-center py-4">
                <Loader2 className="w-4 h-4 animate-spin text-muted-foreground/40" />
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-8 py-6 border-t border-white/5 flex items-center justify-between flex-shrink-0">
          <span className="text-xs font-bold text-muted-foreground/60">{selectionLabel}</span>
          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              onClick={onClose}
              className="h-10 px-5 rounded-xl border-white/10 hover:bg-white/5 font-bold text-sm"
            >
              Cancel
            </Button>
            <Button
              onClick={handleSave}
              disabled={saving || selectedItems.size === 0}
              className="h-10 px-6 rounded-xl bg-primary hover:bg-primary/90 text-white font-black text-sm gap-2 shadow-lg shadow-primary/20"
            >
              {saving && <Loader2 className="w-3 h-3 animate-spin" />}
              Start Syncing
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
