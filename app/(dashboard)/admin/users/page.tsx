"use client";

import { TCard } from "@/components/ui/kit";
import { useEffect, useState, useCallback, useRef } from "react";
import {
  Users,
  UserPlus,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Building2,
  Circle,
  Search,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Trash2,
  UserCheck,
  MoreVertical,
  Check,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { InviteModal } from "@/components/users/invite-modal";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

interface Department {
  id: string;
  name: string;
}

interface UserMember {
  id: string;
  clerk_user_id: string | null;
  email: string;
  display_name: string;
  role: "admin" | "super_user" | "member";
  department_id: string;
  active: boolean;
  last_active_at: string | null;
  departments?: Department;
}

interface UserUpdates {
  role?: "admin" | "super_user" | "member";
  departmentId?: string;
  active?: boolean;
}

// ── Deactivate Confirm Dialog ────────────────────────────────
// Replaces window.confirm — keeps the dark-theme aesthetic and doesn't
// block the main thread.
function DeactivateConfirmDialog({
  user,
  onConfirm,
  onCancel,
}: {
  user: UserMember;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onCancel} />
      <div className="relative bg-card border border-border rounded-3xl p-8 w-full max-w-md shadow-2xl space-y-6 mx-4">
        <div className="space-y-2">
          <h3 className="text-2xl font-black tracking-tighter uppercase text-foreground">
            Deactivate Account?
          </h3>
          <p className="text-muted-foreground font-medium text-sm leading-relaxed">
            This will immediately revoke access for{" "}
            <strong className="text-foreground">{user.display_name || user.email}</strong>.
            They will be signed out on their next request.
          </p>
        </div>
        <div className="flex gap-3 pt-2">
          <button
            onClick={onCancel}
            className="flex-1 h-12 rounded-2xl border border-border bg-transparent text-muted-foreground font-black uppercase tracking-widest text-[10px] hover:bg-muted/30 transition-all"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="flex-1 h-12 rounded-2xl bg-destructive text-destructive-foreground font-black uppercase tracking-widest text-[10px] hover:bg-destructive/90 transition-all"
          >
            Deactivate
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────
export default function UsersPage() {
  const [users, setUsers] = useState<UserMember[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [loading, setLoading] = useState(true);
  const [isInviteOpen, setIsInviteOpen] = useState(false);
  // search is the immediate input value; debouncedSearch drives the API call
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [deactivateTarget, setDeactivateTarget] = useState<UserMember | null>(null);
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const limit = 50;

  // Debounce: only update debouncedSearch 300ms after the user stops typing
  useEffect(() => {
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    searchDebounceRef.current = setTimeout(() => setDebouncedSearch(search), 300);
    return () => { if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current); };
  }, [search]);

  const fetchUsers = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(
        `/api/admin/users?page=${page}&limit=${limit}&search=${encodeURIComponent(debouncedSearch)}`
      );
      const data = await res.json();
      if (res.ok) {
        setUsers(data.users);
        setTotal(data.total);
      }
    } catch {
      toast.error("Failed to load users");
    } finally {
      setLoading(false);
    }
  }, [page, debouncedSearch]);

  const fetchDepartments = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/departments");
      const data = await res.json();
      if (res.ok) setDepartments(data.departments);
    } catch {
      console.error("Failed to fetch departments");
    }
  }, []);

  // Fetch departments once on mount — not tied to page/search changes
  useEffect(() => {
    fetchDepartments();
  }, [fetchDepartments]);

  // Fetch users when page or debouncedSearch changes
  useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

  const handleUpdateUser = async (userId: string, updates: UserUpdates) => {
    // Optimistically update local state so the UI reflects the change instantly
    setUsers(prev =>
      prev.map(u => {
        if (u.id !== userId) return u;
        return {
          ...u,
          ...(updates.role      !== undefined && { role:          updates.role }),
          ...(updates.active    !== undefined && { active:        updates.active }),
          ...(updates.departmentId !== undefined && {
            department_id: updates.departmentId,
            departments: departments.find(d => d.id === updates.departmentId),
          }),
        };
      })
    );

    try {
      const res = await fetch(`/api/admin/users/${userId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      });

      const data = await res.json();

      if (res.ok || res.status === 207) {
        // Sync local state from the authoritative server response rather than
        // keeping the optimistic value — the DB may have coerced fields or the
        // Clerk role may have diverged (207 partial-success case).
        if (data.member) {
          setUsers(prev =>
            prev.map(u => {
              if (u.id !== userId) return u;
              const m = data.member;
              return {
                ...u,
                role:          m.role          ?? u.role,
                active:        m.active        ?? u.active,
                department_id: m.department_id ?? u.department_id,
                departments:   m.department_id
                  ? (departments.find(d => d.id === m.department_id) ?? u.departments)
                  : u.departments,
              };
            })
          );
        }
        if (data.warning) {
          // 207 — DB updated but Clerk sync failed; surface the partial-success warning
          toast.warning(data.warning, { duration: 6000 });
        } else {
          toast.success("User updated successfully");
        }
      } else {
        toast.error(data.error || "Failed to update user");
        // Roll back optimistic update on failure
        fetchUsers();
      }
    } catch {
      toast.error("An error occurred");
      fetchUsers();
    }
  };

  const handleDeactivateConfirm = () => {
    if (!deactivateTarget) return;
    handleUpdateUser(deactivateTarget.id, { active: false });
    setDeactivateTarget(null);
  };

  const getRoleBadge = (role: string) => {
    switch (role) {
      case "admin":
        return <Badge className="bg-primary/20 text-primary border-primary/30 px-3 py-1 rounded-lg gap-1.5"><ShieldAlert className="w-3 h-3" /> Admin</Badge>;
      case "super_user":
        return <Badge className="bg-secondary/20 text-secondary border-secondary/30 px-3 py-1 rounded-lg gap-1.5"><ShieldCheck className="w-3 h-3" /> BI Analyst</Badge>;
      default:
        return <Badge className="bg-white/5 text-slate-400 border-white/10 px-3 py-1 rounded-lg gap-1.5"><Shield className="w-3 h-3" /> Member</Badge>;
    }
  };

  const totalPages = Math.ceil(total / limit) || 1;

  return (
    <div className="space-y-10 pb-20 font-['Space_Grotesk'] transition-colors duration-300">

      {/* Deactivate confirmation dialog */}
      {deactivateTarget && (
        <DeactivateConfirmDialog
          user={deactivateTarget}
          onConfirm={handleDeactivateConfirm}
          onCancel={() => setDeactivateTarget(null)}
        />
      )}

      <InviteModal
        isOpen={isInviteOpen}
        onClose={() => setIsInviteOpen(false)}
        onSuccess={fetchUsers}
        departments={departments}
      />

      {/* Header Section */}
      <TCard i={0} className="flex flex-col lg:flex-row lg:items-end justify-between gap-8">
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <div className="p-3 rounded-2xl bg-gradient-to-br from-primary/10 to-secondary/10 border border-border shadow-lg">
              <Users className="w-7 h-7 text-primary" />
            </div>
            <h1 className="text-4xl font-black tracking-tighter text-foreground uppercase">
              Identity <span className="text-primary">Governance</span>
            </h1>
          </div>
          <p className="text-muted-foreground text-lg max-w-2xl font-medium leading-relaxed">
            Manage organization membership, roles, and departmental access.
            Audit all administrative actions in real-time.
          </p>
        </div>

        <div className="flex items-center gap-4">
          <div className="flex flex-col items-end mr-4 hidden sm:flex">
            <span className="text-[10px] uppercase tracking-widest font-black text-muted-foreground/40 mb-1">Population</span>
            <div className="flex items-center gap-2 px-4 py-2 rounded-xl bg-muted/20 border border-border">
              <div className="h-2 w-2 rounded-full bg-primary animate-pulse" />
              <span className="text-xs font-bold text-foreground tracking-tight">{total} Members</span>
            </div>
          </div>
          <Button
            onClick={() => setIsInviteOpen(true)}
            className="h-14 px-8 rounded-2xl bg-primary hover:bg-primary/90 text-primary-foreground font-black uppercase tracking-widest text-[11px] gap-3 shadow-xl shadow-primary/10 group"
          >
            <UserPlus className="w-4 h-4" />
            Invite User
          </Button>
        </div>
      </TCard>

      {/* Search */}
      <div className="flex flex-col sm:flex-row gap-4 items-center p-2 rounded-2xl bg-muted/10 border border-border">
        <div className="relative flex-1 group">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground transition-colors group-focus-within:text-primary" />
          <input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            placeholder="Search by name or email..."
            className="w-full h-12 pl-12 pr-4 bg-transparent outline-none text-sm font-bold text-foreground placeholder:text-muted-foreground/40"
          />
        </div>
      </div>

      {/* Users Table */}
      <div className="rounded-[2.5rem] bg-card/50 border border-border overflow-hidden backdrop-blur-xl shadow-2xl transition-colors duration-300">
        <Table>
          <TableHeader className="bg-muted/30 border-b border-border">
            <TableRow className="hover:bg-transparent border-none">
              <TableHead className="py-6 px-8 text-[10px] font-black uppercase tracking-widest text-muted-foreground">Member</TableHead>
              <TableHead className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Role</TableHead>
              <TableHead className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Department</TableHead>
              <TableHead className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Status</TableHead>
              <TableHead className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Last Active</TableHead>
              <TableHead className="text-right py-6 px-8"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              // Per-column skeleton cells that mirror the actual row layout
              [...Array(5)].map((_, i) => (
                <TableRow key={i} className="border-border">
                  <TableCell className="py-6 px-8">
                    <div className="flex items-center gap-4">
                      <Skeleton className="w-10 h-10 rounded-xl shrink-0" />
                      <div className="space-y-2">
                        <Skeleton className="h-3 w-32" />
                        <Skeleton className="h-2.5 w-24" />
                      </div>
                    </div>
                  </TableCell>
                  <TableCell><Skeleton className="h-6 w-20 rounded-lg" /></TableCell>
                  <TableCell><Skeleton className="h-3 w-24" /></TableCell>
                  <TableCell><Skeleton className="h-3 w-16" /></TableCell>
                  <TableCell><Skeleton className="h-3 w-20" /></TableCell>
                  <TableCell className="text-right px-8">
                    <Skeleton className="h-8 w-8 rounded-lg ml-auto" />
                  </TableCell>
                </TableRow>
              ))
            ) : users.length === 0 ? (
              <TableRow className="border-border">
                <TableCell colSpan={6} className="py-20 text-center">
                  <p className="text-muted-foreground font-bold">No members found matching your search.</p>
                </TableCell>
              </TableRow>
            ) : (
              users.map((user) => (
                <TableRow key={user.id} className="hover:bg-muted/20 border-border group transition-colors">
                  <TableCell className="py-6 px-8">
                    <div className="flex items-center gap-4">
                      <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-primary/10 to-secondary/10 flex items-center justify-center text-xs font-black text-foreground border border-border shadow-sm">
                        {user.display_name?.charAt(0).toUpperCase() || user.email.charAt(0).toUpperCase()}
                      </div>
                      <div className="flex flex-col">
                        <span className="font-black text-sm text-foreground tracking-tight">{user.display_name}</span>
                        <span className="text-xs text-muted-foreground font-medium">{user.email}</span>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>{getRoleBadge(user.role)}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2 text-xs font-bold text-muted-foreground/60">
                      <Building2 className="w-3.5 h-3.5 opacity-50" />
                      {user.departments?.name || "Unassigned"}
                    </div>
                  </TableCell>
                  <TableCell>
                    {user.active ? (
                      <div className="flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-accent">
                        <Circle className="w-2 h-2 fill-current animate-pulse" />
                        Active
                      </div>
                    ) : (
                      <div className="flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-muted-foreground/40">
                        <Circle className="w-2 h-2 fill-current" />
                        Deactivated
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="text-xs font-bold text-muted-foreground/60">
                    {/* Use a fixed locale + UTC to ensure server and client render the same string */}
                    {user.last_active_at
                      ? new Date(user.last_active_at).toLocaleDateString("en-GB", { timeZone: "UTC" })
                      : "Never"}
                  </TableCell>

                  <TableCell className="text-right py-6 px-8">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-8 w-8 rounded-lg hover:bg-muted/50">
                          <MoreVertical className="w-4 h-4 text-muted-foreground" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-56 bg-popover border-border text-popover-foreground rounded-xl shadow-2xl backdrop-blur-xl">
                        <DropdownMenuLabel className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Management Actions</DropdownMenuLabel>
                        <DropdownMenuSeparator className="bg-border" />

                        {/* Role section — checkmark indicates the current role */}
                        <DropdownMenuLabel className="text-[9px] font-bold text-muted-foreground/40 mt-2 uppercase tracking-wider">Modify Role</DropdownMenuLabel>
                        {(["admin", "super_user", "member"] as const).map((r) => {
                          const isCurrent = user.role === r;
                          const label = r === "admin" ? "Admin" : r === "super_user" ? "BI Analyst" : "Member";
                          const Icon = r === "admin" ? ShieldAlert : r === "super_user" ? ShieldCheck : Shield;
                          const iconColor = r === "admin" ? "text-primary" : r === "super_user" ? "text-secondary" : "text-muted-foreground";
                          return (
                            <DropdownMenuItem
                              key={r}
                              onClick={() => !isCurrent && handleUpdateUser(user.id, { role: r })}
                              className={cn(
                                "gap-2 cursor-pointer font-bold text-xs rounded-lg",
                                isCurrent && "bg-primary/10 pointer-events-none opacity-70"
                              )}
                            >
                              <Icon className={cn("w-4 h-4", iconColor)} />
                              {label}
                              {isCurrent && <Check className="w-3 h-3 ml-auto text-primary" />}
                            </DropdownMenuItem>
                          );
                        })}

                        <DropdownMenuSeparator className="bg-border" />
                        <DropdownMenuLabel className="text-[9px] font-bold text-muted-foreground/40 mt-2 uppercase tracking-wider">Department</DropdownMenuLabel>
                        {departments.map(dept => (
                          <DropdownMenuItem
                            key={dept.id}
                            onClick={() => handleUpdateUser(user.id, { departmentId: dept.id })}
                            className={cn("gap-2 cursor-pointer font-bold text-xs rounded-lg", user.department_id === dept.id && "bg-primary/10 text-primary")}
                          >
                            <Building2 className="w-4 h-4" /> {dept.name}
                            {user.department_id === dept.id && <Check className="w-3 h-3 ml-auto" />}
                          </DropdownMenuItem>
                        ))}

                        <DropdownMenuSeparator className="bg-border" />
                        {user.active ? (
                          <DropdownMenuItem
                            onClick={() => setDeactivateTarget(user)}
                            className="gap-2 text-destructive focus:text-destructive cursor-pointer font-bold text-xs rounded-lg"
                          >
                            <Trash2 className="w-4 h-4" /> Deactivate Account
                          </DropdownMenuItem>
                        ) : (
                          <DropdownMenuItem
                            onClick={() => handleUpdateUser(user.id, { active: true })}
                            className="gap-2 text-accent focus:text-accent cursor-pointer font-bold text-xs rounded-lg"
                          >
                            <UserCheck className="w-4 h-4" /> Reactivate Account
                          </DropdownMenuItem>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>

        {/* Pagination */}
        <div className="bg-muted/10 border-t border-border px-8 py-4 flex items-center justify-between">
          <span className="text-[10px] font-black uppercase tracking-widest text-muted-foreground/40">
            {search ? `Found ${total} matches` : `Showing ${users.length} of ${total} members`}
          </span>

          <div className="flex items-center gap-3">
            <span className="text-xs font-bold text-muted-foreground/60">
              Page {page} of {totalPages}
            </span>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={page === 1}
                onClick={() => setPage(p => p - 1)}
                className="h-8 w-8 p-0 rounded-lg border-border hover:bg-muted"
              >
                <ChevronLeft className="w-4 h-4" />
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={page >= totalPages}
                onClick={() => setPage(p => p + 1)}
                className="h-8 w-8 p-0 rounded-lg border-border hover:bg-muted"
              >
                <ChevronRight className="w-4 h-4" />
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
