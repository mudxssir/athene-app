"use client";

import { TCard } from "@/components/ui/kit";
import { useState, useRef, useEffect } from "react";
import {
  Plus,
  Play,
  Save,
  Database,
  Cpu,
  Search,
  GitBranch,
  Terminal,
  ChevronRight,
  Trash2,
  Info,
  BrainCircuit,
  RefreshCw,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

type NodeData = {
  id: number;
  type: string;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  pos: { x: number; y: number };
  color: string;
};

const INITIAL_NODES: NodeData[] = [
  { id: 1, type: "Trigger", icon: Play, label: "On File Upload", pos: { x: 100, y: 150 }, color: "bg-emerald-500" },
  { id: 2, type: "Action", icon: Search, label: "Semantic Search", pos: { x: 350, y: 150 }, color: "bg-secondary" },
  { id: 3, type: "Branch", icon: GitBranch, label: "Classification", pos: { x: 600, y: 150 }, color: "bg-amber-500" },
  { id: 4, type: "Terminal", icon: Terminal, label: "Synth Agent", pos: { x: 850, y: 150 }, color: "bg-secondary" },
];

const LOGIC_BLOCKS = [
  { label: "Trigger Node", type: "Trigger", icon: Play, color: "bg-emerald-500", iconColor: "text-accent", bg: "bg-accent/10" },
  { label: "AI Reasoning", type: "Action", icon: Cpu, color: "bg-secondary", iconColor: "text-primary", bg: "bg-primary/10" },
  { label: "Knowledge Retrieval", type: "Action", icon: Database, color: "bg-secondary", iconColor: "text-primary", bg: "bg-primary/10" },
  { label: "Output Stream", type: "Terminal", icon: ChevronRight, color: "bg-secondary", iconColor: "text-secondary", bg: "bg-secondary/10" },
] as const;

// Node dimensions for port and SVG line calculations
const NODE_W = 256;
const NODE_H = 160;

export default function BuilderPage() {
  const [nodes, setNodes] = useState<NodeData[]>(INITIAL_NODES);
  const [selectedNodeId, setSelectedNodeId] = useState<number | null>(null);
  const [dragging, setDragging] = useState<{ nodeId: number; offsetX: number; offsetY: number } | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isDeploying, setIsDeploying] = useState(false);
  const [savedAutomationId, setSavedAutomationId] = useState<string | null>(null);
  const [executionGuards, setExecutionGuards] = useState([
    { label: "Strict Typing", active: true },
    { label: "Entity Masking", active: true },
    { label: "Retrieval Audit", active: false },
  ]);
  const canvasRef = useRef<HTMLDivElement>(null);

  // Clear drag on global mouseup so releasing outside canvas still stops drag
  useEffect(() => {
    const onMouseUp = () => setDragging(null);
    window.addEventListener("mouseup", onMouseUp);
    return () => window.removeEventListener("mouseup", onMouseUp);
  }, []);

  // Fix #1: POST to /api/admin/automations (not /api/workflows), PATCH on subsequent saves
  const handleStoreConfig = async () => {
    setIsSaving(true);
    try {
      const method = savedAutomationId ? "PATCH" : "POST";
      const url = savedAutomationId
        ? `/api/admin/automations/${savedAutomationId}`
        : "/api/admin/automations";

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Neural Pipeline " + new Date().toLocaleDateString(),
          config: { nodes: nodes.map(n => ({ ...n, icon: n.type })), executionGuards },
          status: "draft",
        }),
      });

      if (!res.ok) throw new Error((await res.json()).error || "Save failed");
      const data = await res.json();
      if (!savedAutomationId) setSavedAutomationId(data.id);

      toast.success("Configuration Stored", {
        description: "Pipeline configuration saved to cloud vault.",
      });
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setIsSaving(false);
    }
  };

  // Fix #2: PATCH automation status to 'active' instead of fake setTimeout promise
  const handleDeployFleet = async () => {
    if (!savedAutomationId) {
      toast.error("Save configuration first before deploying");
      return;
    }
    setIsDeploying(true);
    try {
      const res = await fetch(`/api/admin/automations/${savedAutomationId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "active" }),
      });
      if (!res.ok) throw new Error((await res.json()).error || "Deploy failed");
      toast.success("Fleet deployed successfully", {
        description: "Pipeline is now active.",
      });
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setIsDeploying(false);
    }
  };

  // Fix #3: add a new node to canvas instead of showing a toast
  const addNode = (block: typeof LOGIC_BLOCKS[number]) => {
    const newNode: NodeData = {
      id: Date.now(),
      type: block.type,
      icon: block.icon,
      label: block.label,
      pos: { x: 80 + Math.floor(Math.random() * 300), y: 60 + Math.floor(Math.random() * 200) },
      color: block.color,
    };
    setNodes(prev => [...prev, newNode]);
    setSelectedNodeId(newNode.id);
    toast.success(`${block.label} added to canvas`);
  };

  // Fix #4: remove selectedNode, not the last node
  const handleDeconstruct = () => {
    if (!selectedNodeId) {
      toast.error("Select a node first");
      return;
    }
    setNodes(prev => prev.filter(n => n.id !== selectedNodeId));
    setSelectedNodeId(null);
    toast.error("Node removed from pipeline");
  };

  // Fix #6: drag-and-drop via mouse events
  const handleNodeMouseDown = (e: React.MouseEvent, node: NodeData) => {
    e.stopPropagation();
    setSelectedNodeId(node.id);
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setDragging({
      nodeId: node.id,
      offsetX: e.clientX - rect.left,
      offsetY: e.clientY - rect.top,
    });
  };

  const handleCanvasMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!dragging) return;
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = Math.max(0, e.clientX - rect.left - dragging.offsetX);
    const y = Math.max(0, e.clientY - rect.top - dragging.offsetY);
    setNodes(prev =>
      prev.map(n => (n.id === dragging.nodeId ? { ...n, pos: { x, y } } : n))
    );
  };

  const selectedNode = nodes.find(n => n.id === selectedNodeId) ?? null;

  // Fix #5: update label on selected node
  const handleLabelChange = (value: string) => {
    if (!selectedNodeId) return;
    setNodes(prev => prev.map(n => (n.id === selectedNodeId ? { ...n, label: value } : n)));
  };

  const toggleGuard = (index: number) => {
    setExecutionGuards(prev =>
      prev.map((g, i) => (i === index ? { ...g, active: !g.active } : g))
    );
  };

  return (
    <div className="h-[calc(100vh-120px)] flex flex-col gap-8 font-['Space_Grotesk'] transition-colors duration-300">
      {/* Builder Toolbar */}
      <TCard i={0} as="header" className="flex items-center justify-between bg-card/50 backdrop-blur-2xl p-6 rounded-[3rem] border border-border shadow-2xl">
        <div className="flex items-center gap-12 px-6">
          <div className="flex flex-col">
             <h2 className="text-lg font-black tracking-tighter text-foreground flex items-center gap-4 uppercase">
                Agent Workflow
                <Badge className="bg-primary/10 text-primary border-primary/20 text-[9px] font-black h-5 px-3 tracking-widest uppercase">BETA</Badge>
             </h2>
             <p className="text-[10px] text-muted-foreground font-black uppercase tracking-[0.3em] mt-1 opacity-60">Intelligence Pipeline Editor</p>
          </div>
        </div>

        <div className="flex items-center gap-5 pr-4">
           <Button
            onClick={handleStoreConfig}
            disabled={isSaving}
            variant="outline" className="h-14 px-10 rounded-[1.5rem] border-border bg-muted/20 text-muted-foreground font-black uppercase tracking-widest text-[11px] gap-3 hover:bg-muted/50 hover:border-primary/40 transition-all active:scale-95 disabled:opacity-50">
              {isSaving ? <RefreshCw className="w-5 h-5 text-primary animate-spin" /> : <Save className="w-5 h-5 text-primary" />}
              {isSaving ? "Saving..." : "Store Config"}
           </Button>
           <TooltipProvider>
             <Tooltip>
               <TooltipTrigger asChild>
                 <button
                  onClick={handleDeployFleet}
                  disabled={isDeploying || !savedAutomationId}
                  className="h-14 px-12 rounded-[1.5rem] bg-primary text-primary-foreground font-black uppercase tracking-[0.2em] text-[11px] gap-4 shadow-2xl shadow-primary/20 transition-all active:scale-95 disabled:opacity-50 flex items-center justify-center relative overflow-visible group">
                   <div className="absolute -left-3 top-1/2 -translate-y-1/2 w-12 h-12 rounded-[1.25rem] border-4 border-background bg-white flex items-center justify-center shadow-2xl group-hover:rotate-12 transition-transform">
                      <img src="/logo.png" alt="Logo" className="w-7 h-7 object-contain" />
                   </div>
                   <span className="ml-8 flex items-center gap-3">
                      {isDeploying ? <RefreshCw className="w-5 h-5 animate-spin" /> : <Play className="w-5 h-5 fill-primary-foreground" />}
                      {isDeploying ? "Deploying..." : "Deploy Fleet"}
                   </span>
                 </button>
               </TooltipTrigger>
               {!savedAutomationId && (
                 <TooltipContent className="bg-black text-white border-white/10 text-[10px] font-bold uppercase tracking-widest">
                   Save configuration first
                 </TooltipContent>
               )}
             </Tooltip>
           </TooltipProvider>
        </div>
      </TCard>
      {!savedAutomationId && (
        <p className="text-center text-[10px] font-bold uppercase tracking-widest text-muted-foreground/50 -mt-4">
          Store your config first to enable deployment
        </p>
      )}

      {/* Main Canvas Area */}
      <div className="flex-1 flex gap-8 overflow-hidden">
        {/* Components Panel */}
        <aside className="w-80 bg-card/50 backdrop-blur-2xl border border-border p-10 flex flex-col gap-12 rounded-[3.5rem] shadow-2xl">
           <div className="space-y-8">
              <h3 className="text-[10px] uppercase tracking-[0.4em] font-black text-muted-foreground">Logic Blocks</h3>
              <div className="grid grid-cols-1 gap-5">
                 {LOGIC_BLOCKS.map((comp) => (
                    <div
                      key={comp.label}
                      onClick={() => addNode(comp)}
                      className="group p-6 rounded-[2rem] bg-muted/10 border border-border hover:border-primary/40 hover:bg-muted/30 hover:shadow-2xl hover:shadow-primary/5 cursor-grab active:cursor-grabbing transition-all flex items-center gap-6">
                       <div className={cn("p-4 rounded-xl shadow-lg border border-border group-hover:border-primary/20 transition-all", comp.bg, comp.iconColor)}>
                          <comp.icon className="w-5 h-5" />
                       </div>
                       <span className="text-[14px] font-black text-muted-foreground group-hover:text-foreground uppercase tracking-tight transition-colors">{comp.label}</span>
                    </div>
                 ))}
              </div>
           </div>

           <div className="mt-auto p-8 rounded-[2rem] bg-primary/5 border border-primary/10 space-y-5 shadow-inner">
              <div className="flex items-center gap-3 text-primary">
                 <Info className="w-6 h-6" />
                 <span className="text-[11px] font-black uppercase tracking-[0.3em]">Builder Neural Logic</span>
              </div>
              <p className="text-[14px] text-muted-foreground leading-relaxed font-bold tracking-tight opacity-70">
                 Connect **Reasoning Nodes** to **Knowledge Retrieval** for high-fidelity organizational synthesis.
              </p>
           </div>
        </aside>

        {/* Visual Flow Canvas — Fix #6: drag via mouse events, Fix #7: dynamic SVG lines */}
        <div
          ref={canvasRef}
          className="flex-1 bg-muted/30 border border-border rounded-[4rem] relative overflow-hidden group/canvas shadow-2xl backdrop-blur-sm bg-[radial-gradient(var(--border)_1px,transparent_1px)] bg-[length:40px_40px] select-none"
          onMouseMove={handleCanvasMouseMove}
          onMouseUp={() => setDragging(null)}
          onClick={() => setSelectedNodeId(null)}
        >
           <div className="absolute inset-0 bg-gradient-to-br from-primary/5 via-transparent to-secondary/5 opacity-50 pointer-events-none" />

           {/* Fix #7: dynamic SVG connector lines derived from node positions */}
           <svg className="absolute inset-0 w-full h-full pointer-events-none">
              {nodes.slice(0, -1).map((node, i) => {
                const next = nodes[i + 1];
                const x1 = node.pos.x + NODE_W;
                const y1 = node.pos.y + NODE_H / 2;
                const x2 = next.pos.x;
                const y2 = next.pos.y + NODE_H / 2;
                const isFirst = i === 0;
                return (
                  <path
                    key={`line-${node.id}-${next.id}`}
                    d={`M ${x1} ${y1} C ${(x1 + x2) / 2} ${y1}, ${(x1 + x2) / 2} ${y2}, ${x2} ${y2}`}
                    stroke={isFirst ? "var(--border)" : "var(--primary)"}
                    strokeWidth="3"
                    fill="none"
                    strokeDasharray="8 8"
                    className={isFirst ? "animate-pulse" : "opacity-40"}
                  />
                );
              })}
           </svg>

           {/* Nodes */}
           {nodes.map((node) => (
              <div
                key={node.id}
                className={cn(
                  "absolute p-8 rounded-[2.5rem] bg-card/90 backdrop-blur-3xl border w-64 group/node hover:shadow-2xl hover:shadow-primary/10 transition-all cursor-move shadow-2xl",
                  selectedNodeId === node.id
                    ? "border-primary/60 shadow-primary/20 ring-2 ring-primary/20"
                    : "border-border hover:border-primary/50"
                )}
                style={{ left: node.pos.x, top: node.pos.y }}
                onMouseDown={(e) => handleNodeMouseDown(e, node)}
                onClick={(e) => { e.stopPropagation(); setSelectedNodeId(node.id); }}
              >
                <div className="flex items-center justify-between mb-6">
                   <div className={cn("p-4 rounded-2xl text-primary-foreground shadow-2xl transition-transform group-hover/node:rotate-12 group-hover/node:scale-110", node.color)}>
                      <node.icon className="w-6 h-6" />
                   </div>
                   <Badge variant="ghost" className="text-[10px] font-black uppercase tracking-[0.3em] text-muted-foreground/40">{node.type}</Badge>
                </div>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <h4 className="text-xl font-black text-foreground mb-2 uppercase tracking-tighter truncate">{node.label}</h4>
                  </TooltipTrigger>
                  <TooltipContent className="bg-black text-white border-white/10 text-[10px] font-bold uppercase tracking-widest">
                    {node.label}
                  </TooltipContent>
                </Tooltip>
                <div className="flex items-center gap-3">
                   <div className="h-2.5 w-2.5 rounded-full bg-emerald-500 animate-pulse shadow-[0_0_10px_rgba(16,185,129,0.5)]" />
                   <span className="text-[11px] font-black text-muted-foreground/50 uppercase tracking-[0.2em]">Neural Active</span>
                </div>

                {/* Ports */}
                <div className="absolute -right-3 top-1/2 -translate-y-1/2 h-6 w-6 rounded-full bg-background border-[3px] border-primary group-hover/node:scale-125 transition-all shadow-2xl" />
                <div className="absolute -left-3 top-1/2 -translate-y-1/2 h-6 w-6 rounded-full bg-background border-[3px] border-primary group-hover/node:scale-125 transition-all shadow-2xl" />
              </div>
           ))}

           {nodes.length === 0 && (
             <div className="absolute inset-0 flex items-center justify-center">
               <p className="text-muted-foreground text-[13px] font-bold uppercase tracking-widest opacity-40">
                 Click a logic block to add a node
               </p>
             </div>
           )}
        </div>

        {/* Properties Panel — Fix #5: controlled inputs bound to selected node state */}
        <aside className="w-80 bg-card/50 backdrop-blur-2xl border border-border p-12 flex flex-col gap-10 rounded-[3.5rem] shadow-2xl">
           <div className="space-y-8">
              <h3 className="text-[10px] uppercase tracking-[0.4em] font-black text-muted-foreground">Node Synthesis</h3>
              <div className="p-8 rounded-[2rem] bg-muted/10 border border-border space-y-8 shadow-inner">
                 <div className="space-y-4">
                    <label className="text-[10px] font-black uppercase tracking-[0.3em] text-muted-foreground/40 px-2">Pipeline Label</label>
                    <input
                      value={selectedNode?.label ?? ""}
                      onChange={(e) => handleLabelChange(e.target.value)}
                      placeholder={selectedNode ? "" : "Select a node…"}
                      className="w-full h-14 bg-muted/20 border border-border rounded-2xl px-6 text-foreground text-sm font-black focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/40 transition-all uppercase tracking-tight placeholder:text-muted-foreground/30"
                    />
                 </div>
                 <div className="space-y-4">
                    <label className="text-[10px] font-black uppercase tracking-[0.3em] text-muted-foreground/40 px-2">Core Logic Engine</label>
                    <div className="w-full flex items-center justify-between h-14 px-6 bg-primary/10 text-primary border border-primary/20 rounded-2xl font-black text-[11px] uppercase tracking-widest shadow-sm">
                       GPT-4o Reasoning
                       <BrainCircuit className="w-5 h-5" />
                    </div>
                 </div>
              </div>
           </div>

           {/* Fix #5: execution guards are now stateful and togglable */}
           <div className="space-y-8">
              <h3 className="text-[10px] uppercase tracking-[0.4em] font-black text-muted-foreground">Execution Guard</h3>
              <div className="space-y-4">
                 {executionGuards.map((guard, i) => (
                    <button
                      key={guard.label}
                      onClick={() => toggleGuard(i)}
                      className="w-full flex items-center justify-between p-5 rounded-[1.5rem] bg-muted/10 border border-border hover:border-primary/30 transition-all group text-left"
                    >
                       <span className="text-[12px] font-black text-muted-foreground uppercase tracking-tight group-hover:text-foreground">{guard.label}</span>
                       <div className={cn("h-6 w-12 rounded-full relative transition-all duration-500 shadow-inner", guard.active ? "bg-primary" : "bg-muted")}>
                          <div className={cn("absolute top-1 h-4 w-4 rounded-full bg-white transition-all shadow-md", guard.active ? "right-1" : "left-1")} />
                       </div>
                    </button>
                 ))}
              </div>
           </div>

           {/* Fix #4: remove selected node, not last node */}
           <Button
            onClick={handleDeconstruct}
            disabled={!selectedNodeId}
            variant="outline" className="mt-auto h-16 w-full rounded-[2rem] border-border text-destructive hover:bg-destructive/10 hover:border-destructive/20 font-black uppercase tracking-[0.3em] text-[10px] gap-3 transition-all active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed">
              <Trash2 className="w-5 h-5" />
              {selectedNodeId ? "Deconstruct Block" : "Select a node first"}
           </Button>
        </aside>
      </div>
    </div>
  );
}
