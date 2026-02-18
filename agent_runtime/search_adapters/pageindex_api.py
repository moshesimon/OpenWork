from __future__ import annotations

import os
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Set

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from .common import (
    extract_search_snippet,
    parse_limit,
    parse_query,
    resolve_workspace_root,
    score_text_match,
)

app = FastAPI(title="OpenWork PageIndex Adapter", version="0.1.0")

MAX_FILE_SCAN_DIRECTORIES = 300
MAX_FILE_SCAN_RESULTS = 240
MAX_FILE_CONTENT_READS = 80
MAX_FILE_CONTENT_BYTES = 280_000

EXCLUDED_DIRECTORY_NAMES = {
    ".git",
    ".next",
    "node_modules",
    "dist",
    "build",
    "coverage",
    ".turbo",
    ".cache",
}

EDITABLE_TEXT_EXTENSIONS = {
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
}


class PageSearchRequest(BaseModel):
    query: str
    limit: Optional[int] = None


def _is_included_directory(name: str) -> bool:
    normalized = name.lower()
    if normalized.startswith("."):
        return False
    return normalized not in EXCLUDED_DIRECTORY_NAMES


def _is_editable_text_document(path_value: Path) -> bool:
    return path_value.suffix.lower() in EDITABLE_TEXT_EXTENSIONS


def _sort_results(results: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    return sorted(results, key=lambda item: (item["score"], item["filePath"]), reverse=True)


def _relative_file_path(root: Path, file_path: Path) -> str:
    return file_path.relative_to(root).as_posix()


@app.get("/health")
def health() -> Dict[str, str]:
    return {"status": "ok", "service": "pageindex-adapter"}


@app.post("/search")
def search(payload: PageSearchRequest) -> Dict[str, Any]:
    started_at = time.perf_counter()

    try:
        query = parse_query(payload.query)
    except ValueError as exc:
        raise HTTPException(
            status_code=400,
            detail={"errorCode": "INVALID_QUERY", "message": str(exc)},
        ) from exc

    limit = parse_limit(payload.limit)
    needle_lower = query.lower()

    workspace_root = resolve_workspace_root()
    if not workspace_root.exists() or not workspace_root.is_dir():
        raise HTTPException(
            status_code=503,
            detail={
                "errorCode": "WORKSPACE_ROOT_NOT_FOUND",
                "message": f"Workspace root directory not found: {workspace_root}",
            },
        )

    queue: List[Path] = [workspace_root]
    visited: Set[Path] = set()
    results: List[Dict[str, Any]] = []
    content_reads = 0

    while queue and len(visited) < MAX_FILE_SCAN_DIRECTORIES:
        directory = queue.pop(0)
        if directory in visited:
            continue

        visited.add(directory)

        try:
            entries = list(directory.iterdir())
        except OSError:
            continue

        for entry in entries:
            if entry.is_dir():
                if _is_included_directory(entry.name):
                    queue.append(entry)
                continue

            if not entry.is_file() or entry.name.startswith(".") or entry.name.startswith("~$"):
                continue

            relative_path = _relative_file_path(workspace_root, entry)
            path_score = max(
                score_text_match(relative_path, needle_lower),
                score_text_match(entry.name, needle_lower),
            )

            content_score = 0
            snippet = None

            if path_score == 0 and _is_editable_text_document(entry) and content_reads < MAX_FILE_CONTENT_READS:
                try:
                    file_size = entry.stat().st_size
                    if file_size <= MAX_FILE_CONTENT_BYTES:
                        content = entry.read_text(encoding="utf-8")
                        content_reads += 1
                        content_score = score_text_match(content, needle_lower)
                        if content_score > 0:
                            snippet = extract_search_snippet(content, needle_lower)
                except (OSError, UnicodeDecodeError):
                    pass

            if path_score == 0 and content_score == 0:
                continue

            results.append(
                {
                    "id": relative_path,
                    "filePath": relative_path,
                    "title": entry.name,
                    "subtitle": relative_path,
                    "snippet": snippet,
                    "score": max(path_score + 40, content_score + 16),
                }
            )

            if len(results) >= MAX_FILE_SCAN_RESULTS:
                break

        if len(results) >= MAX_FILE_SCAN_RESULTS:
            break

    merged = _sort_results(results)[:limit]

    return {
        "query": query,
        "total": len(merged),
        "tookMs": int((time.perf_counter() - started_at) * 1000),
        "workspaceRoot": os.fspath(workspace_root),
        "results": merged,
    }
