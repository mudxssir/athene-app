"use client";

/**
 * TransitionProvider — wires the TCard transition system into Next.js App Router.
 *
 * Two animation phases are supported:
 *   exit   — triggered by the navigate() function BEFORE router.push fires, so
 *             TCards on the departing page animate out while still mounted.
 *   enter  — triggered by usePathname() after the new page has mounted.
 *
 * Usage:
 *   const navigate = useNavigate();  // from @/components/ui/kit
 *   navigate("/chat");               // plays exit → push → enter automatically
 *
 * Direct browser back/forward still works via the usePathname effect (enter only).
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  NavigateCtx,
  TransitionCtx,
  transitionFor,
  type TransitionState,
} from "@/components/ui/kit";

interface TransitionProviderProps {
  children: ReactNode;
}

// Exit animation duration — long enough for the slowest exit (520ms loop exit)
const EXIT_DURATION = 480;
// Enter idle reset — worst case: 10 cards × 70ms stagger (loop) + 900ms anim
const ENTER_IDLE_DELAY = 1600;

export function TransitionProvider({ children }: TransitionProviderProps) {
  const pathname = usePathname();
  const router = useRouter();

  const prevPathRef = useRef<string>(pathname);
  const isAnimatingRef = useRef(false);
  const enterTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [transition, setTransition] = useState<TransitionState>({
    phase: "idle",
    type: transitionFor(pathname),
  });

  // ── navigate() — intercept all sidebar/nav clicks ─────────────────────────
  const navigate = useCallback(
    async (href: string) => {
      // Ignore if already animating or navigating to the current route
      if (isAnimatingRef.current || href === prevPathRef.current) return;
      isAnimatingRef.current = true;

      const exitType = transitionFor(prevPathRef.current);

      // Step 1: trigger exit animation on current (still-mounted) page
      setTransition({ phase: "exiting", type: exitType });

      // Step 2: wait for exit cards to finish
      await new Promise<void>((res) => setTimeout(res, EXIT_DURATION));

      // Step 3: push the new route — usePathname effect handles "entering"
      router.push(href);

      // Step 4: release lock after a tick so usePathname effect can run first
      setTimeout(() => {
        isAnimatingRef.current = false;
      }, 50);
    },
    [router]
  );

  // ── usePathname effect — handles enter (and browser back/forward) ─────────
  useEffect(() => {
    if (prevPathRef.current === pathname) return;
    prevPathRef.current = pathname;

    const type = transitionFor(pathname);

    if (enterTimerRef.current) clearTimeout(enterTimerRef.current);

    setTransition({ phase: "entering", type });

    enterTimerRef.current = setTimeout(() => {
      setTransition({ phase: "idle", type });
    }, ENTER_IDLE_DELAY);

    return () => {
      if (enterTimerRef.current) clearTimeout(enterTimerRef.current);
    };
  }, [pathname]);

  return (
    <NavigateCtx.Provider value={navigate}>
      <TransitionCtx.Provider value={transition}>
        {children}
      </TransitionCtx.Provider>
    </NavigateCtx.Provider>
  );
}
