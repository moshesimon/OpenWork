import { readFile, stat, writeFile } from "node:fs/promises";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ApiError, errorResponse } from "@/lib/api-error";
import { parseJsonBody, requireUserIdHeader } from "@/lib/request";
import {
  MAX_EDITABLE_FILE_BYTES,
  normalizeWorkspaceRelativePath,
  readWorkspaceFileInfo,
} from "@/server/workspace-files";
import type {
  WorkspaceDocumentReadResponse,
  WorkspaceDocumentSaveResponse,
} from "@/types/agent";

export const runtime = "nodejs";

const documentSaveSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
  baseVersion: z.string().optional(),
});

function asIso(value: Date): string {
  return value.toISOString();
}

export async function GET(request: NextRequest) {
  try {
    requireUserIdHeader(request);

    const relativePath = normalizeWorkspaceRelativePath(request.nextUrl.searchParams.get("path") ?? "");
    const fileInfo = await readWorkspaceFileInfo(relativePath);

    if (!fileInfo.editable) {
      const response: WorkspaceDocumentReadResponse = {
        path: relativePath,
        name: fileInfo.name,
        extension: fileInfo.extension,
        editable: false,
        content: null,
        sizeBytes: fileInfo.sizeBytes,
        updatedAt: asIso(fileInfo.updatedAt),
        version: fileInfo.version,
        message:
          "This format requires a Univer adapter (or converter) before AI can edit it directly.",
      };
      return NextResponse.json(response);
    }

    if (fileInfo.sizeBytes > MAX_EDITABLE_FILE_BYTES) {
      throw new ApiError(
        413,
        "FILE_TOO_LARGE",
        `File is too large for direct editing. Limit is ${MAX_EDITABLE_FILE_BYTES} bytes.`,
      );
    }

    const content = await readFile(fileInfo.absolutePath, "utf8");
    const response: WorkspaceDocumentReadResponse = {
      path: relativePath,
      name: fileInfo.name,
      extension: fileInfo.extension,
      editable: true,
      content,
      sizeBytes: fileInfo.sizeBytes,
      updatedAt: asIso(fileInfo.updatedAt),
      version: fileInfo.version,
      message: null,
    };
    return NextResponse.json(response);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PUT(request: NextRequest) {
  try {
    requireUserIdHeader(request);

    const body = documentSaveSchema.parse(await parseJsonBody<unknown>(request));
    const relativePath = normalizeWorkspaceRelativePath(body.path);
    const fileInfo = await readWorkspaceFileInfo(relativePath);

    if (!fileInfo.editable) {
      throw new ApiError(
        400,
        "FILE_NOT_EDITABLE",
        "This file type is not editable through the current text adapter.",
      );
    }

    const contentBytes = Buffer.byteLength(body.content, "utf8");
    if (contentBytes > MAX_EDITABLE_FILE_BYTES) {
      throw new ApiError(
        413,
        "FILE_TOO_LARGE",
        `Edited content exceeds ${MAX_EDITABLE_FILE_BYTES} bytes.`,
      );
    }

    if (body.baseVersion && body.baseVersion !== fileInfo.version) {
      throw new ApiError(
        409,
        "FILE_VERSION_CONFLICT",
        "The file changed on disk. Reload before saving your changes.",
      );
    }

    await writeFile(fileInfo.absolutePath, body.content, "utf8");
    const nextStats = await stat(fileInfo.absolutePath);

    const response: WorkspaceDocumentSaveResponse = {
      path: relativePath,
      sizeBytes: nextStats.size,
      updatedAt: asIso(nextStats.mtime),
      version: String(nextStats.mtimeMs),
    };

    return NextResponse.json(response);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return errorResponse(
        new ApiError(400, "INVALID_BODY", error.issues[0]?.message ?? "Invalid request body."),
      );
    }
    return errorResponse(error);
  }
}
