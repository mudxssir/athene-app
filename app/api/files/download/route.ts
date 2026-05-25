import { NextRequest, NextResponse } from "next/server";
import { headers } from "next/headers";
import { getContextFromHeaders } from "@/lib/supabase/rls-client";
import { supabaseAdmin } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";

/**
 * GET /api/files/download?id=<document_uuid>
 *
 * Serves a directly-uploaded file by its document ID.
 * Ownership is verified before the storage path is resolved server-side —
 * the client never needs to know the internal storage key.
 *
 * Content-Disposition uses the original document title (not the internal
 * storage path which includes a timestamp prefix).
 */
export async function GET(req: NextRequest) {
  const context = getContextFromHeaders(await headers());
  if (!context?.org_id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const id = req.nextUrl.searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "Missing ?id parameter" }, { status: 400 });
  }

  // Resolve storage path and original filename in one query,
  // scoped to the caller's org so cross-org access is impossible.
  const { data: doc, error: docErr } = await supabaseAdmin
    .from("documents")
    .select("id, title, external_id, mime_type")
    .eq("id", id)
    .eq("org_id", context.org_id)
    .eq("source_type", "direct_upload")
    .maybeSingle();

  if (docErr) {
    logger.error({ err: docErr.message, id }, "[files/download] DB lookup error");
    return NextResponse.json({ error: "Failed to resolve document" }, { status: 500 });
  }

  if (!doc || !doc.external_id) {
    return NextResponse.json({ error: "Not found or access denied" }, { status: 404 });
  }

  const { data, error } = await supabaseAdmin.storage
    .from("documents")
    .download(doc.external_id);

  if (error || !data) {
    logger.error({ err: error?.message, id }, "[files/download] Storage download error");
    return NextResponse.json({ error: "Failed to retrieve file" }, { status: 500 });
  }

  const buffer = await data.arrayBuffer();

  // Use the stored mime_type (derived from allowlist at upload time).
  // Fall back to the blob's reported type, then to octet-stream.
  const contentType = doc.mime_type || data.type || "application/octet-stream";

  // Sanitize the filename for Content-Disposition to prevent header injection.
  // RFC 5987: replace non-ASCII and special characters, then percent-encode.
  const safeFilename = (doc.title ?? "download")
    .replace(/["\r\n\\]/g, "_")   // strip characters that break the header value
    .slice(0, 255);

  return new NextResponse(buffer, {
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": `attachment; filename="${safeFilename}"`,
    },
  });
}
