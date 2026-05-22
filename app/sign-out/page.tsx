"use client";

import { useClerk } from "@clerk/nextjs";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export default function SignOutPage() {
    const { signOut } = useClerk();
    const router = useRouter();
    const [mounted, setMounted] = useState(false);

    useEffect(() => {
        setMounted(true);
        signOut().then(() => {
            router.push("/");
        });
    }, [signOut, router]);

    if (!mounted) return null;

    return (
        <div className="flex min-h-screen items-center justify-center bg-[#06080c] text-white">
            <div className="flex flex-col items-center gap-4">
                <div className="h-8 w-8 animate-spin rounded-full border-4 border-secondary border-t-transparent" />
                <p className="text-sm font-black uppercase tracking-[0.2em]">Signing out of Athene...</p>
            </div>
        </div>
    );
}

