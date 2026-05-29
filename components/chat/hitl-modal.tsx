"use client";

import { useState, useEffect } from "react";
import {
  ShieldAlert,
  CheckCircle2,
  XCircle,
  Edit3,
  Loader2,
  AlertCircle,
  Mail,
  ArrowRight,
  X,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
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

interface EmailForm {
  to: string;
  cc: string;
  subject: string;
  body: string;
}

function isEmailTool(tool: string) { return tool === 'email-send'; }

function isRecipientMissing(pendingAction: { tool: string; payload: any }) {
  return (
    isEmailTool(pendingAction.tool) &&
    (!pendingAction.payload?.to || pendingAction.payload.to.length === 0)
  );
}

function isValidEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

const inputStyle = {
  background: "rgba(0,0,0,0.4)",
  border: "1px solid rgba(200,130,60,0.25)",
  color: "#F5EDD8",
} as React.CSSProperties;

const labelStyle = {
  color: "rgba(245,237,216,0.45)",
} as React.CSSProperties;

export function HitlModal({ isOpen, onClose, threadId, pendingAction, onDecision }: HitlModalProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isEditing, setIsEditing] = useState(false);

  // Step 1 — recipient collection
  const [toInput, setToInput] = useState("");
  const [ccInput, setCcInput] = useState("");
  const [recipientConfirmed, setRecipientConfirmed] = useState(false);

  // Step 2 — inline email editor (for email-send) or raw JSON (for other tools)
  const [emailForm, setEmailForm] = useState<EmailForm | null>(null);
  const [jsonEdits, setJsonEdits] = useState("");

  // Reset all local state whenever a new pending action arrives
  useEffect(() => {
    setIsEditing(false);
    setEmailForm(null);
    setJsonEdits("");
    setToInput("");
    setCcInput("");
    setRecipientConfirmed(false);
  }, [pendingAction?.tool, pendingAction?.payload]);

  if (!pendingAction) return null;

  const needsRecipient = isRecipientMissing(pendingAction) && !recipientConfirmed;
  const isEmail = isEmailTool(pendingAction.tool);

  const effectivePayload = (() => {
    const base = { ...pendingAction.payload };
    if (isEmail && recipientConfirmed && toInput) base.to = [toInput.trim()];
    if (isEmail && recipientConfirmed && ccInput.trim()) {
      base.cc = ccInput.split(",").map((s) => s.trim()).filter(Boolean);
    }
    return base;
  })();

  const startEditing = () => {
    if (isEmail) {
      setEmailForm({
        to: (effectivePayload.to ?? []).join(", "),
        cc: (effectivePayload.cc ?? []).join(", "),
        subject: effectivePayload.subject ?? "",
        body: effectivePayload.body ?? "",
      });
    } else {
      setJsonEdits(JSON.stringify(effectivePayload, null, 2));
    }
    setIsEditing(true);
  };

  const handleAction = async (action: 'approve' | 'reject' | 'edit') => {
    setIsSubmitting(true);
    try {
      if (action === 'reject') {
        await onDecision('reject');
        onClose();
        return;
      }

      let finalPayload: Record<string, unknown>;

      if (action === 'edit' && isEmail && emailForm) {
        finalPayload = {
          ...effectivePayload,
          to: emailForm.to.split(",").map((s) => s.trim()).filter(Boolean),
          cc: emailForm.cc.split(",").map((s) => s.trim()).filter(Boolean),
          subject: emailForm.subject,
          body: emailForm.body,
        };
      } else if (action === 'edit' && !isEmail) {
        try {
          finalPayload = { ...effectivePayload, ...JSON.parse(jsonEdits) };
        } catch {
          toast.error("Invalid JSON in edits");
          setIsSubmitting(false);
          return;
        }
      } else {
        finalPayload = effectivePayload;
      }

      await onDecision(action, action === 'approve' ? undefined : finalPayload);
      onClose();
    } catch (error: any) {
      toast.error(error.message || "Failed to process decision");
    } finally {
      setIsSubmitting(false);
    }
  };

  const surfaceCard = {
    background: "#1A1008",
    border: "1px solid rgba(200,130,60,0.12)",
  } as React.CSSProperties;

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !isSubmitting && !open && onClose()}>
      <DialogContent
        data-testid="approval-card"
        className="sm:max-w-[600px] max-h-[90vh] overflow-y-auto border font-['Space_Grotesk']"
        style={{ background: "#0D0805", borderColor: "rgba(200,130,60,0.18)", color: "#F5EDD8" }}
      >
        <DialogHeader>
          <div className="flex items-center gap-3 mb-2">
            <div className="h-10 w-10 rounded-xl flex items-center justify-center" style={{ background: "rgba(160,74,27,0.15)" }}>
              <ShieldAlert className="w-6 h-6" style={{ color: "#D97A2E" }} />
            </div>
            <div>
              <DialogTitle className="text-xl font-black" style={{ color: "#F5EDD8" }}>
                Human-in-the-Loop Approval
              </DialogTitle>
              <DialogDescription className="font-bold uppercase tracking-widest text-[10px]" style={{ color: "rgba(245,237,216,0.45)" }}>
                Required for restricted actions
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {/* ── STEP 1: collect missing recipient ── */}
        {needsRecipient ? (
          <div className="space-y-5 py-4">
            <div className="p-4 rounded-2xl space-y-4" style={surfaceCard}>
              <div className="flex items-center gap-2">
                <Mail className="w-4 h-4" style={{ color: "#D97A2E" }} />
                <span className="text-[11px] font-bold uppercase tracking-widest" style={{ color: "rgba(245,237,216,0.45)" }}>
                  Recipient Required
                </span>
              </div>

              <div className="p-3 rounded-xl text-[12px] leading-relaxed" style={{ background: "rgba(160,74,27,0.07)", border: "1px solid rgba(200,130,60,0.12)", color: "rgba(245,237,216,0.6)" }}>
                The agent drafted this email but couldn't resolve a recipient from context.
                Enter the <span style={{ color: "#E6B928" }}>To</span> address to continue.
              </div>

              {/* Draft preview */}
              <div className="space-y-2">
                <span className="text-[11px] font-bold uppercase tracking-widest" style={labelStyle}>Draft Preview</span>
                <div className="rounded-xl p-3 space-y-2 text-[13px]" style={{ background: "rgba(0,0,0,0.4)", border: "1px solid rgba(200,130,60,0.1)" }}>
                  <p style={{ color: "rgba(245,237,216,0.5)" }}>
                    <span style={{ color: "#E6B928" }}>Subject:</span>{" "}
                    {pendingAction.payload?.subject || <em>—</em>}
                  </p>
                  <p className="whitespace-pre-wrap text-[12px] leading-relaxed" style={{ color: "rgba(245,237,216,0.7)" }}>
                    {pendingAction.payload?.body || ""}
                  </p>
                </div>
              </div>

              {/* To */}
              <div className="space-y-1.5">
                <label className="text-[11px] font-bold uppercase tracking-widest" style={{ color: "#D97A2E" }}>To *</label>
                <Input
                  type="email"
                  value={toInput}
                  onChange={(e) => setToInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && isValidEmail(toInput)) setRecipientConfirmed(true); }}
                  placeholder="recipient@company.com"
                  className="rounded-xl h-11 text-[13px]"
                  style={inputStyle}
                  autoFocus
                />
              </div>

              {/* CC */}
              <div className="space-y-1.5">
                <label className="text-[11px] font-bold uppercase tracking-widest" style={labelStyle}>CC <span style={{ color: "rgba(245,237,216,0.3)" }}>(optional, comma-separated)</span></label>
                <Input
                  type="text"
                  value={ccInput}
                  onChange={(e) => setCcInput(e.target.value)}
                  placeholder="colleague@company.com, manager@company.com"
                  className="rounded-xl h-11 text-[13px]"
                  style={inputStyle}
                />
              </div>
            </div>

            <div className="flex gap-3">
              <Button variant="outline" onClick={() => handleAction('reject')} disabled={isSubmitting}
                className="flex-1 rounded-xl h-12 font-bold uppercase tracking-widest text-[11px]"
                style={{ background: "rgba(180,30,30,0.08)", border: "1px solid rgba(180,30,30,0.25)", color: "#f87171" }}>
                <XCircle className="w-4 h-4 mr-2" /> Reject
              </Button>
              <Button onClick={() => setRecipientConfirmed(true)} disabled={!isValidEmail(toInput)}
                className="flex-1 rounded-xl h-12 font-bold uppercase tracking-widest text-[11px] transition-all"
                style={{
                  background: isValidEmail(toInput) ? "linear-gradient(135deg, #A04A1B, #D97A2E)" : "rgba(160,74,27,0.2)",
                  border: "none",
                  color: isValidEmail(toInput) ? "#F5EDD8" : "rgba(245,237,216,0.3)",
                  boxShadow: isValidEmail(toInput) ? "0 4px 20px rgba(160,74,27,0.35)" : "none",
                }}>
                <ArrowRight className="w-4 h-4 mr-2" /> Continue
              </Button>
            </div>
          </div>
        ) : (
          /* ── STEP 2: review + approve/reject ── */
          <div className="space-y-4 py-4">
            <div className="p-4 rounded-2xl space-y-3" style={surfaceCard}>
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-bold uppercase tracking-widest" style={labelStyle}>Target Action</span>
                <Badge variant="outline" className="uppercase tracking-widest text-[10px]"
                  style={{ background: "rgba(217,122,46,0.12)", color: "#D97A2E", borderColor: "rgba(217,122,46,0.25)" }}>
                  {pendingAction.tool}
                </Badge>
              </div>

              {/* Email inline editor */}
              {isEditing && isEmail && emailForm ? (
                <div className="space-y-3 animate-in fade-in slide-in-from-top-2">
                  <span className="text-[11px] font-bold uppercase tracking-widest flex items-center gap-2" style={{ color: "#D97A2E" }}>
                    <Edit3 className="w-3.5 h-3.5" /> Edit Email
                  </span>
                  {(["to", "cc", "subject"] as const).map((field) => (
                    <div key={field} className="space-y-1">
                      <label className="text-[11px] font-bold uppercase tracking-widest" style={labelStyle}>
                        {field === "cc" ? "CC (comma-separated)" : field}
                      </label>
                      <Input
                        value={emailForm[field]}
                        onChange={(e) => setEmailForm({ ...emailForm, [field]: e.target.value })}
                        placeholder={field === "cc" ? "optional" : undefined}
                        className="rounded-xl h-10 text-[13px]"
                        style={inputStyle}
                      />
                    </div>
                  ))}
                  <div className="space-y-1">
                    <label className="text-[11px] font-bold uppercase tracking-widest" style={labelStyle}>Body</label>
                    <Textarea
                      value={emailForm.body}
                      onChange={(e) => setEmailForm({ ...emailForm, body: e.target.value })}
                      className="font-sans text-[13px] min-h-[140px] rounded-xl"
                      style={inputStyle}
                    />
                  </div>
                </div>
              ) : isEditing && !isEmail ? (
                /* Raw JSON for non-email tools */
                <div className="space-y-3 animate-in fade-in slide-in-from-top-2">
                  <span className="text-[11px] font-bold uppercase tracking-widest flex items-center gap-2" style={{ color: "#D97A2E" }}>
                    <Edit3 className="w-3.5 h-3.5" /> Apply Modifications (JSON)
                  </span>
                  <Textarea
                    value={jsonEdits}
                    onChange={(e) => setJsonEdits(e.target.value)}
                    placeholder='{ "key": "new value" }'
                    className="font-mono text-[13px] min-h-[120px] rounded-xl"
                    style={{ ...inputStyle, color: "#E6B928" }}
                  />
                </div>
              ) : (
                /* Read-only payload preview */
                <div className="space-y-2">
                  <span className="text-[11px] font-bold uppercase tracking-widest" style={labelStyle}>Proposed Payload</span>
                  {isEmail ? (
                    <div className="rounded-xl p-3 space-y-2 text-[13px]" style={{ background: "rgba(0,0,0,0.4)", border: "1px solid rgba(200,130,60,0.1)" }}>
                      {effectivePayload.to?.length > 0 && (
                        <p style={{ color: "rgba(245,237,216,0.6)" }}>
                          <span style={{ color: "#E6B928" }}>To:</span>{" "}
                          <span style={{ color: "#F5EDD8" }}>{(effectivePayload.to as string[]).join(", ")}</span>
                        </p>
                      )}
                      {effectivePayload.cc?.length > 0 && (
                        <p style={{ color: "rgba(245,237,216,0.6)" }}>
                          <span style={{ color: "#E6B928" }}>CC:</span>{" "}
                          <span style={{ color: "#F5EDD8" }}>{(effectivePayload.cc as string[]).join(", ")}</span>
                        </p>
                      )}
                      <p style={{ color: "rgba(245,237,216,0.6)" }}>
                        <span style={{ color: "#E6B928" }}>Subject:</span>{" "}
                        <span style={{ color: "#F5EDD8" }}>{effectivePayload.subject}</span>
                      </p>
                      <hr style={{ borderColor: "rgba(200,130,60,0.1)" }} />
                      <p className="whitespace-pre-wrap text-[12px] leading-relaxed" style={{ color: "rgba(245,237,216,0.75)" }}>
                        {effectivePayload.body}
                      </p>
                    </div>
                  ) : (
                    <pre className="p-4 rounded-xl text-[13px] font-mono overflow-x-auto"
                      style={{ background: "rgba(0,0,0,0.4)", border: "1px solid rgba(200,130,60,0.1)", color: "#E6B928" }}>
                      {JSON.stringify(effectivePayload, null, 2)}
                    </pre>
                  )}
                </div>
              )}
            </div>

            <div className="flex items-start gap-3 p-4 rounded-xl"
              style={{ background: "rgba(160,74,27,0.07)", border: "1px solid rgba(200,130,60,0.12)" }}>
              <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" style={{ color: "#D97A2E" }} />
              <p className="text-[12px] leading-relaxed font-medium" style={{ color: "rgba(245,237,216,0.6)" }}>
                Approving will execute this action immediately. Use Modify to adjust fields before sending.
              </p>
            </div>

            <div className="flex gap-3 pt-1">
              <Button variant="outline" onClick={() => handleAction('reject')} disabled={isSubmitting}
                className="flex-1 rounded-xl h-12 font-bold uppercase tracking-widest text-[11px] transition-colors"
                style={{ background: "rgba(180,30,30,0.08)", border: "1px solid rgba(180,30,30,0.25)", color: "#f87171" }}>
                {isSubmitting ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <XCircle className="w-4 h-4 mr-2" />}
                Reject
              </Button>

              {!isEditing ? (
                <Button variant="outline" onClick={startEditing} disabled={isSubmitting}
                  className="flex-1 rounded-xl h-12 font-bold uppercase tracking-widest text-[11px] transition-colors"
                  style={{ background: "rgba(200,130,60,0.07)", border: "1px solid rgba(200,130,60,0.2)", color: "#D97A2E" }}>
                  <Edit3 className="w-4 h-4 mr-2" /> Modify
                </Button>
              ) : (
                <Button variant="outline" onClick={() => setIsEditing(false)} disabled={isSubmitting}
                  className="flex-1 rounded-xl h-12 font-bold uppercase tracking-widest text-[11px] transition-colors"
                  style={{ background: "rgba(200,130,60,0.07)", border: "1px solid rgba(200,130,60,0.2)", color: "#D97A2E" }}>
                  <X className="w-4 h-4 mr-2" /> Cancel
                </Button>
              )}

              <Button onClick={() => handleAction(isEditing ? 'edit' : 'approve')} disabled={isSubmitting}
                className="flex-1 rounded-xl h-12 font-bold uppercase tracking-widest text-[11px] transition-all"
                style={{ background: "linear-gradient(135deg, #A04A1B, #D97A2E)", border: "none", color: "#F5EDD8", boxShadow: "0 4px 20px rgba(160,74,27,0.35)" }}>
                {isSubmitting ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <CheckCircle2 className="w-4 h-4 mr-2" />}
                {isEditing ? 'Confirm & Execute' : 'Approve & Execute'}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
