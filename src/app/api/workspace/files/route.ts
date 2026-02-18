import path from "node:path";
import { readdir, stat } from "node:fs/promises";
import { NextRequest, NextResponse } from "next/server";
import { ApiError, errorResponse } from "@/lib/api-error";
import { requireUserIdHeader } from "@/lib/request";
import {
  normalizeWorkspaceRelativePath,
  resolveWorkspacePath,
  shouldIncludeDirectory,
  isSupportedDocumentFile,
  WORKSPACE_ROOT,
} from "@/server/workspace-files";
import type { WorkspaceFileEntry } from "@/types/agent";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    requireUserIdHeader(request);

    const url = new URL(request.url);
    const relativeDirectory = normalizeWorkspaceRelativePath(url.searchParams.get("path") ?? "");
    const targetDirectory = resolveWorkspacePath(relativeDirectory);

    const directoryStat = await stat(targetDirectory);
    if (!directoryStat.isDirectory()) {
      throw new ApiError(400, "INVALID_DIRECTORY", "Requested path is not a directory.");
    }

    const entries = await readdir(targetDirectory, { withFileTypes: true });
    const items: WorkspaceFileEntry[] = entries
      .filter((entry) => {
        if (entry.isDirectory()) {
          return shouldIncludeDirectory(entry.name);
        }

        return entry.isFile() && isSupportedDocumentFile(entry.name) && !entry.name.startsWith("~$");
      })
      .map((entry) => {
        const kind: WorkspaceFileEntry["kind"] = entry.isDirectory() ? "directory" : "file";
        return {
          name: entry.name,
          path: relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name,
          kind,
        };
      })
      .sort((left, right) => {
        if (left.kind !== right.kind) {
          return left.kind === "directory" ? -1 : 1;
        }

        return left.name.localeCompare(right.name, undefined, {
          sensitivity: "base",
          numeric: true,
        });
      });

    return NextResponse.json({
      rootLabel: path.basename(WORKSPACE_ROOT).replace(/[_-]+/g, " ").trim() || "Company Files",
      directory: relativeDirectory,
      items,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
