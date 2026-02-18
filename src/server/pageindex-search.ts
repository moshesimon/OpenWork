import path from "node:path";
import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { ApiError } from "@/lib/api-error";
import { extractSearchSnippet, scoreTextMatch } from "@/server/global-search";
import {
  isEditableTextDocumentFile,
  resolveWorkspacePath,
  shouldIncludeDirectory,
} from "@/server/workspace-files";

const DEFAULT_LIMIT = 40;
const MAX_LIMIT = 100;
const MIN_QUERY_LENGTH = 2;
const MAX_QUERY_LENGTH = 180;

const MAX_FILE_SCAN_DIRECTORIES = 300;
const MAX_FILE_SCAN_RESULTS = 240;
const MAX_FILE_CONTENT_READS = 80;
const MAX_FILE_CONTENT_BYTES = 280_000;

export type PageIndexSearchInput = {
  query: string;
  limit?: number;
};

export type PageIndexSearchResult = {
  id: string;
  filePath: string;
  title: string;
  subtitle: string;
  snippet: string | null;
  score: number;
};

export type PageIndexSearchResponse = {
  query: string;
  total: number;
  tookMs: number;
  results: PageIndexSearchResult[];
};

function parseSearchLimit(rawLimit: number | undefined): number {
  if (!Number.isFinite(rawLimit)) {
    return DEFAULT_LIMIT;
  }

  return Math.max(1, Math.min(Math.floor(rawLimit ?? DEFAULT_LIMIT), MAX_LIMIT));
}

function parseSearchQuery(rawQuery: string): string {
  const query = rawQuery.trim();
  if (!query) {
    throw new ApiError(400, "INVALID_QUERY", "Search query is required.");
  }

  if (query.length < MIN_QUERY_LENGTH) {
    throw new ApiError(
      400,
      "INVALID_QUERY",
      `Search query must be at least ${MIN_QUERY_LENGTH} characters.`,
    );
  }

  return query.slice(0, MAX_QUERY_LENGTH);
}

function sortResults(results: PageIndexSearchResult[]): PageIndexSearchResult[] {
  return results.sort((left, right) => {
    if (left.score !== right.score) {
      return right.score - left.score;
    }

    return left.filePath.localeCompare(right.filePath);
  });
}

export async function searchPageIndex(
  input: PageIndexSearchInput,
): Promise<PageIndexSearchResponse> {
  const startedAt = Date.now();
  const query = parseSearchQuery(input.query);
  const limit = parseSearchLimit(input.limit);
  const needleLower = query.toLowerCase();

  const queue: string[] = [""];
  const visited = new Set<string>();
  const results: PageIndexSearchResult[] = [];
  let contentReads = 0;

  while (queue.length > 0 && visited.size < MAX_FILE_SCAN_DIRECTORIES) {
    const directory = queue.shift();
    if (directory === undefined || visited.has(directory)) {
      continue;
    }

    visited.add(directory);

    let entries: Dirent<string>[];
    try {
      entries = await readdir(resolveWorkspacePath(directory), {
        withFileTypes: true,
        encoding: "utf8",
      });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (shouldIncludeDirectory(entry.name)) {
          queue.push(directory ? `${directory}/${entry.name}` : entry.name);
        }
        continue;
      }

      if (!entry.isFile() || entry.name.startsWith(".") || entry.name.startsWith("~$")) {
        continue;
      }

      const relativePath = directory ? `${directory}/${entry.name}` : entry.name;
      const pathScore = Math.max(
        scoreTextMatch(relativePath, needleLower),
        scoreTextMatch(entry.name, needleLower),
      );

      let contentScore = 0;
      let snippet: string | null = null;

      if (pathScore === 0 && isEditableTextDocumentFile(entry.name) && contentReads < MAX_FILE_CONTENT_READS) {
        try {
          const absolutePath = resolveWorkspacePath(relativePath);
          const fileStats = await stat(absolutePath);
          if (fileStats.isFile() && fileStats.size <= MAX_FILE_CONTENT_BYTES) {
            const content = await readFile(absolutePath, "utf8");
            contentReads += 1;
            contentScore = scoreTextMatch(content, needleLower);
            if (contentScore > 0) {
              snippet = extractSearchSnippet(content, needleLower);
            }
          }
        } catch {
          // Skip unreadable file.
        }
      }

      if (pathScore === 0 && contentScore === 0) {
        continue;
      }

      const fileName = path.basename(relativePath);
      results.push({
        id: relativePath,
        filePath: relativePath,
        title: fileName,
        subtitle: relativePath,
        snippet,
        score: Math.max(pathScore + 40, contentScore + 16),
      });

      if (results.length >= MAX_FILE_SCAN_RESULTS) {
        break;
      }
    }

    if (results.length >= MAX_FILE_SCAN_RESULTS) {
      break;
    }
  }

  const sorted = sortResults(results).slice(0, limit);
  return {
    query,
    total: sorted.length,
    tookMs: Date.now() - startedAt,
    results: sorted,
  };
}
