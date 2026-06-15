#!/usr/bin/env node
// ============================================================
// scripts/check-licenses.mjs — dependency license gate (P7-3)
//
// Fails CI when a production dependency carries a license outside the
// permissive allow-list, unless the package is explicitly allow-listed in
// scripts/license-allowlist.txt with a justification.
//
// Why: the program ships an OSS-heavy pipeline (Docling, Chonkie, Talon,
// GLiNER, graspologic, TEI/nomic) and a Python sidecar image. A copyleft
// (GPL/AGPL/LGPL) or unknown-license dependency creeping into the product is a
// compliance risk that must surface in review, not in legal later.
//
// Mirrors check-rls.mjs: a scan + an explicit allow-list file. Reads license
// strings from each prod dependency's installed package.json.
//
// Scope: DIRECT production dependencies only (package.json `dependencies`), not the
// transitive tree. Transitive/deep-license scanning + the Python sidecar image scan
// are separate ops (documented in P7_TRACKER) — this gate catches the first-order
// risk that review can act on.
//
// Exit 0 → every prod dep is permissive or explicitly allow-listed.
// Exit 1 → one or more deps have a non-permissive / unknown license.
// ============================================================

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()

// SPDX ids we accept without an allow-list entry (permissive / public-domain).
const ALLOWED_LICENSES = new Set([
  'MIT', 'Apache-2.0', 'ISC', '0BSD',
  'BSD-2-Clause', 'BSD-3-Clause',
  'Unlicense', 'CC0-1.0', 'Python-2.0', 'BlueOak-1.0.0',
  'MPL-2.0', // weak copyleft, file-level — acceptable for a dependency we don't modify
])

// Per-package overrides: dep name → reason. Use for packages whose package.json
// license field is non-SPDX ("SEE LICENSE IN …") or "UNKNOWN" but whose actual
// license has been manually verified as permissive.
const ALLOWLIST_PATH = 'scripts/license-allowlist.txt'

function loadAllowlist() {
  const map = new Map()
  const path = join(ROOT, ALLOWLIST_PATH)
  if (!existsSync(path)) return map
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    // format: <package-name>  # reason
    const [name, ...rest] = t.split(/\s+#\s*/)
    map.set(name.trim(), (rest.join(' # ') || 'allow-listed').trim())
  }
  return map
}

function licenseOf(depDir) {
  try {
    const pj = JSON.parse(readFileSync(join(depDir, 'package.json'), 'utf8'))
    if (typeof pj.license === 'string') return pj.license
    if (pj.license && typeof pj.license.type === 'string') return pj.license.type
    if (Array.isArray(pj.licenses) && pj.licenses[0]?.type) return pj.licenses[0].type
    return 'UNKNOWN'
  } catch {
    return 'NOT-FOUND'
  }
}

const allowlist = loadAllowlist()
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const deps = Object.keys(pkg.dependencies ?? {})

const violations = []
let scanned = 0
let allowlisted = 0

for (const dep of deps) {
  const lic = licenseOf(join(ROOT, 'node_modules', dep))
  scanned++
  if (ALLOWED_LICENSES.has(lic)) continue
  if (allowlist.has(dep)) { allowlisted++; continue }
  violations.push(`${dep}: "${lic}" — not permissive and not in ${ALLOWLIST_PATH}`)
}

if (violations.length > 0) {
  console.error('License check failed (P7-3):\n')
  for (const v of violations) console.error(`  ✗ ${v}`)
  console.error(
    `\nAllowed without entry: ${[...ALLOWED_LICENSES].join(', ')}.\n` +
    `If a flagged dependency is genuinely permissive (verify its LICENSE file),\n` +
    `add "<package>  # <reason>" to ${ALLOWLIST_PATH}.`,
  )
  process.exit(1)
}

console.log(
  `License check passed: ${scanned} prod deps — ` +
  `${scanned - allowlisted} permissive, ${allowlisted} explicitly allow-listed.`,
)
