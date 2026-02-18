import path from "node:path";
import { readFile, stat, writeFile } from "node:fs/promises";
import { NextRequest, NextResponse } from "next/server";
import { ApiError, errorResponse } from "@/lib/api-error";
import { requireUserIdHeader } from "@/lib/request";
import { normalizeWorkspaceRelativePath, readWorkspaceFileInfo } from "@/server/workspace-files";
import type { WorkspaceDocumentSaveResponse } from "@/types/agent";

export const runtime = "nodejs";

const MAX_BINARY_FILE_BYTES = 20 * 1024 * 1024;

function asIso(value: Date): string {
  return value.toISOString();
}

function toInlineContentDisposition(fileName: string): string {
  const fallback = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `inline; filename="${fallback || "file"}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

export async function GET(request: NextRequest) {
  try {
    const headerUserId = request.headers.get("x-user-id")?.trim();
    const queryUserId = request.nextUrl.searchParams.get("userId")?.trim();
    if (!headerUserId && !queryUserId) {
      throw new ApiError(400, "MISSING_USER_HEADER", "x-user-id header or userId query is required.");
    }

    const relativePath = normalizeWorkspaceRelativePath(request.nextUrl.searchParams.get("path") ?? "");
    const fileInfo = await readWorkspaceFileInfo(relativePath);
    const data = await readFile(fileInfo.absolutePath);

    return new NextResponse(data, {
      headers: {
        "content-type": fileInfo.contentType,
        "content-length": String(data.byteLength),
        "cache-control": "no-store",
        "x-workspace-file-version": fileInfo.version,
        "content-disposition": toInlineContentDisposition(path.basename(fileInfo.name)),
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PUT(request: NextRequest) {
  try {
    requireUserIdHeader(request);

    const relativePath = normalizeWorkspaceRelativePath(request.nextUrl.searchParams.get("path") ?? "");
    const expectedBaseVersion = request.nextUrl.searchParams.get("baseVersion") ?? "";
    const fileInfo = await readWorkspaceFileInfo(relativePath);

    if (expectedBaseVersion && expectedBaseVersion !== fileInfo.version) {
      throw new ApiError(
        409,
        "FILE_VERSION_CONFLICT",
        "The file changed on disk. Reload before saving your changes.",
      );
    }

    const payload = Buffer.from(await request.arrayBuffer());
    if (payload.byteLength > MAX_BINARY_FILE_BYTES) {
      throw new ApiError(
        413,
        "FILE_TOO_LARGE",
        `File is too large for binary save mode. Limit is ${MAX_BINARY_FILE_BYTES} bytes.`,
      );
    }

    await writeFile(fileInfo.absolutePath, payload);
    const nextStats = await stat(fileInfo.absolutePath);

    const response: WorkspaceDocumentSaveResponse = {
      path: relativePath,
      sizeBytes: nextStats.size,
      updatedAt: asIso(nextStats.mtime),
      version: String(nextStats.mtimeMs),
    };

    return NextResponse.json(response);
  } catch (error) {
    return errorResponse(error);
  }
}
