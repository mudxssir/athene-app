import { NextRequest, NextResponse } from "next/server";
import { headers } from "next/headers";
import { getContextFromHeaders } from "@/lib/supabase/rls-client";
import { supabaseAdmin } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";
import { rateLimit } from "@/lib/redis/client";
import { parseDocument } from "@/lib/integrations/microsoft/document-parser";
import { indexDocument } from "@/lib/integrations/indexing";
import { classifyFileLayer } from "@/lib/files/classify-layer";

/**
 * Allowlist of safe file extensions and their canonical content-types.
 *
 * Security rationale:
 * - Prevents upload of executables, scripts, and other dangerous file types.
 * - Content-type is derived from this map (NOT from the client-supplied file.type)
 *   to prevent MIME-sniffing attacks and stored-XSS via crafted Content-Type headers.
 * - HTML/HTM are accepted but stored as text/plain so browsers cannot execute them.
 */
const ALLOWED_EXTENSIONS: Record<string, string> = {
  // Office documents
  pdf:  "application/pdf",
  doc:  "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls:  "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt:  "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  // Plain text / structured data
  txt:  "text/plain",
  csv:  "text/csv",
  tsv:  "text/tab-separated-values",
  md:   "text/markdown",
  json: "application/json",
  xml:  "application/xml",
  // HTML coerced to text/plain — prevents stored XSS via storage CDN
  html: "text/plain",
  htm:  "text/plain",
};

/**
 * POST /api/files/upload
 *
 * Accepts a multipart/form-data request with a single "file" field.
 * 1. Validates file extension against the ALLOWED_EXTENSIONS allowlist.
 * 2. Resolves the internal Supabase org UUID from the Clerk org ID.
 * 3. Uploads the file to Supabase Storage (`documents` bucket).
 * 4. Ensures a "direct_upload" connection row exists for the org.
 * 5. Inserts a metadata row into the `documents` table.
 * 6. Extracts text from the buffer and indexes it immediately (embedding + graph).
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

  // --- File-type validation (Gap 1) ---
  // Extract extension from the original filename BEFORE sanitization so the
  // dot-split logic is reliable (e.g. "report.tar.gz" → "gz").
  const rawExt = (file.name.split(".").pop() ?? "").toLowerCase();
  const safeContentType = ALLOWED_EXTENSIONS[rawExt];
  if (!safeContentType) {
    return NextResponse.json(
      { error: `File type ".${rawExt}" is not allowed. Supported types: ${Object.keys(ALLOWED_EXTENSIONS).join(", ")}` },
      { status: 415 },
    );
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
      return NextResponse.json({ error: "File upload failed" }, { status: 500 });
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
        // Gap 2 fix: use the allowlist-derived content-type, never the client-supplied
        // file.type. This prevents MIME-sniffing and stored-XSS via crafted uploads.
        contentType: safeContentType,
        upsert: false,
      });

    if (storageError) {
      logger.error({ err: storageError.message }, "[files/upload] Storage error");
      // Gap 3b fix: return a generic message; internal storage details are logged only.
      return NextResponse.json({ error: "File upload failed" }, { status: 500 });
    }

    // --- 3. Insert document metadata ---
    // rawExt was already validated against ALLOWED_EXTENSIONS above; reuse it.
    const ext = rawExt.toUpperCase() || "FILE";
    const sizeMB = file.size / (1024 * 1024);
    const sizeStr =
      sizeMB >= 1
        ? `${sizeMB.toFixed(1)} MB`
        : `${(file.size / 1024).toFixed(0)} KB`;

    const layer = classifyFileLayer(file.name, ext);

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
        // Gap 2 fix (continued): use allowlist-derived content-type for the DB record too.
        mime_type: safeContentType,
        metadata: { size: sizeStr, type: ext, uploaded_by: ownerId, layer },
      })
      .select("id, title, mime_type, metadata, created_at")
      .single();

    if (docErr || !doc) {
      logger.error({ err: docErr?.message ?? String(docErr) }, "[files/upload] Document error");
      // Gap 3c fix: return a generic message; DB error details are logged only.
      return NextResponse.json({ error: "File upload failed" }, { status: 500 });
    }

    // --- 4. Extract text and index immediately ------------------
    // Runs fire-and-forget so the 200 response is not blocked by extraction.
    // A 5-minute timeout guards against runaway serverless lifetimes on very
    // large documents. If indexing times out or throws, the document stays in
    // "Indexing" status and the error is logged for alerting.
    const INDEXING_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
    let timedOut = false;
    const timeoutId = setTimeout(() => {
      timedOut = true;
      logger.error({ docId: doc.id, name: file.name }, "[files/upload] Background indexing timed out after 5 min");
    }, INDEXING_TIMEOUT_MS);

    (async () => {
      try {
        const text = await parseDocument(file.name, buffer);
        if (timedOut) return; // abort after timeout — don't attempt to write stale data
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
          if (timedOut) return;
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
      } finally {
        clearTimeout(timeoutId);
      }
    })();

    // Gap 4 fix: storagePath removed from response — it embeds the internal org UUID
    // and Supabase storage key, neither of which the client needs.
    return NextResponse.json({
      id: doc.id,
      name: file.name,
      type: ext,
      size: sizeStr,
      status: "Indexing",
      risk: "Low",
      layer,
      date: "Just now",
    });
  } catch (err: any) {
    logger.error({ err: err?.message ?? String(err) }, "[files/upload] Unexpected error");
    return NextResponse.json({ error: "File upload failed" }, { status: 500 });
  }
}
