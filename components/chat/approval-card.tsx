"use client";

import { useState, useCallback } from "react";
import { Check, X, Edit2, Mail, Calendar } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { PendingWriteAction } from "@/lib/langgraph/state";

interface ApprovalCardProps {
  threadId: string;
  action: PendingWriteAction;
  onComplete?: (content: string, citedSources: any[]) => void;
  onError?: (error: string) => void;
}

export function ApprovalCard({ threadId, action, onComplete, onError }: ApprovalCardProps) {
  const [loadingAction, setLoadingAction] = useState<'approve' | 'reject' | 'edit' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showEdit, setShowEdit] = useState(false);
  const [editPayload, setEditPayload] = useState(
    JSON.stringify(action.payload, null, 2)
  );

  async function readApprovalStream(res: Response): Promise<{ finalContent: string; finalSources: any[] }> {
    let finalContent = "";
    let finalSources: any[] = [];
    if (res.body) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const data = JSON.parse(line.slice(6));
            if (data.content) finalContent = data.content;
            if (data.cited_sources) finalSources = data.cited_sources;
            if (data.run_status === "completed" || data.final_answer) break;
          } catch {
            // Ignore parse errors
          }
        }
      }
    }
    return { finalContent, finalSources };
  }

  const toolIcon = action.tool.toLowerCase().includes("email") ? (
    <Mail className="w-5 h-5 text-primary" />
  ) : (
    <Calendar className="w-5 h-5 text-secondary" />
  );

  async function handleApprove() {
    setLoadingAction('approve');
    setError(null);
    try {
      const res = await fetch("/api/agent/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          threadId,
          action: "approve",
        }),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => "Unknown error");
        throw new Error(`Approve failed: ${errText}`);
      }

      const { finalContent, finalSources } = await readApprovalStream(res);
      onComplete?.(finalContent, finalSources);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to approve";
      setError(msg);
      onError?.(msg);
    } finally {
      setLoadingAction(null);
    }
  }

  async function handleReject() {
    setLoadingAction('reject');
    setError(null);
    try {
      const res = await fetch("/api/agent/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          threadId,
          action: "reject",
        }),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => "Unknown error");
        throw new Error(`Reject failed: ${errText}`);
      }

      const { finalContent, finalSources } = await readApprovalStream(res);
      onComplete?.(finalContent, finalSources);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to reject";
      setError(msg);
      onError?.(msg);
    } finally {
      setLoadingAction(null);
    }
  }

  function handleEdit() {
    setShowEdit(!showEdit);
  }

  async function handleEditSave() {
    try {
      const parsed = JSON.parse(editPayload);
      setLoadingAction('edit');
      setError(null);
      const res = await fetch("/api/agent/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          threadId,
          action: "approve",
          editedPayload: parsed,
        }),
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => "Unknown error");
        throw new Error(`Edit approve failed: ${errText}`);
      }
      const { finalContent, finalSources } = await readApprovalStream(res);
      onComplete?.(finalContent, finalSources);
      setShowEdit(false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Invalid JSON payload";
      setError(msg);
      onError?.(msg);
    } finally {
      setLoadingAction(null);
    }
  }

  return (
    <Card className="mx-6 mb-4 p-6 border-yellow-500/20 bg-yellow-500/5 rounded-[2rem]">
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          {toolIcon}
          <div>
            <h4 className="text-sm font-bold text-foreground">
              Action Requires Approval
            </h4>
            <p className="text-xs text-muted-foreground uppercase tracking-wider">
              {action.tool.replace(/-/g, " ")}
            </p>
          </div>
        </div>

        {showEdit ? (
          <div className="space-y-3">
            <div className="bg-background/50 rounded-xl p-4 border border-white/5">
              <textarea
                value={editPayload}
                onChange={(e) => setEditPayload(e.target.value)}
                className="w-full h-32 bg-transparent text-xs text-foreground font-mono resize-none focus:outline-none"
                spellCheck={false}
              />
            </div>
            <div className="flex gap-3">
              <Button
                onClick={handleEditSave}
                disabled={loadingAction !== null}
                className="bg-emerald-500 hover:bg-emerald-600 text-white"
              >
                <Check className="w-4 h-4 mr-2" />
                Save & Approve
              </Button>
              <Button
                onClick={() => setShowEdit(false)}
                variant="outline"
                disabled={loadingAction !== null}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <>
            <div className="bg-background/50 rounded-xl p-4 border border-white/5">
              <pre className="text-xs text-foreground overflow-x-auto whitespace-pre-wrap">
                {JSON.stringify(action.payload, null, 2)}
              </pre>
            </div>

            {error && (
              <p className="text-xs text-red-400">{error}</p>
            )}

            <div className="flex items-center gap-3">
              <Button
                onClick={handleApprove}
                disabled={loadingAction !== null}
                className="bg-emerald-500 hover:bg-emerald-600 text-white"
              >
                {loadingAction === 'approve' ? (
                  <div className="w-4 h-4 mr-2 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                ) : (
                  <Check className="w-4 h-4 mr-2" />
                )}
                Approve
              </Button>

              <Button
                onClick={handleEdit}
                disabled={loadingAction !== null}
                variant="outline"
                className="border-yellow-500/30 text-yellow-400 hover:bg-yellow-500/10"
              >
                <Edit2 className="w-4 h-4 mr-2" />
                Edit
              </Button>

              <Button
                onClick={handleReject}
                disabled={loadingAction !== null}
                variant="outline"
                className="border-red-500/30 text-red-400 hover:bg-red-500/10"
              >
                <X className="w-4 h-4 mr-2" />
                Reject
              </Button>
            </div>
          </>
        )}

        <p className="text-[10px] text-muted-foreground uppercase tracking-wider">
          Requested at: {action.requested_at && !isNaN(new Date(action.requested_at).getTime()) ? new Date(action.requested_at).toLocaleString() : 'Unknown time'}
        </p>
      </div>
    </Card>
  );
}
