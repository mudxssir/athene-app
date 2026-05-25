/**
 * lib/files/classify-layer.ts
 *
 * Single source of truth for mapping a file name + extension to an
 * Intelligence Layer. Previously duplicated in:
 *   - app/(dashboard)/files/page.tsx (handleFileSelected)
 *   - app/api/files/route.ts         (GET normaliser)
 *   - app/api/files/upload/route.ts  (POST metadata insert)
 */

export type IntelligenceLayer =
  | "Financial Records"
  | "Legal Discovery"
  | "Audit Logs"
  | "Internal Wiki";

/**
 * Classify a file into an Intelligence Layer based on its name and extension.
 * Falls back to "Internal Wiki" when no keyword matches.
 *
 * @param name - Original filename (case-insensitive match applied internally)
 * @param ext  - File extension in any case (e.g. "PDF", "xlsx", "CSV")
 */
export function classifyFileLayer(name: string, ext: string): IntelligenceLayer {
  const lower = name.toLowerCase();
  const upperExt = ext.toUpperCase();

  if (
    lower.includes("invoice") ||
    lower.includes("financial") ||
    lower.includes("tax") ||
    upperExt === "XLSX" ||
    upperExt === "XLS" ||  // legacy Excel format — intentionally added vs. original duplicated logic
    upperExt === "CSV"
  ) {
    return "Financial Records";
  }

  if (
    lower.includes("contract") ||
    lower.includes("legal") ||
    lower.includes("nda") ||
    lower.includes("agreement")
  ) {
    return "Legal Discovery";
  }

  if (lower.includes("audit") || lower.includes("log")) {
    return "Audit Logs";
  }

  return "Internal Wiki";
}
