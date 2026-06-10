#!/usr/bin/env node
// ============================================================
// scripts/check-rls.mjs — RLS consistency guard (REFOCUS §5.1)
//
// Fails CI when a file imports supabaseAdmin outside the explicit
// allowlist (scripts/rls-allowlist.txt). Scanned surfaces:
//   - lib/langgraph/tools/**
//   - lib/knowledge-graph/**
//   - app/api/**
//
// User-facing reads must go through withRLS(); service-role usage
// is reserved for background writes, workers, and admin jobs.
// ============================================================

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const SCAN_DIRS = ["lib/langgraph/tools", "lib/knowledge-graph", "app/api"];
const ALLOWLIST_PATH = "scripts/rls-allowlist.txt";

const allowlist = new Set(
  readFileSync(join(ROOT, ALLOWLIST_PATH), "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
);

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      yield* walk(full);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      yield full;
    }
  }
}

const violations = [];

for (const scanDir of SCAN_DIRS) {
  for (const file of walk(join(ROOT, scanDir))) {
    const rel = relative(ROOT, file);
    if (rel.includes("__tests__") || rel.endsWith(".test.ts")) continue;
    const content = readFileSync(file, "utf8");
    if (!/\bsupabaseAdmin\b/.test(content)) continue;
    if (allowlist.has(rel)) {
      if (rel.startsWith("lib/") && !content.includes("SERVICE-ROLE JUSTIFICATION")) {
        violations.push(`${rel}: allowlisted but missing "// SERVICE-ROLE JUSTIFICATION:" comment`);
      }
      continue;
    }
    violations.push(`${rel}: imports supabaseAdmin but is not in ${ALLOWLIST_PATH}`);
  }
}

if (violations.length > 0) {
  console.error("RLS check failed (REFOCUS §5.1):\n");
  for (const v of violations) console.error(`  ✗ ${v}`);
  console.error(
    "\nUser-facing reads must use withRLS() (lib/supabase/rls-client.ts)." +
      "\nIf service-role is genuinely required (background write, worker, admin job)," +
      "\nadd a SERVICE-ROLE JUSTIFICATION comment and append the path to the allowlist."
  );
  process.exit(1);
}

console.log("RLS check passed: no unaudited supabaseAdmin usage.");
