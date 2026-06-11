// P0-6 — chunk-text-store unit tests
import { describe, it, expect } from "vitest";
import {
  writeChunkText,
  readChunkText,
  hasFullChunkText,
} from "@/lib/indexing/chunk-text-store";

describe("chunk-text-store (P0-6)", () => {
  it("writeChunkText merges without mutating the base metadata", () => {
    const base = { provider: "notion", resource_type: "page" };
    const meta = writeChunkText(base, "full chunk body");
    expect(meta.chunk_text).toBe("full chunk body");
    expect(meta.provider).toBe("notion");
    expect((base as Record<string, unknown>).chunk_text).toBeUndefined();
  });

  it("readChunkText prefers stored chunk_text over preview", () => {
    const row = {
      metadata: { chunk_text: "  full text  " },
      content_preview: "preview",
    };
    expect(readChunkText(row)).toBe("full text");
    expect(hasFullChunkText(row)).toBe(true);
  });

  it("falls back to content_preview when chunk_text is absent or empty", () => {
    expect(readChunkText({ metadata: {}, content_preview: "preview" })).toBe("preview");
    expect(readChunkText({ metadata: { chunk_text: "   " }, content_preview: "p" })).toBe("p");
    expect(hasFullChunkText({ metadata: { chunk_text: "   " } })).toBe(false);
  });

  it("returns null when neither field is usable", () => {
    expect(readChunkText({})).toBeNull();
    expect(readChunkText({ metadata: null, content_preview: "  " })).toBeNull();
    expect(readChunkText({ metadata: "garbage" as unknown })).toBeNull();
  });
});
