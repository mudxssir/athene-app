"use client";

/**
 * Athene Design-Kit — shared atomic components + TCard transition system
 *
 * Exports:
 *   IconTile       — sienna-tinted square icon container
 *   Chip           — badge/tag in 5 colour variants
 *   MetricCard     — stat card with tone + hover shadow
 *   TCard          — transition wrapper; reads TransitionCtx for enter/exit animation
 *   TransitionCtx  — React context { phase, type } consumed by TCard
 *   TRANSITION_FOR — route-prefix → transition-type map
 *
 * Usage:
 *   import { IconTile, Chip, TCard, TransitionCtx, TRANSITION_FOR } from "@/components/ui/kit";
 */

import React, {
  createContext,
  useContext,
  useMemo,
  type CSSProperties,
  type ReactNode,
  type ElementType,
} from "react";

// ─── NavigateCtx — intercepted router.push for exit animations ───────────────
// TransitionProvider fills this with a function that plays exit animation
// before calling router.push. Sidebar/nav consumers call useNavigate() instead
// of router.push so the old page can animate out before it unmounts.

export const NavigateCtx = createContext<(href: string) => void>(() => {});

/** Drop-in for router.push that plays exit animation first. */
export function useNavigate(): (href: string) => void {
  return useContext(NavigateCtx);
}

// ─── Types ────────────────────────────────────────────────────────────────────

export type Tone = "primary" | "amber" | "honey" | "success" | "warn";
export type ChipKind = "primary" | "amber" | "honey" | "outline" | "success";
export type TransitionType = "cascade" | "converge" | "loop" | "fold" | "diverge";
export type TransitionPhase = "idle" | "exiting" | "entering";

export interface TransitionState {
  phase: TransitionPhase;
  type: TransitionType;
}

// ─── TransitionCtx ────────────────────────────────────────────────────────────

export const TransitionCtx = createContext<TransitionState>({
  phase: "idle",
  type: "cascade",
});

// ─── ROUTE_CONFIG — single source of truth for route → animation + stamp ─────
//
// Both TRANSITION_FOR (used by TCard) and PAGE_STAMPS (used by Header) are
// derived from this map, so adding a route only requires editing one place.

interface RouteConfig { transition: TransitionType; stamp: string; }

export const ROUTE_CONFIG: Record<string, RouteConfig> = {
  "/dashboard":          { transition: "cascade",  stamp: "Command Center · Real-time" },
  "/chat":               { transition: "converge", stamp: "Synthesis · Grounded · Cited" },
  "/graph":              { transition: "loop",     stamp: "768-dimensional · 4-hop traversal" },
  "/briefing":           { transition: "fold",     stamp: "Daily · Role-shaped · Quiet" },
  "/admin/integrations": { transition: "diverge",  stamp: "60+ available · Connected" },
  "/insights":           { transition: "cascade",  stamp: "BI · Cross-departmental" },
  "/decisions":          { transition: "cascade",  stamp: "Decisions · Reviewed · Logged" },
  "/files":              { transition: "cascade",  stamp: "Assets · Indexed · Searchable" },
  "/builder":            { transition: "cascade",  stamp: "Agent Lab · Experimental" },
  "/admin":              { transition: "cascade",  stamp: "Admin Control · Org-wide" },
};

/** route prefix → transition type (longest prefix wins). */
export function transitionFor(pathname: string): TransitionType {
  const match = Object.keys(ROUTE_CONFIG)
    .filter((k) => pathname === k || pathname.startsWith(k + "/"))
    .sort((a, b) => b.length - a.length)[0];
  return match ? ROUTE_CONFIG[match].transition : "cascade";
}

/** route prefix → header eyebrow stamp (longest prefix wins). */
export function stampFor(pathname: string): string | null {
  const match = Object.keys(ROUTE_CONFIG)
    .filter((k) => pathname === k || pathname.startsWith(k + "/"))
    .sort((a, b) => b.length - a.length)[0];
  return match ? ROUTE_CONFIG[match].stamp : null;
}

/** @deprecated use ROUTE_CONFIG directly. Kept for backwards-compat. */
export const TRANSITION_FOR: Record<string, TransitionType> = Object.fromEntries(
  Object.entries(ROUTE_CONFIG).map(([k, v]) => [k, v.transition])
);

// ─── Radial calc (golden-ratio deterministic spread for converge/diverge) ────

function radialFor(i: number) {
  const ang = ((i * 137.5) % 360) * (Math.PI / 180);
  const radius = 520 + ((i * 91) % 200);
  return {
    x: Math.cos(ang) * radius,
    y: Math.sin(ang) * radius,
    r: ((i * 53) % 60) - 30,
  };
}

// ─── TCard ────────────────────────────────────────────────────────────────────

const STAGGER: Record<TransitionType, number> = {
  cascade:  65,
  converge: 55,
  loop:     70,
  fold:     55,
  diverge:  50,
};

interface TCardProps {
  i?: number;
  total?: number;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  as?: ElementType;
  onClick?: () => void;
  kind?: string;
}

export function TCard({
  i = 0,
  total = 1,
  children,
  className = "",
  style,
  as: As = "div",
  onClick,
  kind,
}: TCardProps) {
  const t = useContext(TransitionCtx);
  const rad = useMemo(() => radialFor(i), [i]);

  let stateClass = "";
  let delay = 0;

  if (t.phase === "exiting") {
    stateClass = `exit-${t.type}`;
    delay = i * 18;
  } else if (t.phase === "entering") {
    stateClass = `enter-${t.type}`;
    delay = i * STAGGER[t.type];
  }

  const mergedStyle: CSSProperties & Record<string, unknown> = {
    ...style,
    "--rad-x": `${rad.x}px`,
    "--rad-y": `${rad.y}px`,
    "--rad-r": `${rad.r}deg`,
    animationDelay: `${delay}ms`,
  };

  return (
    <As
      className={`tcard ${stateClass} ${className}`.trim()}
      style={mergedStyle}
      onClick={onClick}
      data-kind={kind}
    >
      {children}
    </As>
  );
}

// ─── IconTile ─────────────────────────────────────────────────────────────────

const TONE_STYLES: Record<Tone, { bg: string; border: string; color: string }> = {
  primary: {
    bg:     "rgba(160,74,27,0.10)",
    border: "rgba(160,74,27,0.20)",
    color:  "var(--primary)",
  },
  amber: {
    bg:     "rgba(217,122,46,0.12)",
    border: "rgba(217,122,46,0.22)",
    color:  "var(--secondary)",
  },
  honey: {
    bg:     "rgba(230,185,40,0.18)",
    border: "rgba(230,185,40,0.32)",
    color:  "var(--honey-600)",
  },
  success: {
    bg:     "rgba(79,122,46,0.12)",
    border: "rgba(79,122,46,0.25)",
    color:  "#4F7A2E",
  },
  warn: {
    bg:     "rgba(178,58,26,0.10)",
    border: "rgba(178,58,26,0.25)",
    color:  "var(--danger)",
  },
};

interface IconTileProps {
  icon?: ElementType;
  size?: number;
  tone?: Tone;
  children?: ReactNode;
  style?: CSSProperties;
  className?: string;
}

export function IconTile({
  icon: Icon,
  size = 44,
  tone = "primary",
  children,
  style,
  className = "",
}: IconTileProps) {
  const t = TONE_STYLES[tone];
  return (
    <div
      className={className}
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.32),
        background: t.bg,
        border: `1px solid ${t.border}`,
        color: t.color,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        ...style,
      }}
    >
      {Icon ? <Icon size={Math.round(size * 0.5)} strokeWidth={1.7} /> : children}
    </div>
  );
}

// ─── Chip ─────────────────────────────────────────────────────────────────────

const CHIP_STYLES: Record<ChipKind, CSSProperties> = {
  primary: { background: "rgba(160,74,27,0.10)", color: "var(--primary)",    border: "1px solid rgba(160,74,27,0.22)" },
  amber:   { background: "rgba(217,122,46,0.12)", color: "var(--secondary)", border: "1px solid rgba(217,122,46,0.22)" },
  honey:   { background: "rgba(230,185,40,0.18)", color: "var(--honey-600)",          border: "1px solid rgba(230,185,40,0.32)" },
  outline: { background: "transparent",           color: "var(--fg-muted)",  border: "1px solid var(--border-strong)" },
  success: { background: "rgba(79,122,46,0.12)",  color: "#4F7A2E",          border: "1px solid rgba(79,122,46,0.25)" },
};

interface ChipProps {
  kind?: ChipKind;
  dot?: boolean;
  children: ReactNode;
  style?: CSSProperties;
  className?: string;
}

export function Chip({
  kind = "outline",
  dot,
  children,
  style,
  className = "",
}: ChipProps) {
  return (
    <span
      className={className}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        height: 24,
        padding: "0 12px",
        borderRadius: 999,
        fontFamily: "var(--font-sans)",
        fontWeight: 800,
        fontSize: 9,
        letterSpacing: "0.3em",
        textTransform: "uppercase",
        whiteSpace: "nowrap",
        ...CHIP_STYLES[kind],
        ...style,
      }}
    >
      {dot && (
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: 99,
            background: "currentColor",
            flexShrink: 0,
          }}
        />
      )}
      {children}
    </span>
  );
}

// ─── MetricCard ───────────────────────────────────────────────────────────────

interface MetricCardProps {
  icon: ElementType;
  label: string;
  value: string;
  tone?: Tone;
  status?: string;
  onClick?: () => void;
}

export function MetricCard({
  icon: Icon,
  label,
  value,
  tone = "primary",
  status,
  onClick,
}: MetricCardProps) {
  const chipKind: ChipKind =
    tone === "primary" ? "primary" :
    tone === "amber"   ? "amber"   :
    tone === "success" ? "success" :
    tone === "honey"   ? "honey"   : "outline";

  return (
    <div
      onClick={onClick}
      className="group"
      style={{
        background: "var(--bg-elevated)",
        border: "1px solid var(--border)",
        borderRadius: 22,
        padding: 22,
        transition: "all .25s var(--ease-out)",
        cursor: onClick ? "pointer" : "default",
      }}
      onMouseEnter={(e) => {
        const el = e.currentTarget as HTMLDivElement;
        el.style.boxShadow = "var(--shadow-3)";
        el.style.borderColor = "var(--border-strong)";
      }}
      onMouseLeave={(e) => {
        const el = e.currentTarget as HTMLDivElement;
        el.style.boxShadow = "";
        el.style.borderColor = "var(--border)";
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          marginBottom: 16,
        }}
      >
        <IconTile icon={Icon} size={42} tone={tone} />
        {status && <Chip kind={chipKind}>{status}</Chip>}
      </div>
      <div
        style={{
          fontSize: 10,
          fontWeight: 800,
          letterSpacing: "0.32em",
          textTransform: "uppercase",
          color: "var(--fg-muted)",
          marginBottom: 6,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontFamily: "var(--font-sans)",
          fontSize: 36,
          fontWeight: 800,
          letterSpacing: "-0.04em",
          color: "var(--fg)",
          lineHeight: 1,
        }}
      >
        {value}
      </div>
    </div>
  );
}
