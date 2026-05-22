import { NextRequest, NextResponse } from "next/server";
import { headers } from "next/headers";
import { getContextFromHeaders } from "@/lib/supabase/rls-client";
import { supabaseAdmin } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";
import { rateLimit } from "@/lib/redis/client";
import { parseDocument } from "@/lib/integrations/microsoft/document-parser";
import { indexDocument } from "@/lib/integrations/indexing";

/**
 * POST /api/files/upload
 *
 * Accepts a multipart/form-data request with a single "file" field.
 * 1. Resolves the internal Supabase org UUID from the Clerk org ID.
 * 2. Uploads the file to Supabase Storage (`documents` bucket).
 * 3. Ensures a "direct_upload" connection row exists for the org.
 * 4. Inserts a metadata row into the `documents` table.
 * 5. Extracts text from the buffer and indexes it immediately (embedding + graph).
 *
 * Returns the created document record.
 */
export async function POST(req: NextRequest) {
  const context = getContextFromHeaders(await headers());
  if (!context?.org_id || !context?.user_id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { allowed } = await rateLimit(`upload:${context.user_id}`, 20, 3600);
  if (!allowed) {
    return NextResponse.json({ error: "Rate limited — try again later" }, { status: 429 });
  }

  const formData = await req.formData();
  const file = formData.get("file") as File | null;
  if (!file) {
    return NextResponse.json({ error: "No file provided" }, { status: 400 });
  }

  if (file.size > 50 * 1024 * 1024) {
    return NextResponse.json({ error: "File too large (max 50 MB)" }, { status: 413 });
  }

  // context.user_id is already the internal Supabase UUID (resolved by middleware)
  const userId = context.user_id;

  try {
    // --- 1. Resolve org + ensure connection in a single DB transaction ---
    const { data: uploadCtx, error: ctxErr } = await supabaseAdmin.rpc(
      "ensure_upload_connection",
      { p_clerk_org_id: context.org_id }
    );

    if (ctxErr || !uploadCtx) {
      logger.error({ err: ctxErr?.message ?? String(ctxErr) }, "[files/upload] RPC ensure_upload_connection failed");
      return NextResponse.json(
        { error: `Context resolution failed: ${ctxErr?.message || "Unknown error"}` },
        { status: 500 },
      );
    }

    const orgId = uploadCtx.org_id as string;
    const connId = uploadCtx.connection_id as string;

    // Verify the member UUID actually exists in org_members (may be stale from cache)
    let ownerId: string | null = userId;
    const { data: memberCheck } = await supabaseAdmin
      .from("org_members")
      .select("id")
      .eq("id", userId)
      .limit(1)
      .maybeSingle();

    if (!memberCheck) {
      // Stale user_id — try to find by org instead
      const { data: orgMember } = await supabaseAdmin
        .from("org_members")
        .select("id")
        .eq("org_id", orgId)
        .limit(1)
        .maybeSingle();
      ownerId = orgMember?.id ?? null;
    }

    // --- 2. Upload to Supabase Storage ---
    // Sanitize filename: strip path traversal characters and any character that
    // is not alphanumeric, hyphen, underscore, period, or space.
    // This prevents directory traversal (../../../etc/passwd) and storage key injection.
    const safeName = file.name
      .replace(/[/\\]/g, '_')        // path separators → underscore
      .replace(/\.\./g, '_')         // parent directory traversal
      .replace(/[^\w.\- ]/g, '_')    // non-safe chars → underscore
      .slice(0, 255);                // cap total length
    const storagePath = `${orgId}/${Date.now()}_${safeName}`;
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const { error: storageError } = await supabaseAdmin.storage
      .from("documents")
      .upload(storagePath, buffer, {
        contentType: file.type || "application/octet-stream",
        upsert: false,
      });

    if (storageError) {
      logger.error({ err: storageError.message }, "[files/upload] Storage error");
      return NextResponse.json(
        { error: `Storage upload failed: ${storageError.message}` },
        { status: 500 },
      );
    }

    // --- 3. Insert document metadata ---
    const ext = file.name.split(".").pop()?.toUpperCase() || "FILE";
    const sizeMB = file.size / (1024 * 1024);
    const sizeStr =
      sizeMB >= 1
        ? `${sizeMB.toFixed(1)} MB`
        : `${(file.size / 1024).toFixed(0)} KB`;

    const nameLower = file.name.toLowerCase();
    let layer = 'Internal Wiki';
    if (nameLower.includes('invoice') || nameLower.includes('financial') || nameLower.includes('tax') || ext === 'XLSX' || ext === 'CSV') {
      layer = 'Financial Records';
    } else if (nameLower.includes('contract') || nameLower.includes('legal') || nameLower.includes('nda') || nameLower.includes('agreement')) {
      layer = 'Legal Discovery';
    } else if (nameLower.includes('audit') || nameLower.includes('log')) {
      layer = 'Audit Logs';
    }

    const { data: doc, error: docErr } = await supabaseAdmin
     .from("documents")
     .insert({
        org_id: orgId,
        connection_id: connId,
        external_id: storagePath,
        title: file.name,
        source_type: "direct_upload",
        owner_user_id: null,
        visibility: "restricted",
        mime_type: file.type || "application/octet-stream",
        metadata: { size: sizeStr, type: ext, uploaded_by: ownerId, layer },
      })
      .select("id, title, mime_type, metadata, created_at")
      .single();

    if (docErr || !doc) {
      logger.error({ err: docErr?.message ?? String(docErr) }, "[files/upload] Document error");
      return NextResponse.json(
        { error: `Document insert failed: ${docErr?.message}` },
        { status: 500 },
      );
    }

    // --- 4. Extract text and index immediately ------------------
    // Run asynchronously so the response returns quickly; UI polls status.
    // We intentionally do NOT await — a slow extraction (large PDF) should not
    // block the 200 response that confirms the file was stored successfully.
    (async () => {
      try {
        const text = await parseDocument(file.name, buffer);
        if (text && text.trim().length > 0) {
          await indexDocument(
            {
              chunk_id: storagePath,
              title: file.name,
              content: text,
              source_url: storagePath,
              metadata: {
                provider: "direct_upload",
                resource_type: ext.toLowerCase(),
                author: ownerId ?? undefined,
              },
            },
            orgId,
            connId,
            null,        // departmentId — unrestricted within org
            "restricted",
            ownerId,
          );
          // Mark document as indexed in the DB
          await supabaseAdmin
            .from("documents")
            .update({ last_indexed_at: new Date().toISOString() })
            .eq("id", doc.id);
          logger.info({ docId: doc.id, name: file.name }, "[files/upload] Indexing complete");
        } else {
          logger.warn({ docId: doc.id, name: file.name }, "[files/upload] No extractable text — skipping indexing");
        }
      } catch (indexErr: any) {
        logger.error({ docId: doc.id, name: file.name, err: indexErr?.message }, "[files/upload] Background indexing failed");
      }
    })();

    return NextResponse.json({
      id: doc.id,
      name: file.name,
      type: ext,
      size: sizeStr,
      status: "Indexing",
      risk: "Low",
      layer,
      date: "Just now",
      storagePath,
    });
  } catch (err: any) {
    logger.error({ err: err?.message ?? String(err) }, "[files/upload] Unexpected error");
    return NextResponse.json({ error: "File upload failed" }, { status: 500 });
  }
}
