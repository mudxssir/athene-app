"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { useRouter, usePathname } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Plus, MessageSquare, Trash2, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

interface Thread {
  id: string;
  created_at: string;
  updated_at: string;
}

export function ThreadSidebar() {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [loading, setLoading] = useState(true);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const router = useRouter();
  const pathname = usePathname();
  const activeThreadId = pathname?.split("/chat/")[1]?.split("/")[0];

  const fetchThreads = useCallback(async () => {
    try {
      const res = await fetch("/api/threads");
      if (res.ok) {
        const data = await res.json();
        setThreads(data);
      }
    } catch (err) {
      console.error("Failed to fetch threads:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchThreads();
  }, [fetchThreads]);

  async function createThread() {
    try {
      setOperationError(null);
      const res = await fetch("/api/threads", { method: "POST" });
      if (res.ok) {
        const thread = await res.json();
        router.push(`/chat/${thread.id}`);
        fetchThreads();
      }
    } catch (err) {
      console.error("Failed to create thread:", err);
      setOperationError("Failed to create thread. Please try again.");
    }
  }

  async function confirmDelete(id: string) {
    try {
      const res = await fetch(`/api/threads/${id}`, { method: "DELETE" });
      if (res.ok) {
        if (activeThreadId === id) {
          router.push("/chat");
        }
        fetchThreads();
      }
    } catch (err) {
      console.error("Failed to delete thread:", err);
      setOperationError("Failed to delete thread. Please try again.");
    }
  }

  function formatDate(iso: string) {
    return new Date(iso).toLocaleDateString([], {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  const filtered = useMemo(() => {
    if (!search.trim()) return threads;
    const q = search.toLowerCase();
    return threads.filter(t =>
      formatDate(t.updated_at).toLowerCase().includes(q) ||
      t.id.toLowerCase().includes(q)
    );
  }, [threads, search]);

  return (
    <aside className="w-64 border-r border-white/5 flex flex-col h-full bg-card/50">
      <div className="p-4 border-b border-white/5 space-y-2">
        <Button
          onClick={createThread}
          className="w-full bg-primary hover:bg-[var(--primary-hover)] text-white"
        >
          <Plus className="w-4 h-4 mr-2" />
          New chat
        </Button>
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
          <Input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search chats…"
            className="pl-8 h-8 text-xs bg-muted/40 border-white/5 rounded-lg"
          />
        </div>
        {operationError && (
          <div className="mx-4 mt-2 p-2 bg-red-500/10 border border-red-500/20 rounded-xl text-red-400 text-xs font-medium flex justify-between items-center">
            <span>{operationError}</span>
            <button onClick={() => setOperationError(null)} className="ml-2 hover:text-white">
              ×
            </button>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {loading ? (
          <div className="p-4 text-center text-muted-foreground text-sm">
            Loading...
          </div>
        ) : filtered.length === 0 ? (
          <div className="p-4 text-center text-muted-foreground text-sm">
            {search ? "No matching chats" : "No chats yet"}
          </div>
        ) : (
          filtered.map((thread) => (
            <div
              key={thread.id}
              onClick={() => router.push(`/chat/${thread.id}`)}
              className={cn(
                "group flex items-center justify-between p-3 rounded-xl cursor-pointer transition-colors",
                activeThreadId === thread.id
                  ? "bg-primary/10 border border-primary/30"
                  : "hover:bg-muted/50 border border-transparent"
              )}
            >
              <div className="flex items-center gap-3 min-w-0">
                <MessageSquare className="w-4 h-4 shrink-0 text-muted-foreground" />
                <span className="text-sm truncate">
                  {formatDate(thread.updated_at)}
                </span>
              </div>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                    }}
                    className="opacity-0 group-hover:opacity-100 transition-opacity p-1 hover:bg-red-500/20 rounded"
                  >
                    <Trash2 className="w-3.5 h-3.5 text-red-400" />
                  </button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Delete thread?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This action cannot be undone. This will permanently delete the
                      thread from {formatDate(thread.updated_at)}.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>
                      Cancel
                    </AlertDialogCancel>
                    <AlertDialogAction
                      onClick={() => confirmDelete(thread.id)}
                      className="bg-red-500 hover:bg-red-600"
                    >
                      Delete
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          ))
        )}
      </div>
    </aside>
  );
}
