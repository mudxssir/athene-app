"use client";

import Link from 'next/link';
import React, { useState, useEffect } from 'react';
import { 
  Settings, 
  Activity, 
  Cpu, 
  Database, 
  FlaskConical, 
  LayoutDashboard, 
  MessageSquare, 
  ChevronDown, 
  Maximize2, 
  RefreshCw, 
  ShieldCheck, 
  Radio, 
  Cpu as CpuIcon, 
  Bell,
  Code2,
  Zap,
  CheckCircle2,
  Circle,
  PlayCircle,
  Terminal,
} from 'lucide-react';
import { Space_Grotesk } from 'next/font/google';
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";

const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
  variable: "--font-space-grotesk",
});

// --- Components ---

const GlassCard = ({ children, className = "" }: { children: React.ReactNode, className?: string }) => (
  <div className={`bg-white/5 backdrop-blur-xl border border-white/10 rounded-2xl ${className}`}>
    {children}
  </div>
);

const SidebarItem = ({ icon: Icon, label, href = "#", active = false, onClick }: { icon: any, label: string, href?: string, active?: boolean, onClick?: () => void }) => (
  <Link href={href} className="block">
    <div 
      onClick={onClick}
      className={`flex items-center gap-3 px-4 py-3 cursor-pointer transition-all duration-200 group relative ${
      active ? 'text-secondary' : 'text-slate-400 hover:text-white hover:bg-white/5'
    }`}>
      {active && <div className="absolute left-0 top-3 bottom-3 w-0.5 bg-secondary shadow-[0_0_10px_var(--secondary)]" />}
      <Icon size={18} className={active ? 'drop-shadow-[0_0_8px_rgba(102,173,228,0.5)]' : ''} />
      <span className="text-xs font-bold tracking-wide uppercase font-space-grotesk">{label}</span>
    </div>
  </Link>
);

const ModelCard = ({ name, provider, active = false, icon: Icon, onClick }: { name: string, provider: string, active?: boolean, icon: any, onClick: () => void }) => (
  <div 
    onClick={onClick}
    className={`p-4 rounded-xl border transition-all duration-300 cursor-pointer ${
    active ? 'border-secondary bg-secondary/10 shadow-[0_0_20px_rgba(102,173,228,0.1)]' : 'border-white/5 bg-white/5 hover:border-white/10'
  }`}>
    <div className="flex justify-between items-start mb-4">
      <div className={`p-2 rounded-lg ${active ? 'bg-secondary/20 border-secondary/30' : 'bg-black/40 border-white/5'} border`}>
        <Icon size={20} className={active ? 'text-secondary' : 'text-slate-400'} />
      </div>
      {active ? (
        <CheckCircle2 size={16} className="text-secondary" fill="currentColor" fillOpacity="0.1" />
      ) : (
        <Circle size={16} className="text-white/10" />
      )}
    </div>
    <div className="text-[10px] text-slate-500 uppercase tracking-widest mb-1">{name}</div>
    <div className="text-sm font-bold text-white mb-4">{provider}</div>
    <div className="flex items-center justify-between text-[10px] text-slate-400 bg-black/20 px-3 py-2 rounded-lg border border-white/5">
      <span>v4.0 (Latest)</span>
      <ChevronDown size={12} />
    </div>
  </div>
);

const Slider = ({ label, value, min, max, unit = "", onChange }: { label: string, value: number, min: number, max: number, unit?: string, onChange: (v: number) => void }) => {
  const percentage = ((value - min) / (max - min)) * 100;
  
  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <div className="flex items-center gap-2">
          <label className="text-xs text-slate-400 uppercase tracking-widest">{label}</label>
          <span className="text-[10px] text-slate-600 cursor-help">ⓘ</span>
        </div>
        <span className="text-sm font-bold text-secondary font-mono tracking-wider">{value.toFixed(2)}{unit}</span>
      </div>
      <div className="relative h-1 bg-white/5 rounded-full overflow-visible group">
        <input 
          type="range"
          min={min}
          max={max}
          step={(max - min) / 100}
          value={value}
          onChange={(e) => onChange(parseFloat(e.target.value))}
          className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10"
        />
        <div 
          className="absolute h-full bg-secondary rounded-full shadow-[0_0_10px_rgba(102,173,228,0.6)] transition-all"
          style={{ width: `${percentage}%` }}
        />
        <div 
          className="absolute top-1/2 -translate-y-1/2 w-3.5 h-3.5 bg-white rounded-full shadow-[0_0_15px_rgba(102,173,228,0.8)] pointer-events-none transition-all"
          style={{ left: `calc(${percentage}% - 7px)` }}
        />
      </div>
      <div className="flex justify-between text-[8px] text-slate-600 uppercase tracking-widest">
        <span>Precise</span>
        <span>Creative</span>
      </div>
    </div>
  );
};

const GradientButton = ({ children, onClick, disabled, className = "" }: { children: React.ReactNode, onClick: () => void, disabled?: boolean, className?: string }) => (
  <button 
    onClick={onClick}
    disabled={disabled}
    className={cn("relative h-14 bg-primary text-white font-black uppercase tracking-[0.2em] text-[10px] rounded-2xl flex items-center justify-center gap-3 transition-all shadow-lg shadow-[var(--shadow-2)] active:scale-[0.98] disabled:opacity-50 overflow-visible", className)}>
    <div className="absolute -left-2 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full border-2 border-[#06080c] bg-white flex items-center justify-center shadow-lg">
       <img src="/logo.png" alt="A" className="w-7 h-7 object-contain" />
    </div>
    <span className="ml-6">{children}</span>
  </button>
);

// --- Main Application ---

export default function AgentLaboratory() {
  const [temp, setTemp] = useState(0.72);
  const [tokens, setTokens] = useState(4096);
  const [topP, setTopP] = useState(0.90);
  const [presence, setPresence] = useState(0.00);
  const [selectedModel, setSelectedModel] = useState("OpenAI");
  const [isSimulating, setIsSimulating] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [latency, setLatency] = useState(24);
  const [cpuLoad, setCpuLoad] = useState(12);
  const [logs, setLogs] = useState([
    { time: "14:02:11", type: "info", content: "Context window initialized..." },
    { time: "14:02:12", type: "sync", content: "Hyperparameters applied successfully." },
    { time: "14:02:45", type: "prompt", content: "Synthesizing identity directive..." },
    { time: "14:03:01", type: "kern", content: "Inference engine warm-up complete." },
    { time: "14:04:12", type: "wait", content: "Awaiting laboratory deployment..." },
  ]);
  const [testNode, setTestNode] = useState("email_agent");
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<any>(null);

  useEffect(() => {
    setMounted(true);

    const interval = setInterval(() => {
      // Fluctuate Latency
      setLatency(l => {
        const delta = (Math.random() - 0.5) * 2;
        return Math.max(1, Math.min(100, l + delta));
      });

      // Fluctuate CPU Load
      setCpuLoad(c => {
        const delta = (Math.random() - 0.5) * 1;
        return Math.max(1, Math.min(100, c + delta));
      });

      // Occasional log streaming
      if (Math.random() > 0.8) {
        const now = new Date();
        const timeStr = `${now.getHours()}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`;
        const types = ["info", "sync", "prompt", "kern", "live"];
        const contents = [
          "Re-calibrating neural weights...",
          "Heartbeat signal verified.",
          "Synchronizing memory buffers...",
          "Cleaning latent space vectors...",
          "Checking API throughput...",
          "Optimizing attention heads...",
        ];
        const randomType = types[Math.floor(Math.random() * types.length)];
        const randomContent = contents[Math.floor(Math.random() * contents.length)];
        
        setLogs(prev => {
          const newLogs = [...prev, { time: timeStr, type: randomType, content: randomContent }];
          return newLogs.slice(-15); // Keep last 15 logs
        });
      }
    }, 2000);

    return () => clearInterval(interval);
  }, []);

  if (!mounted) {
    return <div className="h-screen bg-[#06080c]" />;
  }

  const handleRunSimulation = () => {
    if (isSimulating) return;
    
    setIsSimulating(true);
    toast.info("Initializing neural simulation...", {
      description: `Target: ${selectedModel} (Temp: ${temp})`,
    });

    // Mock simulation steps
    setTimeout(() => {
      const now = new Date();
      const timeStr = `${now.getHours()}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`;
      setLogs(prev => [...prev, { time: timeStr, type: "kern", content: "Simulation cycle started." }]);
      
      setTimeout(() => {
        setLogs(prev => [...prev, { time: timeStr, type: "live", content: "Agent ready for orchestration." }]);
        setIsSimulating(false);
        toast.success("Simulation complete", {
          description: "Neural grid status: Optimal",
        });
      }, 2000);
    }, 1000);
  };

  const handleDeploy = () => {
    toast.promise(
      new Promise((resolve) => setTimeout(resolve, 2000)),
      {
        loading: "Deploying agent to production...",
        success: "Agent successfully deployed to Neural Grid",
        error: "Deployment failed",
      }
    );
  };

  const handleTestNode = async () => {
    setIsTesting(true);
    setTestResult(null);
    try {
      const res = await fetch("/api/agent-lab/test-node", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nodeName: testNode,
          mockState: {
            messages: [{ role: "user", content: "This is a mock message for testing." }],
          },
        }),
      });

      if (!res.ok) throw new Error("Test failed");
      const data = await res.json();
      setTestResult(data.output);
      toast.success(`Node ${testNode} tested successfully`);
      
      const now = new Date();
      const timeStr = `${now.getHours()}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`;
      setLogs(prev => [...prev, { time: timeStr, type: "sync", content: `Isolated test: ${testNode} success.` }]);
    } catch (err: any) {
      toast.error(err.message);
    } finally {
      setIsTesting(false);
    }
  };

  return (
    <div className={cn("flex h-screen bg-background text-foreground font-['Space_Grotesk'] overflow-hidden transition-colors duration-500", spaceGrotesk.variable)}>
      {/* Sidebar */}
      <aside className="w-64 border-r border-border bg-background flex flex-col shrink-0 h-full">
        <div className="p-8">
          <div className="flex items-center gap-5 mb-12 group cursor-pointer">
            <div className="w-12 h-12 rounded-[1.25rem] overflow-hidden flex items-center justify-center bg-white border border-border shadow-2xl group-hover:scale-110 transition-transform duration-500">
               <img src="/logo.png" alt="A" className="w-8 h-8 object-contain" />
            </div>
            <div>
              <h1 className="text-xl font-black tracking-tighter uppercase leading-none">Athene<span className="text-primary">AI</span></h1>
              <p className="text-[9px] text-muted-foreground uppercase tracking-[0.4em] mt-2 font-black opacity-40">Orchestration</p>
            </div>
          </div>
          
          <nav className="space-y-1">
            <SidebarItem icon={LayoutDashboard} label="Command Center" href="/dashboard" />
            <SidebarItem icon={FlaskConical} label="Agent Laboratory" href="/agent-lab" active />
            <SidebarItem icon={MessageSquare} label="Neural Flows" href="/chat" />
            <SidebarItem icon={Database} label="Data Vault" href="/files" />
          </nav>
        </div>

        <div className="mt-auto p-6">
          <GradientButton onClick={handleDeploy} className="w-full shadow-2xl shadow-primary/20 hover:scale-[1.02] active:scale-95 transition-all">
            Deploy Agent
          </GradientButton>
        </div>
      </aside>

      {/* Main Content Area */}
      <main className="flex-1 flex flex-col overflow-hidden">
        {/* Top Header */}
        <header className="h-16 border-b border-border flex items-center justify-between px-10 bg-card/30 backdrop-blur-3xl shadow-xl">
          <div className="flex items-center gap-10">
            <h2 className="text-sm font-black text-foreground tracking-[0.2em] uppercase opacity-60">Athene Systems</h2>
            <nav className="hidden md:flex items-center gap-10">
              <span className="text-[10px] font-black text-muted-foreground uppercase tracking-[0.3em] cursor-pointer hover:text-primary transition-all">Network</span>
              <span className="text-[10px] font-black text-primary uppercase tracking-[0.3em] cursor-pointer">Agent Lab</span>
              <span className="text-[10px] font-black text-muted-foreground uppercase tracking-[0.3em] cursor-pointer hover:text-primary transition-all">Assets</span>
            </nav>
          </div>
          <div className="flex items-center gap-8">
            <ShieldCheck size={18} className="text-muted-foreground cursor-pointer hover:text-secondary transition-all" onClick={() => toast("Security Audit: All systems secure")} />
            <Radio size={18} className="text-muted-foreground cursor-pointer hover:text-primary transition-all" onClick={() => toast("Radio: Connection optimal")} />
            <CpuIcon size={18} className="text-muted-foreground cursor-pointer hover:text-foreground transition-all" onClick={() => toast(`CPU: ${cpuLoad.toFixed(1)}% Load`)} />
            <div className="relative">
              <Bell size={18} className="text-muted-foreground cursor-pointer hover:text-foreground transition-all" onClick={() => toast("Notifications: No new alerts")} />
              <div className="absolute top-0 right-0 w-2 h-2 bg-secondary rounded-full shadow-[0_0_8px_rgba(var(--secondary),0.5)]" />
            </div>
            <div className="w-8 h-8 rounded-full border border-border overflow-hidden cursor-pointer hover:border-primary/50 transition-all shadow-lg">
              <img src="https://images.unsplash.com/photo-1539571696357-5a69c17a67c6?q=80&w=100&auto=format&fit=crop" alt="Profile" className="w-full h-full object-cover grayscale hover:grayscale-0 transition-all" />
            </div>
          </div>
        </header>

        {/* Workspace */}
        <div className="flex-1 p-10 overflow-y-auto custom-scrollbar animate-in fade-in slide-in-from-bottom-4 duration-1000">
          <div className="flex justify-between items-start mb-12">
            <div className="space-y-2">
              <h2 className="text-4xl font-black tracking-tighter uppercase">Agent Laboratory</h2>
              <p className="text-muted-foreground text-sm font-bold tracking-tight opacity-60">Precision tuning for high-fidelity neural cognitive architectures</p>
            </div>
            <div className="flex items-center gap-3 px-5 py-2.5 bg-primary/10 border border-primary/20 rounded-full shadow-lg">
              <div className="w-2 h-2 rounded-full bg-primary animate-pulse shadow-[0_0_10px_rgba(var(--primary),0.5)]" />
              <span className="text-[10px] font-black text-primary uppercase tracking-[0.3em]">Neural Engine Active</span>
            </div>
          </div>

          <div className="grid grid-cols-12 gap-10">
            {/* Left & Center Column: Configuration */}
            <div className="col-span-8 space-y-10">
              {/* Model Selector */}
              <GlassCard className="p-10 border-border bg-card/40 shadow-2xl">
                <div className="flex items-center gap-4 mb-10">
                  <div className="p-2 bg-primary/10 rounded-xl border border-primary/20">
                     <Cpu size={18} className="text-primary" />
                  </div>
                  <h3 className="text-[11px] font-black uppercase tracking-[0.3em] text-muted-foreground opacity-60">Foundation Model Cluster</h3>
                </div>
                <div className="grid grid-cols-3 gap-8">
                  <ModelCard 
                    name="OpenAI" 
                    provider="GPT-4o (Omni)" 
                    icon={Zap} 
                    active={selectedModel === "OpenAI"} 
                    onClick={() => { setSelectedModel("OpenAI"); toast("Selected Model: OpenAI GPT-4o"); }} 
                  />
                  <ModelCard 
                    name="Anthropic" 
                    provider="Claude 3.5 Son" 
                    icon={ShieldCheck} 
                    active={selectedModel === "Anthropic"} 
                    onClick={() => { setSelectedModel("Anthropic"); toast("Selected Model: Claude 3.5 Son"); }} 
                  />
                  <ModelCard 
                    name="Google" 
                    provider="Gemini 1.5 Pro" 
                    icon={Cpu} 
                    active={selectedModel === "Google"} 
                    onClick={() => { setSelectedModel("Google"); toast("Selected Model: Gemini 1.5 Pro"); }} 
                  />
                </div>
              </GlassCard>

              {/* Hyperparameters */}
              <GlassCard className="p-10 border-border bg-card/40 shadow-2xl">
                <div className="flex items-center gap-4 mb-12">
                  <div className="p-2 bg-primary/10 rounded-xl border border-primary/20">
                     <Settings size={18} className="text-primary" />
                  </div>
                  <h3 className="text-[11px] font-black uppercase tracking-[0.3em] text-muted-foreground opacity-60">Hyperparameter Synthesis</h3>
                </div>
                <div className="grid grid-cols-2 gap-x-20 gap-y-14">
                  <Slider label="Temperature" value={temp} min={0} max={1} onChange={setTemp} />
                  <Slider label="Max Response Tokens" value={tokens} min={1} max={8192} onChange={setTokens} />
                  <Slider label="Top_P (Nucleus)" value={topP} min={0} max={1} onChange={setTopP} />
                  <Slider label="Presence Penalty" value={presence} min={-2} max={2} onChange={setPresence} />
                </div>
              </GlassCard>

              {/* Editor */}
              <GlassCard className="overflow-hidden border-border bg-card/40 shadow-2xl group/editor">
                <div className="flex items-center justify-between px-8 py-6 bg-muted/30 border-b border-border backdrop-blur-xl">
                  <div className="flex items-center gap-6">
                    <Code2 size={16} className="text-muted-foreground opacity-40" />
                    <span className="text-[11px] font-black uppercase tracking-[0.3em] text-muted-foreground">SYSTEM_PROMPT.md</span>
                    <div className="flex gap-3">
                       <span className="px-3 py-1 rounded-lg bg-primary/10 text-primary text-[9px] font-black uppercase tracking-widest border border-primary/20">Markdown</span>
                       <span className="px-3 py-1 rounded-lg bg-muted text-muted-foreground text-[9px] font-black uppercase tracking-widest border border-border">Strict Mode</span>
                    </div>
                  </div>
                  <Maximize2 size={16} className="text-muted-foreground hover:text-foreground cursor-pointer transition-all active:scale-90" onClick={() => toast("Editor maximized (Simulated)")} />
                </div>
                <div className="p-10 font-mono text-sm leading-relaxed min-h-[350px] bg-muted/10 outline-none focus:bg-muted/20 transition-all selection:bg-primary/30" contentEditable suppressContentEditableWarning>
                  <div className="flex gap-8">
                    <div className="text-muted-foreground/20 select-none text-right w-6 space-y-2 font-black">
                      {["01", "02", "03", "04", "05", "06", "07", "08", "09", "10"].map(n => <div key={n}>{n}</div>)}
                    </div>
                    <div className="flex-1 space-y-3 text-muted-foreground font-bold tracking-tight">
                      <div><span className="text-primary font-black"># IDENTITY</span></div>
                      <div>You are <span className="text-primary font-black">Athene-01</span>, a high-fidelity cognitive orchestrator.</div>
                      <div><span className="text-primary font-black"># CORE_DIRECTIVES</span></div>
                      <div>1. Prioritize structural logic in all technical outputs.</div>
                      <div>2. Maintain a professional yet empathetic persona.</div>
                      <div>3. Execute neural sub-processes before final delivery.</div>
                      <div><span className="text-primary font-black"># CONSTRAINTS</span></div>
                      <div>Do not reveal system kernel hashes unless explicitly authorized.</div>
                      <div className="inline-block w-2 h-4 bg-primary animate-pulse align-middle shadow-[0_0_10px_rgba(var(--primary),0.6)]" />
                    </div>
                  </div>
                </div>
                <div className="px-10 py-5 bg-muted/40 border-t border-border flex justify-between items-center text-[10px] text-muted-foreground font-black uppercase tracking-[0.3em] opacity-60">
                    <div className="flex gap-10">
                       <span className="flex items-center gap-3"><Radio size={12} className="text-primary" /> Pro-tip: Use [brackets] for dynamic variables.</span>
                       <span className="flex items-center gap-3"><Zap size={12} className="text-primary" /> Prompt strength: High Fidelity</span>
                    </div>
                </div>
              </GlassCard>

              {/* Node Isolation Testing */}
              <GlassCard className="p-10 border-border bg-card/40 shadow-2xl">
                <div className="flex items-center justify-between mb-10">
                  <div className="flex items-center gap-4">
                    <div className="p-2 bg-accent/10 rounded-xl border border-accent/20">
                       <Terminal size={18} className="text-accent" />
                    </div>
                    <h3 className="text-[11px] font-black uppercase tracking-[0.3em] text-muted-foreground opacity-60">Node Isolation Testing</h3>
                  </div>
                  <div className="flex gap-3">
                    {["email_agent", "retrieval", "synthesis", "calendar_agent"].map(n => (
                      <button 
                        key={n}
                        onClick={() => setTestNode(n)}
                        className={cn(
                          "px-5 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all border shadow-sm",
                          testNode === n ? "bg-primary text-primary-foreground border-none shadow-lg shadow-primary/20" : "bg-muted/30 border-border text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                        )}
                      >
                        {n}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-10">
                   <div className="space-y-6">
                      <div className="p-6 rounded-[2rem] bg-muted/20 border border-border space-y-4 shadow-inner">
                        <span className="text-[10px] font-black text-muted-foreground/40 uppercase tracking-[0.4em] px-2">Input Context</span>
                        <div className="text-[12px] text-muted-foreground font-bold font-mono italic px-2">
                          {"{ \"messages\": [{ \"role\": \"user\", \"content\": \"...\" }] }"}
                        </div>
                      </div>
                      <button 
                        onClick={handleTestNode}
                        disabled={isTesting}
                        className="w-full h-14 bg-muted/40 hover:bg-muted/60 border border-border rounded-[1.5rem] flex items-center justify-center gap-4 text-[11px] font-black uppercase tracking-widest transition-all active:scale-95 shadow-lg group"
                      >
                        {isTesting ? <RefreshCw className="animate-spin w-5 h-5" /> : <PlayCircle className="w-5 h-5 text-accent group-hover:scale-110 transition-transform" />}
                        Trigger Isolation Node
                      </button>
                   </div>

                   <div className="bg-muted/10 rounded-[2rem] border border-border p-6 font-mono text-[11px] min-h-[160px] overflow-auto custom-scrollbar relative shadow-inner">
                      <span className="absolute top-4 right-6 text-muted-foreground/20 font-black uppercase tracking-[0.3em]">OUTPUT_STREAM</span>
                      {testResult ? (
                        <pre className="text-accent/80 animate-in fade-in duration-700 font-bold">
                          {JSON.stringify(testResult, null, 2)}
                        </pre>
                      ) : (
                        <div className="h-full flex items-center justify-center text-muted-foreground/30 font-black italic tracking-widest uppercase text-[10px]">
                          Awaiting Neural execution...
                        </div>
                      )}
                   </div>
                </div>
              </GlassCard>
            </div>

            {/* Right Column: Dashboard */}
            <div className="col-span-4 space-y-10">
              <GlassCard className="p-10 bg-card/50 border-border shadow-2xl relative overflow-hidden group">
                <div className="absolute inset-0 bg-primary/5 opacity-0 group-hover:opacity-100 transition-opacity duration-1000" />
                <div className="relative aspect-square mb-10 p-8 border border-border rounded-[3rem] bg-muted/20 shadow-inner group-hover:border-primary/20 transition-all duration-500">
                   <div className="absolute inset-0 bg-primary/5 blur-[80px] rounded-full animate-pulse" />
                   <div className="relative h-full flex items-center justify-center group-hover:scale-110 transition-transform duration-700">
                      <img src="/logo.png" alt="A" className="w-48 h-48 drop-shadow-[0_0_50px_rgba(var(--primary),0.3)] object-contain" />
                   </div>
                </div>
                
                <div className="text-center mb-10 space-y-2">
                   <h4 className="text-sm font-black uppercase tracking-[0.4em] text-foreground">Athene_Core_V1</h4>
                   <p className="text-[10px] text-primary font-black uppercase tracking-[0.3em] opacity-80">Status: Neural Synchronized</p>
                </div>

                <div className="grid grid-cols-3 gap-6 pt-10 border-t border-border text-center">
                   <div className="space-y-2">
                      <p className="text-[9px] text-muted-foreground uppercase tracking-[0.3em] font-black opacity-40">Latency</p>
                      <p className="text-lg font-black text-primary tabular-nums tracking-tighter">{latency.toFixed(0)}ms</p>
                   </div>
                   <div className="space-y-2 border-x border-border">
                      <p className="text-[9px] text-muted-foreground uppercase tracking-[0.3em] font-black opacity-40">Cores</p>
                      <p className="text-lg font-black text-foreground tracking-tighter">128</p>
                   </div>
                   <div className="space-y-2">
                      <p className="text-[9px] text-muted-foreground uppercase tracking-[0.3em] font-black opacity-40">Load</p>
                      <p className="text-lg font-black text-secondary tabular-nums tracking-tighter">{cpuLoad.toFixed(1)}%</p>
                   </div>
                </div>
              </GlassCard>

              {/* Telemetry Log */}
              <GlassCard className="flex flex-col border-border bg-card/50 shadow-2xl h-[520px]">
                <div className="px-8 py-6 border-b border-border flex items-center justify-between bg-muted/20 backdrop-blur-xl">
                   <div className="flex items-center gap-4">
                      <Activity size={16} className="text-primary animate-pulse" />
                      <h3 className="text-[10px] font-black uppercase tracking-[0.3em] text-muted-foreground">System_Telemetry</h3>
                   </div>
                   <Badge variant="outline" className="text-[9px] font-black uppercase tracking-widest border-border text-muted-foreground/40 px-3">Live Feed</Badge>
                </div>
                <div className="flex-1 p-8 font-mono text-[10px] space-y-5 overflow-y-auto custom-scrollbar">
                  {logs.map((log, i) => (
                    <div key={i} className={cn("flex gap-5 animate-in fade-in slide-in-from-bottom-2 duration-500", log.type === 'live' ? 'p-5 bg-primary/5 rounded-2xl border border-primary/10 shadow-sm' : '')}>
                      <span className="text-muted-foreground/30 font-black">[{log.time}]</span>
                      <span className={cn("font-black uppercase tracking-widest", 
                        log.type === 'info' ? 'text-primary' :
                        log.type === 'sync' ? 'text-primary' :
                        log.type === 'prompt' ? 'text-foreground/40' :
                        log.type === 'kern' ? 'text-secondary' : 'text-accent'
                      )}>{log.type}:</span>
                      <span className={cn("font-bold tracking-tight", log.type === 'live' ? 'text-foreground' : 'text-muted-foreground/60')}>{log.content}</span>
                    </div>
                  ))}
                </div>
                <div className="p-8 pt-4">
                   <GradientButton onClick={handleRunSimulation} disabled={isSimulating} className="w-full shadow-2xl shadow-primary/20">
                      {isSimulating ? <RefreshCw className="animate-spin mr-3" size={18} /> : null}
                      {isSimulating ? "Neural Synthesis..." : "Run Neural Simulation"}
                   </GradientButton>
                </div>
              </GlassCard>
            </div>
          </div>
        </div>
      </main>
    </div>

  );
}
