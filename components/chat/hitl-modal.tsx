"use client";

import { useState } from "react";
import { 
  ShieldAlert, 
  CheckCircle2, 
  XCircle, 
  Edit3,
  Loader2,
  AlertCircle
} from "lucide-react";
import { 
  Dialog, 
  DialogContent, 
  DialogHeader, 
  DialogTitle, 
  DialogDescription,
  DialogFooter
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";

interface HitlModalProps {
  isOpen: boolean;
  onClose: () => void;
  threadId: string;
  pendingAction: {
    tool: string;
    payload: any;
  } | null;
  onDecision: (decision: 'approve' | 'reject' | 'edit', edits?: any) => Promise<void>;
}

export function HitlModal({ isOpen, onClose, threadId, pendingAction, onDecision }: HitlModalProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editedPayload, setEditedPayload] = useState("");

  if (!pendingAction) return null;

  const handleAction = async (action: 'approve' | 'reject' | 'edit') => {
    setIsSubmitting(true);
    try {
      let edits = undefined;
      if (action === 'edit') {
        try {
          edits = JSON.parse(editedPayload);
        } catch (e) {
          toast.error("Invalid JSON in edits");
          setIsSubmitting(false);
          return;
        }
      }
      await onDecision(action, edits);
      onClose();
    } catch (error: any) {
      toast.error(error.message || "Failed to process decision");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !isSubmitting && !open && onClose()}>
      <DialogContent data-testid="approval-card" className="sm:max-w-[600px] bg-slate-950 border-white/10 text-white font-['Space_Grotesk']">
        <DialogHeader>
          <div className="flex items-center gap-3 mb-2">
            <div className="h-10 w-10 rounded-xl bg-amber-500/10 flex items-center justify-center">
              <ShieldAlert className="w-6 h-6 text-amber-500" />
            </div>
            <div>
              <DialogTitle className="text-xl font-black">Human-in-the-Loop Approval</DialogTitle>
              <DialogDescription className="text-slate-400 font-bold uppercase tracking-widest text-[10px]">
                Required for restricted actions
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-6 py-4">
          <div className="p-4 rounded-2xl bg-white/5 border border-white/5 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-bold text-slate-500 uppercase tracking-widest">Target Action</span>
              <Badge variant="outline" className="bg-secondary/10 text-secondary border-secondary/20 uppercase tracking-widest text-[10px]">
                {pendingAction.tool}
              </Badge>
            </div>
            
            <div className="space-y-2">
              <span className="text-[11px] font-bold text-slate-500 uppercase tracking-widest">Proposed Payload</span>
              <pre className="bg-black/50 p-4 rounded-xl text-[13px] font-mono text-emerald-400 overflow-x-auto border border-white/5">
                {JSON.stringify(pendingAction.payload, null, 2)}
              </pre>
            </div>
          </div>

          {isEditing && (
            <div className="space-y-3 animate-in fade-in slide-in-from-top-2">
              <span className="text-[11px] font-bold text-secondary uppercase tracking-widest flex items-center gap-2">
                <Edit3 className="w-3.5 h-3.5" />
                Apply Modifications (JSON)
              </span>
              <Textarea 
                value={editedPayload}
                onChange={(e) => setEditedPayload(e.target.value)}
                placeholder='{ "key": "new value" }'
                className="bg-black/50 border-white/10 text-emerald-400 font-mono text-[13px] min-h-[120px] focus:border-secondary/50 rounded-xl"
              />
            </div>
          )}

          <div className="flex items-start gap-3 p-4 rounded-xl bg-blue-500/5 border border-blue-500/10">
            <AlertCircle className="w-5 h-5 text-blue-400 shrink-0 mt-0.5" />
            <p className="text-[12px] text-slate-400 leading-relaxed font-medium">
              Reviewing this action ensures system integrity. Approving will execute the tool call with the current parameters. Editing allows you to override specific fields.
            </p>
          </div>
        </div>

        <DialogFooter className="gap-3 sm:gap-0">
          <div className="flex flex-1 gap-3">
            <Button
              variant="outline"
              onClick={() => handleAction('reject')}
              disabled={isSubmitting}
              className="flex-1 bg-red-500/5 hover:bg-red-500/10 text-red-400 border-red-500/20 rounded-xl h-12 font-bold uppercase tracking-widest text-[11px]"
            >
              {isSubmitting ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <XCircle className="w-4 h-4 mr-2" />}
              Reject
            </Button>
            
            {!isEditing ? (
              <Button
                variant="outline"
                onClick={() => {
                  setIsEditing(true);
                  setEditedPayload(JSON.stringify(pendingAction.payload, null, 2));
                }}
                disabled={isSubmitting}
                className="flex-1 bg-white/5 hover:bg-white/10 text-white border-white/10 rounded-xl h-12 font-bold uppercase tracking-widest text-[11px]"
              >
                <Edit3 className="w-4 h-4 mr-2" />
                Modify
              </Button>
            ) : (
              <Button
                variant="outline"
                onClick={() => setIsEditing(false)}
                disabled={isSubmitting}
                className="flex-1 bg-white/5 hover:bg-white/10 text-white border-white/10 rounded-xl h-12 font-bold uppercase tracking-widest text-[11px]"
              >
                Cancel Edit
              </Button>
            )}
          </div>
          
          <Button
            onClick={() => handleAction(isEditing ? 'edit' : 'approve')}
            disabled={isSubmitting}
            className="flex-1 bg-gradient-to-r from-emerald-500 to-teal-600 text-white border-none rounded-xl h-12 font-bold uppercase tracking-widest text-[11px] hover:shadow-lg hover:shadow-emerald-900/20"
          >
            {isSubmitting ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <CheckCircle2 className="w-4 h-4 mr-2" />}
            {isEditing ? 'Confirm & Execute' : 'Approve & Execute'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
