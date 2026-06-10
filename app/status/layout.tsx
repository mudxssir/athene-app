import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "System Status — Athene",
  description: "Real-time health of all Athene platform services.",
};

export default function StatusLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
