"use client";

import { useEffect, useState, useCallback } from "react";
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
  MoreVertical
} from "lucide-react";


import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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


export default function UsersPage() {
  const [users, setUsers] = useState<UserMember[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [loading, setLoading] = useState(true);
  const [isInviteOpen, setIsInviteOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const limit = 50;

  const fetchUsers = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/users?page=${page}&limit=${limit}&search=${encodeURIComponent(search)}`);
      const data = await res.json();
      if (res.ok) {
        setUsers(data.users);
        setTotal(data.total);
      }
    } catch (err) {
      toast.error("Failed to load users");
    } finally {
      setLoading(false);
    }
  }, [page, search]);


  const fetchDepartments = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/departments");
      const data = await res.json();
      if (res.ok) setDepartments(data.departments);
    } catch (err) {
      console.error("Failed to fetch departments");
    }
  }, []);

  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    fetchUsers();
    fetchDepartments();
  }, [fetchUsers, fetchDepartments]);


  const handleUpdateUser = async (userId: string, updates: UserUpdates) => {
    if (updates.active === false) {
      const confirm = window.confirm("Are you sure you want to deactivate this account? This will immediately revoke their access.");
      if (!confirm) return;
    }

    try {
      const res = await fetch(`/api/admin/users/${userId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      });

      if (res.ok) {
        toast.success("User updated successfully");
        fetchUsers();
      } else {
        const data = await res.json();
        toast.error(data.error || "Failed to update user");
      }
    } catch (err) {
      toast.error("An error occurred");
    }
  };


  // Server-side search implemented in fetchUsers
  const filteredUsers = users;


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

  return (
    <div className="space-y-10 animate-in fade-in slide-in-from-bottom-4 duration-700 pb-20 font-['Space_Grotesk'] transition-colors duration-300">
      
      <InviteModal 
        isOpen={isInviteOpen} 
        onClose={() => setIsInviteOpen(false)} 
        onSuccess={fetchUsers} 
      />

      {/* Header Section */}
      <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-8">
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
      </div>

      {/* Search and Filters */}
      <div className="flex flex-col sm:flex-row gap-4 items-center p-2 rounded-2xl bg-muted/10 border border-border">
         <div className="relative flex-1 group">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground transition-colors group-focus-within:text-primary" />
            <input 
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1); // Reset to page 1 on search
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
              [...Array(5)].map((_, i) => (
                <TableRow key={i} className="border-border">
                  <TableCell colSpan={6} className="py-8 px-8"><Loader2 className="w-6 h-6 animate-spin text-muted/30 mx-auto" /></TableCell>
                </TableRow>
              ))
            ) : filteredUsers.length === 0 ? (
              <TableRow className="border-border">
                <TableCell colSpan={6} className="py-20 text-center">
                  <p className="text-muted-foreground font-bold">No members found matching your search.</p>
                </TableCell>
              </TableRow>
            ) : (
              filteredUsers.map((user) => (
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
                    {user.last_active_at && mounted ? new Date(user.last_active_at).toLocaleDateString() : "Never"}
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
                        
                        <DropdownMenuLabel className="text-[9px] font-bold text-muted-foreground/40 mt-2 uppercase tracking-wider">Modify Role</DropdownMenuLabel>
                        <DropdownMenuItem onClick={() => handleUpdateUser(user.id, { role: "admin" })} className="gap-2 cursor-pointer font-bold text-xs rounded-lg">
                          <ShieldAlert className="w-4 h-4 text-primary" /> Admin
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => handleUpdateUser(user.id, { role: "super_user" })} className="gap-2 cursor-pointer font-bold text-xs rounded-lg">
                          <ShieldCheck className="w-4 h-4 text-secondary" /> BI Analyst
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => handleUpdateUser(user.id, { role: "member" })} className="gap-2 cursor-pointer font-bold text-xs rounded-lg">
                          <Shield className="w-4 h-4 text-muted-foreground" /> Member
                        </DropdownMenuItem>
                        
                        <DropdownMenuSeparator className="bg-border" />
                        <DropdownMenuLabel className="text-[9px] font-bold text-muted-foreground/40 mt-2 uppercase tracking-wider">Department</DropdownMenuLabel>
                        {departments.map(dept => (
                          <DropdownMenuItem 
                            key={dept.id} 
                            onClick={() => handleUpdateUser(user.id, { departmentId: dept.id })}
                            className={cn("gap-2 cursor-pointer font-bold text-xs rounded-lg", user.department_id === dept.id && "bg-primary/10 text-primary")}
                          >
                            <Building2 className="w-4 h-4" /> {dept.name}
                          </DropdownMenuItem>
                        ))}
                        
                        <DropdownMenuSeparator className="bg-border" />
                        {user.active ? (
                          <DropdownMenuItem 
                            onClick={() => handleUpdateUser(user.id, { active: false })}
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
              disabled={page * limit >= total}
              onClick={() => setPage(p => p + 1)}
              className="h-8 w-8 p-0 rounded-lg border-border hover:bg-muted"
            >
              <ChevronRight className="w-4 h-4" />
            </Button>
          </div>
        </div>
      </div>
    </div>

  );
}
