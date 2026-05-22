"use client";

import { SignIn } from "@clerk/nextjs";
import Image from "next/image";
import { useEffect, useState } from "react";

export default function CleanSignInPage() {
    const [mounted, setMounted] = useState(false);

    useEffect(() => {
        setMounted(true);
    }, []);

    // Prevent hydration mismatch by only rendering the themed container on the client
    // if there's a chance the server/client themes differ.
    // Or just make them the same.
    
    return (
        <div className="flex min-h-screen w-full flex-col items-center justify-center bg-[#06080c] p-4 font-['Space_Grotesk']">
            {/* Decorative Background Elements to match Landing Page */}
            <div className="absolute top-0 left-1/2 -translate-x-1/2 w-full max-w-7xl h-[400px] bg-secondary/5 blur-[120px] -z-10 rounded-full opacity-50" />

            {/* Centered Minimalist Logo */}
            <div className="mb-8 flex flex-col items-center animate-in fade-in slide-in-from-bottom-4 duration-700">
                <div className="w-16 h-16 rounded-2xl overflow-hidden flex items-center justify-center shadow-[0_0_30px_rgba(102,173,228,0.2)] bg-white mb-4">
                    <img src="/logo.png" alt="A" className="w-10 h-10 object-contain p-1" />
                </div>
                <h1 className="text-2xl font-black text-white tracking-tighter">
                    Athene<span className="text-secondary">AI</span>
                </h1>
            </div>

            {/* Clean, Centered Clerk Card */}
            <div className="w-full max-w-[400px] animate-in fade-in slide-in-from-bottom-8 duration-1000 delay-200">
                <SignIn
                    routing="path"
                    path="/sign-in"
                    signUpUrl="/sign-up"
                    appearance={{
                        elements: {
                            // Dark theme card
                            card: "bg-[#0c1017]/80 backdrop-blur-xl shadow-2xl border border-white/5 rounded-2xl w-full",
                            headerTitle: "text-2xl font-black text-white tracking-tighter",
                            headerSubtitle: "text-sm text-slate-400 font-medium",
                            
                            // Form inputs
                            formFieldInput: "flex h-12 w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-secondary/50 focus:border-transparent transition-all",
                            formFieldLabel: "text-xs font-black uppercase tracking-widest text-slate-400 mb-1",

                            // Buttons
                            formButtonPrimary: "bg-primary hover:opacity-90 h-12 px-4 py-2 rounded-xl font-black uppercase tracking-widest text-xs text-white transition-all shadow-lg shadow-[var(--shadow-2)]",
                            
                            // Social buttons
                            socialButtonsBlockButton: "bg-white/5 border border-white/10 hover:bg-white/10 h-12 rounded-xl text-white font-bold transition-all",
                            socialButtonsBlockButtonText: "text-white font-bold",

                            // Text colors
                            dividerLine: "bg-white/10",
                            dividerText: "text-slate-500 text-[10px] font-black uppercase tracking-widest",
                            footerActionLink: "text-secondary hover:text-[#599bc9] font-bold",
                            identityPreviewText: "text-white",
                            formFieldSuccessText: "text-emerald-400",
                            formFieldErrorText: "text-red-400",
                        },
                    }}
                />
            </div>
        </div>
    );
}

