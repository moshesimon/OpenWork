import path from "node:path";
import { stat } from "node:fs/promises";
import { ApiError } from "@/lib/api-error";

const DEFAULT_WORKSPACE_FILES_ROOT = path.resolve(process.cwd(), "company_files");

const SUPPORTED_DOCUMENT_EXTENSIONS = new Set([
  ".pdf",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".xlsm",
  ".csv",
  ".ppt",
  ".pptx",
  ".pps",
  ".ppsx",
  ".txt",
  ".rtf",
  ".odt",
  ".ods",
  ".odp",
  ".md",
  ".json",
  ".yaml",
  ".yml",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".html",
  ".css",
]);

const EDITABLE_TEXT_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".csv",
  ".rtf",
  ".json",
  ".yaml",
  ".yml",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".html",
  ".css",
]);

const EXCLUDED_DIRECTORY_NAMES = new Set([
  ".git",
  ".next",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".turbo",
  ".cache",
]);

export const MAX_EDITABLE_FILE_BYTES = 512_000;

export function resolveWorkspaceRoot(): string {
  const configuredRoot = process.env.WORKSPACE_FILES_ROOT?.trim();
  if (!configuredRoot) {
    return DEFAULT_WORKSPACE_FILES_ROOT;
  }

  return path.resolve(
    path.isAbsolute(configuredRoot) ? configuredRoot : path.join(process.cwd(), configuredRoot),
  );
}

export const WORKSPACE_ROOT = resolveWorkspaceRoot();

export function isSupportedDocumentFile(name: string): boolean {
  const extension = path.extname(name).toLowerCase();
  return SUPPORTED_DOCUMENT_EXTENSIONS.has(extension);
}

export function isEditableTextDocumentFile(name: string): boolean {
  const extension = path.extname(name).toLowerCase();
  return EDITABLE_TEXT_EXTENSIONS.has(extension);
}

export function contentTypeFromExtension(extension: string): string {
  const normalized = extension.toLowerCase();

  if (normalized === ".pdf") {
    return "application/pdf";
  }

  if (normalized === ".doc") {
    return "application/msword";
  }

  if (normalized === ".docx") {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }

  if (normalized === ".xls") {
    return "application/vnd.ms-excel";
  }

  if (normalized === ".xlsx") {
    return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  }

  if (normalized === ".ppt") {
    return "application/vnd.ms-powerpoint";
  }

  if (normalized === ".pptx") {
    return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  }

  if (normalized === ".csv") {
    return "text/csv; charset=utf-8";
  }

  if (normalized === ".txt" || normalized === ".md") {
    return "text/plain; charset=utf-8";
  }

  if (normalized === ".json") {
    return "application/json; charset=utf-8";
  }

  if (normalized === ".yaml" || normalized === ".yml") {
    return "application/yaml; charset=utf-8";
  }

  if (normalized === ".ts" || normalized === ".tsx" || normalized === ".js" || normalized === ".jsx") {
    return "text/plain; charset=utf-8";
  }

  if (normalized === ".html") {
    return "text/html; charset=utf-8";
  }

  if (normalized === ".css") {
    return "text/css; charset=utf-8";
  }

  if (normalized === ".png") {
    return "image/png";
  }

  if (normalized === ".jpg" || normalized === ".jpeg") {
    return "image/jpeg";
  }

  if (normalized === ".gif") {
    return "image/gif";
  }

  if (normalized === ".webp") {
    return "image/webp";
  }

  if (normalized === ".svg") {
    return "image/svg+xml";
  }

  return "application/octet-stream";
}

export function shouldIncludeDirectory(name: string): boolean {
  const normalized = name.toLowerCase();
  if (normalized.startsWith(".")) {
    return false;
  }

  return !EXCLUDED_DIRECTORY_NAMES.has(normalized);
}

export function normalizeWorkspaceRelativePath(rawPath: string): string {
  const trimmed = rawPath.trim().replaceAll("\\", "/");

  if (!trimmed) {
    return "";
  }

  if (trimmed.includes("\0")) {
    throw new ApiError(400, "INVALID_PATH", "Path contains unsupported characters.");
  }

  const withoutLeadingSlash = trimmed.replace(/^\/+/, "");
  const normalized = path.posix.normalize(withoutLeadingSlash);

  if (normalized === "." || normalized === "") {
    return "";
  }

  if (normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new ApiError(400, "INVALID_PATH", "Path must stay within the workspace root.");
  }

  return normalized;
}

export function resolveWorkspacePath(relativePath: string): string {
  const resolved = path.resolve(WORKSPACE_ROOT, relativePath);
  const isInsideWorkspace =
    resolved === WORKSPACE_ROOT || resolved.startsWith(`${WORKSPACE_ROOT}${path.sep}`);

  if (!isInsideWorkspace) {
    throw new ApiError(400, "INVALID_PATH", "Path must stay within the workspace root.");
  }

  return resolved;
}

export async function readWorkspaceFileInfo(relativePath: string): Promise<{
  absolutePath: string;
  name: string;
  extension: string;
  contentType: string;
  editable: boolean;
  sizeBytes: number;
  updatedAt: Date;
  version: string;
}> {
  const normalizedPath = normalizeWorkspaceRelativePath(relativePath);
  if (!normalizedPath) {
    throw new ApiError(400, "INVALID_PATH", "A file path is required.");
  }

  const absolutePath = resolveWorkspacePath(normalizedPath);
  const fileStats = await stat(absolutePath);
  if (!fileStats.isFile()) {
    throw new ApiError(400, "INVALID_FILE", "Requested path is not a file.");
  }

  const name = path.basename(normalizedPath);
  const extension = path.extname(name).toLowerCase();
  return {
    absolutePath,
    name,
    extension,
    contentType: contentTypeFromExtension(extension),
    editable: isEditableTextDocumentFile(name),
    sizeBytes: fileStats.size,
    updatedAt: fileStats.mtime,
    version: String(fileStats.mtimeMs),
  };
}
