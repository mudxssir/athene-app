"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";

/**
 * PageTransition — wraps page content with cube-roll or card-spin-out
 * animations on route change.
 *
 * Cube roll  → 3D Y-axis flip, like a cube face turning
 * Card spin  → Cards fly in from above (X-axis) and land in place
 */

const SPIN_ROUTES = new Set(["/chat", "/briefing", "/insights"]);

export function PageTransition({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const prevPath = useRef<string | null>(null);
  const [animClass, setAnimClass] = useState("");

  useEffect(() => {
    if (prevPath.current !== null && prevPath.current !== pathname) {
      const cls = SPIN_ROUTES.has(pathname) ? "page-spin-in" : "page-cube-in";
      setAnimClass(cls);
      // Clear after animation finishes so it can re-trigger next nav
      const t = setTimeout(() => setAnimClass(""), 700);
      return () => clearTimeout(t);
    }
    prevPath.current = pathname;
  }, [pathname]);

  return (
    <div
      className={`h-full w-full overflow-y-auto custom-scrollbar ${animClass}`}
      style={{ willChange: animClass ? "transform, opacity" : "auto" }}
    >
      {children}
    </div>
  );
}
