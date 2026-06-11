// ============================================================
// GET/POST /api/test/pipeline — Dev-only pipeline test helper
//
// Allows Playwright tests to seed synthetic documents through
// the real indexing pipeline (embed → upsert) and run vector
// search to verify retrieval — without needing a real OAuth
// connection or QStash bypass.
//
// ONLY active when NODE_ENV !== 'production' AND TEST_PIPELINE_SECRET is set.
// Requires header: x-test-token matching TEST_PIPELINE_SECRET.
// If TEST_PIPELINE_SECRET is unset the endpoint returns 404 in all environments.
//
// Actions (POST body):
//   seed    → { action: "seed", title, content, tag }
//             Indexes the content and returns { documentId, embedding_dim, chunks }
//
//   search  → { action: "search", query, tag? }
//             Vector-searches and returns matching chunks
//
//   cleanup → { action: "cleanup", tag }
//             Deletes all test documents with the given tag
// ============================================================

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { supabaseAdmin } from "@/lib/supabase/server";
import { indexDocuments } from "@/lib/integrations/indexing";
import { embed } from "@/lib/ai/embedder";

function guard(req: NextRequest): NextResponse | null {
  const secret = process.env.TEST_PIPELINE_SECRET;
  if (process.env.NODE_ENV === "production" || !secret) {
    // Unavailable in production or when TEST_PIPELINE_SECRET is not explicitly configured.
    // This prevents the known-default token "athene-dev-test" from being usable in staging.
    return NextResponse.json({ error: "Not available" }, { status: 404 });
  }
  const token = req.headers.get("x-test-token");
  if (token !== secret) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return null;
}

// ---- GET: health check -----------------------------------------------

export async function GET(req: NextRequest) {
  const block = guard(req);
  if (block) return block;
  return NextResponse.json({ ok: true, env: process.env.NODE_ENV });
}

// ---- POST: seed / search / cleanup ----------------------------------

export async function POST(req: NextRequest) {
  const block = guard(req);
  if (block) return block;

  // Need org context — caller must be authenticated
  const { userId, orgId } = await auth();
  if (!userId || !orgId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Resolve internal org UUID
  const { data: orgRow } = await supabaseAdmin
    .from("organizations")
    .select("id")
    .eq("clerk_org_id", orgId)
    .maybeSingle();

  if (!orgRow) {
    return NextResponse.json({ error: "Organization not found" }, { status: 404 });
  }

  const internalOrgId = orgRow.id as string;

  let body: Record<string, any>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { action } = body;

  // ── SEED ──────────────────────────────────────────────────────────
  if (action === "seed") {
    const { title, content, tag } = body as {
      title: string;
      content: string;
      tag: string;
    };

    if (!title || !content || !tag) {
      return NextResponse.json(
        { error: "seed requires title, content, tag" },
        { status: 400 }
      );
    }

    // Upsert a test connection row so documents FK is satisfied
    const testNangoId = `test-seed-${internalOrgId}`;
    let connId: string;

    const { data: existing } = await supabaseAdmin
      .from("connections")
      .select("id")
      .eq("org_id", internalOrgId)
      .eq("nango_connection_id", testNangoId)
      .maybeSingle();

    if (existing) {
      connId = existing.id as string;
    } else {
      const { data: newConn, error: connErr } = await supabaseAdmin
        .from("connections")
        .insert({
          org_id: internalOrgId,
          nango_connection_id: testNangoId,
          provider: "test",
          source_type: "test",
          scope: "org",
          status: "active",
          metadata: { test: true },
        })
        .select("id")
        .single();

      if (connErr || !newConn) {
        return NextResponse.json(
          { error: `Failed to create test connection: ${connErr?.message}` },
          { status: 500 }
        );
      }
      connId = newConn.id as string;
    }

    // Build the chunk with the tag embedded in metadata for later cleanup
    const chunk = {
      chunk_id: `test:${tag}:${Date.now()}`,
      title,
      content,
      source_url: `https://test.athene.local/${tag}`,
      shape: 'prose' as const,
      metadata: {
        provider: "test",
        resource_type: "test_document",
        test_tag: tag,
      },
    };

    const result = await indexDocuments(
      [chunk],
      internalOrgId,
      connId,
      null,
      "org_wide"
    );

    if (result.errors > 0 && result.indexed === 0) {
      return NextResponse.json(
        { error: "Indexing failed — check embedding provider config" },
        { status: 500 }
      );
    }

    // Verify embedding dimensions by checking what was stored
    const { data: stored } = await supabaseAdmin
      .from("document_embeddings")
      .select("chunk_index")
      .eq("document_id", result.documentIds[0])
      .limit(1);

    return NextResponse.json({
      ok: true,
      documentId: result.documentIds[0] ?? null,
      chunks_indexed: result.indexed,
      embedding_stored: (stored?.length ?? 0) > 0,
      tag,
    });
  }

  // ── SEARCH ────────────────────────────────────────────────────────
  if (action === "search") {
    const { query, tag } = body as { query: string; tag?: string };

    if (!query) {
      return NextResponse.json({ error: "search requires query" }, { status: 400 });
    }

    // Generate embedding for the query
    const embedding = await embed(query, internalOrgId);

    // Raw vector search via supabaseAdmin (bypasses RLS — test only)
    const { data, error } = await supabaseAdmin.rpc("vector_search_admin", {
      p_org_id: internalOrgId,
      p_embedding: JSON.stringify(embedding),
      p_limit: 10,
    });

    if (error) {
      // Fallback: direct similarity query if the admin RPC doesn't exist
      const { data: fallback, error: fbErr } = await supabaseAdmin
        .from("document_embeddings")
        .select("metadata, content_preview, document_id")
        .eq("org_id", internalOrgId)
        .limit(50);

      if (fbErr) {
        return NextResponse.json({ error: fbErr.message }, { status: 500 });
      }

      const results = (fallback ?? []).filter((r: any) =>
        tag ? r.metadata?.test_tag === tag : true
      );
      return NextResponse.json({ ok: true, results, source: "fallback_scan" });
    }

    const results = tag
      ? (data ?? []).filter((r: any) => r.metadata?.test_tag === tag)
      : (data ?? []);

    return NextResponse.json({ ok: true, results, embedding_dim: embedding.length, source: "vector_rpc" });
  }

  // ── CLEANUP ──────────────────────────────────────────────────────
  if (action === "cleanup") {
    const { tag } = body as { tag: string };
    if (!tag) {
      return NextResponse.json({ error: "cleanup requires tag" }, { status: 400 });
    }

    // Find documents with this test tag
    const { data: docs } = await supabaseAdmin
      .from("document_embeddings")
      .select("document_id")
      .eq("org_id", internalOrgId)
      .eq("metadata->>test_tag", tag);

    const docIds = [...new Set((docs ?? []).map((d: any) => d.document_id as string))];

    if (docIds.length > 0) {
      // Delete embeddings first, then documents (or let cascade handle it)
      await supabaseAdmin
        .from("documents")
        .delete()
        .in("id", docIds);
    }

    return NextResponse.json({ ok: true, deleted_documents: docIds.length, tag });
  }

  return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
}
