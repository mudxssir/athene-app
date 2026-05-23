'use client'

import { TCard } from "@/components/ui/kit";
import { useState, useEffect } from 'react'
import { useOrganization } from '@clerk/nextjs'
import { useRouter } from 'next/navigation'
import {
  Key,
  Plus,
  Trash2,
  RefreshCw,
  CheckCircle2,
  XCircle,
  ShieldAlert,
  ExternalLink,
  Activity
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

type ProviderID = 'anthropic' | 'openai' | 'google' | 'deepseek'

interface LLMKey {
  id: string
  provider: ProviderID
  key_hint: string
  label: string
  is_active: boolean
  last_used_at: string | null
  updated_at: string
}

const PROVIDERS: Array<{
  id: ProviderID
  name: string
  icon: string
  gatewayUrl: string
  models: Array<{ id: string; name: string }>
}> = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    icon: 'https://cdn.brandfetch.io/id_2W7X4W0/theme/dark/logo.svg',
    gatewayUrl: 'https://api.anthropic.com/v1',
    models: [
      { id: 'claude-3-7-sonnet', name: 'Claude 3.7 Sonnet' },
      { id: 'claude-3-5-sonnet', name: 'Claude 3.5 Sonnet' },
      { id: 'claude-3-opus', name: 'Claude 3 Opus' },
      { id: 'claude-3-haiku', name: 'Claude 3 Haiku' }
    ]
  },
  {
    id: 'openai',
    name: 'OpenAI',
    icon: 'https://cdn.brandfetch.io/id_X8Z_R-U/theme/dark/logo.svg',
    gatewayUrl: 'https://api.openai.com/v1',
    models: [
      { id: 'gpt-4o', name: 'GPT-4o' },
      { id: 'gpt-4o-mini', name: 'GPT-4o mini' },
      { id: 'o1', name: 'o1' },
      { id: 'o3-mini', name: 'o3-mini' }
    ]
  },
  {
    id: 'google',
    name: 'Google Vertex',
    icon: 'https://cdn.brandfetch.io/id_6mN-v_p/theme/dark/logo.svg',
    gatewayUrl: 'https://us-central1-aiplatform.googleapis.com',
    models: [
      { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
      { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
      { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash' }
    ]
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    icon: 'https://cdn.brandfetch.io/id_deepseek/theme/dark/logo.svg',
    gatewayUrl: 'https://api.deepseek.com/v1',
    models: [
      { id: 'deepseek-chat', name: 'DeepSeek V3 (Chat)' },
      { id: 'deepseek-reasoner', name: 'DeepSeek R1 (Reasoner)' },
    ]
  },
]

export default function KeysPage() {
  const { isLoaded, membership } = useOrganization()
  const router = useRouter()

  const [keys, setKeys] = useState<LLMKey[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isAdding, setIsAdding] = useState(false)
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  
  const [newKey, setNewKey] = useState<{ provider: ProviderID; model: string; key: string; label: string }>({
    provider: 'anthropic',
    model: 'claude-3-7-sonnet',
    key: '',
    label: '',
  })

  function handleProviderChange(providerId: string) {
    const selectedProvider = PROVIDERS.find(p => p.id === providerId)
    if (!selectedProvider) return
    setNewKey({
      ...newKey,
      provider: selectedProvider.id,
      model: selectedProvider.models[0]?.id || '',
    })
  }

  // 🛡️ Client-side Admin Gate (Issue #10)
  const isAdmin = membership?.role === 'org:admin'

  useEffect(() => {
    if (isLoaded && !isAdmin) {
      toast.error('Admin access required')
      router.push('/dashboard')
    }
  }, [isLoaded, isAdmin, router])

  useEffect(() => {
    if (isAdmin) fetchKeys()
  }, [isAdmin])

  async function fetchKeys() {
    try {
      setIsLoading(true)
      const res = await fetch('/api/admin/keys')
      if (!res.ok) throw new Error('Failed to fetch keys')
      const data = await res.json()
      setKeys(data)
    } catch (err: any) {
      toast.error(err.message)
    } finally {
      setIsLoading(false)
    }
  }

  async function handleAddKey() {
    if (!newKey.key) return toast.error('Key content is required')
    
    try {
      setIsAdding(true)
      const res = await fetch('/api/admin/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...newKey,
          label: newKey.label || `${newKey.provider} key (${newKey.model})`
        })
      })
      
      if (!res.ok) {
        const error = await res.json()
        throw new Error(error.error || 'Failed to add key')
      }
      
      toast.success(`${newKey.provider} key added successfully`)
      setNewKey({ provider: 'anthropic', model: 'claude-3-7-sonnet', key: '', label: '' })
      setIsAdding(false)
      fetchKeys()
    } catch (err: any) {
      toast.error(err.message)
      setIsAdding(false)
    }
  }

  async function toggleStatus(id: string, currentStatus: boolean) {
    try {
      const res = await fetch('/api/admin/keys', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, is_active: !currentStatus })
      })
      if (!res.ok) throw new Error('Failed to update status')
      toast.success(currentStatus ? 'Key deactivated' : 'Key activated')
      fetchKeys()
    } catch (err: any) {
      toast.error(err.message)
    }
  }

  async function deleteKey(id: string) {
    if (!confirm('Are you sure you want to permanently delete this key?')) return
    
    try {
      const res = await fetch(`/api/admin/keys?id=${id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error('Failed to delete key')
      toast.success('Key deleted successfully')
      fetchKeys()
    } catch (err: any) {
      toast.error(err.message)
    }
  }

  if (!isLoaded || isLoading) {
    return <div className="flex items-center justify-center min-h-[400px] animate-pulse text-[var(--sidebar-text-secondary)]">Loading configuration...</div>
  }

  return (
    <div className="space-y-10 pb-20 font-['Space_Grotesk'] transition-colors duration-300">
      <TCard i={0} as="header" className="flex flex-col lg:flex-row lg:items-end justify-between gap-8">
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <div className="p-3 rounded-2xl bg-gradient-to-br from-primary/10 to-secondary/10 border border-border shadow-lg">
              <Key className="w-7 h-7 text-primary" />
            </div>
            <h1 className="text-4xl font-black tracking-tighter text-foreground uppercase">
              Key <span className="text-primary">Management</span>
            </h1>
          </div>
          <p className="text-muted-foreground text-lg max-w-xl font-medium leading-relaxed">
            Configure your own API keys for the Athene core agents. Keys are encrypted at rest using your organization's unique KMS secret.
          </p>
        </div>
      </TCard>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Add Key Form */}
        <section className="lg:col-span-1 space-y-6">
          <div className="p-8 rounded-[2.5rem] border border-border bg-card/50 backdrop-blur-xl shadow-2xl transition-colors duration-300">
            <h2 className="text-lg font-black mb-6 flex items-center gap-3 uppercase tracking-tight text-foreground">
              <Plus className="w-5 h-5 text-primary" />
              Register Provider
            </h2>
            <div className="space-y-5">
              <div className="space-y-2">
                <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground/60">Provider</label>
                <select 
                  className="w-full h-12 px-4 rounded-xl border border-border bg-muted/30 text-sm font-bold text-foreground outline-none focus:border-primary/40 transition-colors appearance-none"
                  value={newKey.provider}
                  onChange={(e) => handleProviderChange(e.target.value)}
                >
                  {PROVIDERS.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>

              {/* LLM Model Dropdown */}
              <div className="space-y-2">
                <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground/60">Target LLM</label>
                <select
                  className="w-full h-12 px-4 rounded-xl border border-border bg-muted/30 text-sm font-bold text-foreground outline-none focus:border-primary/40 transition-colors appearance-none"
                  value={newKey.model}
                  onChange={(e) => setNewKey({ ...newKey, model: e.target.value })}
                >
                  {PROVIDERS.find(p => p.id === newKey.provider)?.models?.map(m => (
                    <option key={m.id} value={m.id}>{m.name}</option>
                  ))}
                </select>
              </div>

              {/* Embedded Gateway URL */}
              <div className="space-y-2">
                <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground/60 flex items-center gap-1.5">
                  API Gateway URL
                  <a
                    href={PROVIDERS.find(p => p.id === newKey.provider)?.gatewayUrl || '#'}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hover:text-primary transition-colors"
                    title="Open API Gateway Docs"
                  >
                    <ExternalLink className="w-3 h-3 text-primary" />
                  </a>
                </label>
                <div className="p-3 rounded-xl bg-muted/20 border border-border text-[11px] font-mono text-muted-foreground flex items-center justify-between select-all overflow-x-auto">
                  <span>{PROVIDERS.find(p => p.id === newKey.provider)?.gatewayUrl || 'N/A'}</span>
                  <span className="text-[9px] bg-primary/10 text-primary px-1.5 py-0.5 rounded font-sans font-bold uppercase tracking-wider shrink-0 ml-2">Gateway</span>
                </div>
              </div>

              <div className="space-y-2">
                <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground/60">Label (Optional)</label>
                <input 
                  type="text"
                  placeholder="e.g. Production Anthropic Key"
                  className="w-full h-12 px-4 rounded-xl border border-border bg-muted/30 text-sm font-bold text-foreground outline-none focus:border-primary/40 transition-colors placeholder:text-muted-foreground/30"
                  value={newKey.label}
                  onChange={(e) => setNewKey({ ...newKey, label: e.target.value })}
                />
              </div>

              <div className="space-y-2">
                <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground/60">API Key</label>
                <textarea 
                  className="w-full p-4 rounded-xl border border-border bg-muted/30 text-sm font-mono text-foreground outline-none focus:border-primary/40 transition-colors h-24 resize-none placeholder:text-muted-foreground/30"
                  placeholder="Paste your secret key here..."
                  value={newKey.key}
                  onChange={(e) => setNewKey({ ...newKey, key: e.target.value })}
                />
                <p className="text-[10px] text-muted-foreground/60 italic font-medium leading-relaxed">
                  Key will be encrypted before storage. Only the last 4 chars will remain visible in the ledger.
                </p>
              </div>

              <Button 
                onClick={handleAddKey}
                disabled={isAdding}
                className="w-full h-14 rounded-2xl bg-primary hover:bg-primary/90 text-primary-foreground font-black uppercase tracking-widest text-[11px] gap-3 shadow-xl shadow-primary/10 transition-all active:scale-95"
              >
                {isAdding ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                Securely Register
              </Button>
            </div>
          </div>

          <div className="p-6 rounded-2xl border border-warning/20 bg-warning/5 flex gap-4 backdrop-blur-sm">
            <ShieldAlert className="w-6 h-6 text-warning shrink-0" />
            <p className="text-xs text-warning/80 font-bold leading-relaxed">
              Active BYOK keys override system defaults. Ensure your keys have sufficient quota to prevent agent service interruptions.
            </p>
          </div>
        </section>

        {/* Keys Table */}
        <section className="lg:col-span-2 space-y-6">
          <div className="rounded-[2.5rem] bg-card/50 border border-border overflow-hidden backdrop-blur-xl shadow-2xl transition-colors duration-300">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-muted/30 border-b border-border">
                  <th className="p-6 text-[10px] font-black uppercase tracking-widest text-muted-foreground">Provider</th>
                  <th className="p-6 text-[10px] font-black uppercase tracking-widest text-muted-foreground">Status</th>
                  <th className="p-6 text-[10px] font-black uppercase tracking-widest text-muted-foreground">Usage</th>
                  <th className="p-6 text-right text-[10px] font-black uppercase tracking-widest text-muted-foreground">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {keys.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="p-20 text-center text-muted-foreground italic font-bold">
                      No BYOK keys configured. Athene is using system defaults.
                    </td>
                  </tr>
                ) : (
                  keys.map((k) => (
                    <tr key={k.id} className="hover:bg-muted/20 transition-colors group">
                      <td className="p-6">
                        <div className="flex items-center gap-4">
                          <div className="w-10 h-10 rounded-xl bg-muted border border-border flex items-center justify-center p-2 group-hover:border-primary/20 transition-colors shadow-sm">
                             <Activity className="w-5 h-5 text-primary" />
                          </div>
                          <div>
                            <div className="text-sm font-black text-foreground capitalize tracking-tight">{k.provider}</div>
                            <div className="text-[10px] text-muted-foreground font-mono font-bold">{k.key_hint}</div>
                          </div>
                        </div>
                      </td>
                      <td className="p-6">
                        <button 
                          onClick={() => toggleStatus(k.id, k.is_active)}
                          className={cn(
                            "flex items-center gap-2 px-3 py-1.5 rounded-lg text-[9px] font-black uppercase tracking-widest transition-all",
                            k.is_active 
                              ? 'bg-accent/10 text-accent border border-accent/20' 
                              : 'bg-destructive/10 text-destructive border border-destructive/20'
                          )}
                        >
                          {k.is_active ? <CheckCircle2 className="w-3.5 h-3.5" /> : <XCircle className="w-3.5 h-3.5" />}
                          {k.is_active ? 'Active' : 'Disabled'}
                        </button>
                      </td>
                      <td className="p-6">
                        <div className="space-y-1">
                          <div className="text-[10px] text-muted-foreground/40 uppercase font-black tracking-widest">Last Used</div>
                          <div className="text-xs text-foreground font-bold">
                            {k.last_used_at && mounted ? new Date(k.last_used_at).toLocaleDateString() : 'Never'}
                          </div>
                        </div>
                      </td>
                      <td className="p-6 text-right">
                        <div className="flex items-center justify-end gap-2">
                          <Button 
                            variant="ghost"
                            size="icon"
                            onClick={() => deleteKey(k.id)}
                            className="h-9 w-9 rounded-xl hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-all"
                            title="Delete Key"
                          >
                            <Trash2 className="w-4 h-4" />
                          </Button>
                          <Button 
                            variant="ghost"
                            size="icon"
                            className="h-9 w-9 rounded-xl hover:bg-primary/10 text-muted-foreground hover:text-primary transition-all"
                            title="Rotate Key"
                            onClick={() => {
                                const matchedProvider = PROVIDERS.find(p => p.id === k.provider)
                                setNewKey({
                                  provider: k.provider,
                                  model: matchedProvider?.models?.[0]?.id || 'claude-3-7-sonnet',
                                  key: '',
                                  label: k.label,
                                })
                                toast.info(`Enter new key for ${k.provider} to rotate.`)
                            }}
                          >
                            <RefreshCw className="w-4 h-4" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between px-2">
            <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground/40">
              Total Managed Keys: {keys.length}
            </p>
            <a href="https://docs.athene.ai/byok" target="_blank" className="text-[10px] font-black uppercase tracking-widest text-primary hover:underline flex items-center gap-1">
              Configuration Guide <ExternalLink className="w-3 h-3" />
            </a>
          </div>
        </section>
      </div>
    </div>
  )
}

