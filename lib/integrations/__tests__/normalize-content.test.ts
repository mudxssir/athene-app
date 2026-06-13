// ============================================================
// lib/integrations/__tests__/normalize-content.test.ts
//
// P3 / audit D8 regression: normalizeContent must NOT corrupt code-like prose.
//
// Before P3, normalizeContent ran a global HTML-tag strip on ALL content, which
// turned `<Component>`, `<T>`, and `WHERE a < b` into spaces across every shape.
// The fix removes the global strip (HTML sanitization now lives in the per-shape
// converters) and makes the residual whitespace/entity normalization skip fenced
// code blocks so indentation-significant code survives byte-identical.
//
// supabase/embedding/qstash are mocked only to let the module load — these tests
// exercise the pure normalizeContent function exclusively.
// ============================================================

import { describe, it, expect, vi } from "vitest";

// ─── Load-only mocks (no behavior asserted) ──────────────────────────────────
vi.mock("@/lib/supabase/server", () => ({ supabaseAdmin: {} }));
vi.mock("@/lib/ai/embedding-factory", () => ({
  embedBatchDetailed: vi.fn(),
  embedBatchLateChunking: vi.fn(),
  embedBatchPinned: vi.fn(),
}));
vi.mock("@/lib/qstash/client", () => ({ qstash: { publishJSON: vi.fn() } }));
vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { normalizeContent } from "@/lib/integrations/indexing";

describe("D8 — normalizeContent no longer corrupts code-like prose", () => {
  it("preserves inline angle-bracket identifiers (was stripped as HTML tags)", () => {
    const input = "The <Component> wraps a generic <T> and renders <Foo />.";
    // No tag stripping: every angle-bracket token survives.
    expect(normalizeContent(input)).toBe(input);
  });

  it("preserves SQL comparison operators", () => {
    const input = "SELECT * FROM users WHERE age < 30 AND score > 90;";
    expect(normalizeContent(input)).toBe(input);
  });

  it("keeps a fenced code block byte-identical (indentation, operators, blank lines)", () => {
    const code = [
      "```python",
      "def f(x):",
      "    if x < 10:        # 4-space indent + comparison",
      "        return x",
      "",
      "    return  x * 2     # intentional double space",
      "```",
    ].join("\n");
    const input = `Here is the function:\n\n${code}\n\nIt doubles large inputs.`;
    const out = normalizeContent(input);
    // The fenced block must appear verbatim — no whitespace collapse inside it.
    expect(out).toContain(code);
  });

  it("does not decode HTML entities inside a fenced block", () => {
    const code = ["```", "if (a &amp;&amp; b) return a &lt; b;", "```"].join("\n");
    const out = normalizeContent(`Snippet:\n\n${code}`);
    // Entities inside the fence stay literal (code, not prose).
    expect(out).toContain("a &amp;&amp; b");
    expect(out).toContain("a &lt; b");
  });

  it("still decodes entities and collapses whitespace in prose (outside fences)", () => {
    const input = "Tom &amp; Jerry   went   to    the&nbsp;park.";
    expect(normalizeContent(input)).toBe("Tom & Jerry went to the park.");
  });

  it("collapses 3+ blank lines in prose but leaves prose angle brackets intact", () => {
    const input = "First paragraph mentions <Widget>.\n\n\n\nSecond paragraph.";
    expect(normalizeContent(input)).toBe(
      "First paragraph mentions <Widget>.\n\nSecond paragraph."
    );
  });

  it("mixed prose + code: prose normalized, fence preserved", () => {
    const code = ["```sql", "SELECT a,  b", "FROM   t", "WHERE a < b", "```"].join("\n");
    const input = `Query   uses &lt;:\n\n${code}\n\nThe   <T> generic   stays.`;
    const out = normalizeContent(input);
    // Prose double-spaces collapsed, &lt; decoded, <T> preserved
    expect(out).toContain("Query uses <:");
    expect(out).toContain("The <T> generic stays.");
    // Fence untouched: double space in "SELECT a,  b" and "FROM   t" preserved
    expect(out).toContain("SELECT a,  b");
    expect(out).toContain("FROM   t");
  });

  it("handles an unterminated fence as prose (graceful degradation, no throw)", () => {
    const input = "```\nunclosed code with <Tag> and  double space";
    // No closing fence → whole thing is prose; must not throw, <Tag> survives.
    const out = normalizeContent(input);
    expect(out).toContain("<Tag>");
  });
});
