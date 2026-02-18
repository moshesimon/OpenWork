from __future__ import annotations

import base64
import hashlib
import json
import logging
import os
import time
import zipfile
from pathlib import Path
from threading import Event, Lock, Thread
from typing import Any, Dict, List, Literal, Optional, Set, Tuple
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
from xml.etree import ElementTree

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from .common import (
    extract_search_snippet,
    parse_limit,
    parse_query,
    resolve_workspace_root,
    score_text_match,
)

app = FastAPI(title="OpenWork OfficeIndex Adapter", version="0.2.0")

MAX_SCAN_DIRECTORIES = 400
MAX_INDEXED_FILES = 2_000
MAX_BINARY_FILE_BYTES = 16_000_000
MAX_XML_MEMBER_BYTES = 3_000_000
MAX_EXTRACTED_TEXT_CHARS = 160_000
MAX_DIAGNOSTIC_MESSAGES = 50
HASH_CHUNK_BYTES = 1_048_576

DEFAULT_REFRESH_INTERVAL_SECONDS = 25
DEFAULT_HTTP_TIMEOUT_SECONDS = 8

OFFICE_FILE_EXTENSIONS = {".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx"}
OOXML_EXTENSIONS = {".docx", ".pptx", ".xlsx"}

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

RefreshMode = Literal["full", "incremental"]

logger = logging.getLogger("openwork.officeindex")


class OfficeSearchRequest(BaseModel):
    query: str
    limit: Optional[int] = None


class OfficeReindexRequest(BaseModel):
    mode: Optional[str] = None


_index_lock = Lock()
_refresh_lock = Lock()
_index_by_path: Dict[str, Dict[str, Any]] = {}
_last_indexed_at: float = 0.0
_last_refresh_mode: str = "none"
_last_refresh_summary: Dict[str, Any] = {}
_last_refresh_error: Optional[str] = None

_background_stop = Event()
_background_thread: Optional[Thread] = None


def _refresh_interval_seconds() -> int:
    raw = (os.getenv("OFFICEINDEX_REFRESH_INTERVAL_SECONDS") or "").strip()
    if not raw:
        return DEFAULT_REFRESH_INTERVAL_SECONDS

    try:
        return max(0, int(raw))
    except ValueError:
        return DEFAULT_REFRESH_INTERVAL_SECONDS


def _background_sync_seconds() -> int:
    raw = (os.getenv("OFFICEINDEX_BACKGROUND_SYNC_SECONDS") or "").strip()
    if not raw:
        return 0

    try:
        return max(0, int(raw))
    except ValueError:
        return 0


def _extract_timeout_seconds() -> int:
    raw = (os.getenv("OFFICEINDEX_EXTRACT_TIMEOUT_SECONDS") or "").strip()
    if not raw:
        return DEFAULT_HTTP_TIMEOUT_SECONDS

    try:
        return max(1, int(raw))
    except ValueError:
        return DEFAULT_HTTP_TIMEOUT_SECONDS


def _include_pdf_files() -> bool:
    raw = (os.getenv("OFFICEINDEX_INCLUDE_PDF") or "").strip().lower()
    return raw in {"1", "true", "yes", "on"}


def _parse_reindex_mode(raw_mode: Optional[str], default: RefreshMode) -> RefreshMode:
    value = (raw_mode or "").strip().lower()
    if not value:
        return default

    if value not in {"full", "incremental"}:
        raise ValueError("mode must be one of: full, incremental")

    return value  # type: ignore[return-value]


def _append_diagnostic(diagnostics: List[str], message: str) -> None:
    if len(diagnostics) < MAX_DIAGNOSTIC_MESSAGES:
        diagnostics.append(message)


def _sort_results(results: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    return sorted(results, key=lambda item: (item["score"], item["filePath"]), reverse=True)


def _normalize_whitespace(value: str) -> str:
    return " ".join((value or "").split())


def _relative_file_path(root: Path, file_path: Path) -> Optional[str]:
    try:
        return file_path.relative_to(root).as_posix()
    except ValueError:
        return None


def _is_included_directory(name: str) -> bool:
    normalized = name.lower()
    if normalized.startswith("."):
        return False
    return normalized not in EXCLUDED_DIRECTORY_NAMES


def _is_office_candidate(path_value: Path) -> bool:
    extension = path_value.suffix.lower()
    if extension in OFFICE_FILE_EXTENSIONS:
        return True
    return extension == ".pdf" and _include_pdf_files()


def _extract_text_from_xml(xml_bytes: bytes) -> str:
    try:
        root = ElementTree.fromstring(xml_bytes)
    except ElementTree.ParseError:
        return ""

    chunks: List[str] = []
    for node in root.iter():
        text = (node.text or "").strip()
        if not text:
            continue

        tag_name = node.tag.rsplit("}", 1)[-1].lower()
        if tag_name in {"t", "v", "p", "a:t", "is", "si"} or len(text) > 2:
            chunks.append(text)

    return " ".join(chunks)


def _extract_ooxml_text(file_path: Path) -> str:
    extension = file_path.suffix.lower()
    if extension not in OOXML_EXTENSIONS:
        return ""

    if extension == ".docx":
        prefixes = ("word/",)
    elif extension == ".pptx":
        prefixes = ("ppt/",)
    else:
        prefixes = ("xl/",)

    parts: List[str] = []
    char_budget = 0
    try:
        with zipfile.ZipFile(file_path, "r") as archive:
            for member in archive.namelist():
                lower_member = member.lower()
                if not lower_member.endswith(".xml"):
                    continue
                if not any(lower_member.startswith(prefix) for prefix in prefixes):
                    continue

                info = archive.getinfo(member)
                if info.file_size > MAX_XML_MEMBER_BYTES:
                    continue

                xml_bytes = archive.read(member)
                xml_text = _extract_text_from_xml(xml_bytes)
                if xml_text:
                    parts.append(xml_text)
                    char_budget += len(xml_text)

                if char_budget > MAX_EXTRACTED_TEXT_CHARS:
                    break
    except (OSError, zipfile.BadZipFile, KeyError):
        return ""

    extracted = " ".join(parts)
    if len(extracted) > MAX_EXTRACTED_TEXT_CHARS:
        return extracted[:MAX_EXTRACTED_TEXT_CHARS]
    return extracted


def _opensearch_base_url() -> Optional[str]:
    configured = (os.getenv("OFFICEINDEX_OPENSEARCH_URL") or "").strip()
    if not configured:
        return None
    return configured.rstrip("/")


def _opensearch_pipeline_name() -> str:
    configured = (os.getenv("OFFICEINDEX_OPENSEARCH_PIPELINE") or "").strip()
    if not configured:
        return "attachment"
    return configured


def _opensearch_auth_header() -> Optional[str]:
    username = (os.getenv("OFFICEINDEX_OPENSEARCH_USERNAME") or "").strip()
    password = os.getenv("OFFICEINDEX_OPENSEARCH_PASSWORD")
    if not username or password is None:
        return None

    token = base64.b64encode(f"{username}:{password}".encode("utf-8")).decode("ascii")
    return f"Basic {token}"


def _extract_with_opensearch(file_path: Path) -> Tuple[str, Dict[str, Any]]:
    base_url = _opensearch_base_url()
    if not base_url:
        return "", {"extractor": "opensearch-disabled"}

    try:
        raw_bytes = file_path.read_bytes()
    except OSError:
        return "", {"extractor": "opensearch-error", "reason": "read-failed"}

    if len(raw_bytes) > MAX_BINARY_FILE_BYTES:
        return "", {"extractor": "opensearch-skipped", "reason": "file-too-large"}

    endpoint = f"{base_url}/_ingest/pipeline/{_opensearch_pipeline_name()}/_simulate"
    payload = {
        "docs": [
            {
                "_source": {
                    "data": base64.b64encode(raw_bytes).decode("ascii"),
                    "resource_name": file_path.name,
                }
            }
        ]
    }

    headers = {"Content-Type": "application/json"}
    auth_header = _opensearch_auth_header()
    if auth_header:
        headers["Authorization"] = auth_header

    request = Request(
        endpoint,
        data=json.dumps(payload).encode("utf-8"),
        headers=headers,
        method="POST",
    )

    try:
        with urlopen(request, timeout=_extract_timeout_seconds()) as response:
            body = response.read().decode("utf-8")
    except (HTTPError, URLError, TimeoutError):
        return "", {"extractor": "opensearch-error", "reason": "request-failed"}

    try:
        decoded = json.loads(body)
    except json.JSONDecodeError:
        return "", {"extractor": "opensearch-error", "reason": "invalid-json"}

    docs = decoded.get("docs")
    if not isinstance(docs, list) or not docs:
        return "", {"extractor": "opensearch-error", "reason": "missing-docs"}

    first = docs[0]
    if not isinstance(first, dict):
        return "", {"extractor": "opensearch-error", "reason": "invalid-doc"}

    source = first.get("doc", {}).get("_source", {})
    attachment = source.get("attachment", {})
    if not isinstance(attachment, dict):
        return "", {"extractor": "opensearch-error", "reason": "missing-attachment"}

    content = attachment.get("content")
    if not isinstance(content, str):
        return "", {"extractor": "opensearch-empty"}

    if len(content) > MAX_EXTRACTED_TEXT_CHARS:
        content = content[:MAX_EXTRACTED_TEXT_CHARS]

    return content, {"extractor": "opensearch", "pipeline": _opensearch_pipeline_name()}


def _extract_text_for_file(file_path: Path) -> Tuple[str, Dict[str, Any]]:
    stats = file_path.stat()
    if stats.st_size > MAX_BINARY_FILE_BYTES:
        return "", {"extractor": "path-only", "reason": "file-too-large"}

    opensearch_text, opensearch_meta = _extract_with_opensearch(file_path)
    if opensearch_text:
        return opensearch_text, opensearch_meta

    extension = file_path.suffix.lower()
    if extension in OOXML_EXTENSIONS:
        local_text = _extract_ooxml_text(file_path)
        if local_text:
            return local_text, {"extractor": "local-ooxml"}

    if extension in {".doc", ".ppt", ".xls"}:
        return "", {"extractor": "path-only", "reason": "legacy-binary"}

    if extension == ".pdf":
        return "", {"extractor": "path-only", "reason": "pdf-disabled-by-default"}

    return "", opensearch_meta


def _compute_ranked_match(
    *,
    file_path: str,
    title: str,
    content: str,
    needle_lower: str,
) -> Optional[Dict[str, Any]]:
    normalized_content = _normalize_whitespace(content).lower()
    normalized_needle = _normalize_whitespace(needle_lower).lower()
    stem_lower = Path(title or file_path).stem.lower()

    path_score = max(
        score_text_match(file_path, normalized_needle),
        score_text_match(title, normalized_needle),
        score_text_match(stem_lower, normalized_needle),
    )

    filename_exact = stem_lower == normalized_needle
    content_exact_phrase = False
    content_partial = False

    if normalized_content:
        if normalized_content == normalized_needle:
            content_exact_phrase = True
        elif f" {normalized_needle} " in f" {normalized_content} ":
            content_exact_phrase = True
        elif score_text_match(normalized_content, normalized_needle) > 0:
            content_partial = True

    if filename_exact:
        return {
            "score": 3_000 + max(path_score, 1),
            "matchKind": "filename-exact",
            "snippet": extract_search_snippet(content, normalized_needle) if content_exact_phrase or content_partial else None,
        }

    if content_exact_phrase:
        exact_phrase_base = score_text_match(normalized_content, normalized_needle)
        return {
            "score": 2_000 + max(exact_phrase_base, 1),
            "matchKind": "content-exact-phrase",
            "snippet": extract_search_snippet(content, normalized_needle),
        }

    if content_partial:
        partial_base = score_text_match(normalized_content, normalized_needle)
        return {
            "score": 1_000 + max(partial_base, 1),
            "matchKind": "content-partial",
            "snippet": extract_search_snippet(content, normalized_needle),
        }

    if path_score > 0:
        return {
            "score": 800 + path_score,
            "matchKind": "filename-partial",
            "snippet": None,
        }

    return None


def _compute_file_hash(file_path: Path) -> str:
    digest = hashlib.sha256()
    with file_path.open("rb") as handle:
        while True:
            chunk = handle.read(HASH_CHUNK_BYTES)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def _scan_workspace_files(workspace_root: Path) -> Tuple[List[Path], List[str]]:
    queue: List[Path] = [workspace_root]
    visited: Set[Path] = set()
    candidates: List[Path] = []
    diagnostics: List[str] = []

    while queue and len(visited) < MAX_SCAN_DIRECTORIES and len(candidates) < MAX_INDEXED_FILES:
        directory = queue.pop(0)
        if directory in visited:
            continue

        visited.add(directory)

        try:
            entries = sorted(directory.iterdir(), key=lambda entry: entry.name.lower())
        except OSError as exc:
            relative_dir = _relative_file_path(workspace_root, directory) or "."
            logger.warning("Skipping unreadable directory during office indexing: %s (%s)", relative_dir, exc)
            _append_diagnostic(diagnostics, f"directory-unreadable:{relative_dir}")
            continue

        for entry in entries:
            if entry.is_dir():
                if _is_included_directory(entry.name):
                    queue.append(entry)
                continue

            if not entry.is_file() or entry.name.startswith(".") or entry.name.startswith("~$"):
                continue
            if not _is_office_candidate(entry):
                continue

            candidates.append(entry)
            if len(candidates) >= MAX_INDEXED_FILES:
                break

    return candidates, diagnostics


def _finalize_refresh_state(
    mode: RefreshMode,
    updated_index: Dict[str, Dict[str, Any]],
    summary: Dict[str, Any],
    error: Optional[str] = None,
) -> None:
    global _last_indexed_at
    global _last_refresh_mode
    global _last_refresh_summary
    global _last_refresh_error

    with _index_lock:
        _index_by_path.clear()
        _index_by_path.update(updated_index)
        _last_indexed_at = time.time()
        _last_refresh_mode = mode
        _last_refresh_summary = dict(summary)
        _last_refresh_error = error


def _refresh_index(mode: RefreshMode, bypass_interval: bool) -> Dict[str, Any]:
    with _refresh_lock:
        started_at = time.perf_counter()
        now = time.time()
        diagnostics: List[str] = []

        with _index_lock:
            current_size = len(_index_by_path)
            previous = dict(_index_by_path)
            should_skip = (
                mode == "incremental"
                and not bypass_interval
                and _last_indexed_at > 0
                and (now - _last_indexed_at) < _refresh_interval_seconds()
            )

        if should_skip:
            return {
                "status": "skipped",
                "mode": mode,
                "reason": "refresh-interval",
                "indexedFiles": current_size,
                "scannedFiles": 0,
                "reusedFiles": 0,
                "updatedFiles": 0,
                "removedFiles": 0,
                "failedFiles": 0,
                "diagnostics": [],
                "tookMs": int((time.perf_counter() - started_at) * 1000),
            }

        workspace_root = resolve_workspace_root()
        if not workspace_root.exists() or not workspace_root.is_dir():
            message = f"Workspace root directory not found: {workspace_root}"
            with _index_lock:
                # Keep old index intact and mark degraded state.
                global _last_refresh_error
                _last_refresh_error = message
            raise FileNotFoundError(message)

        scanned_paths, scan_diagnostics = _scan_workspace_files(workspace_root)
        for warning in scan_diagnostics:
            _append_diagnostic(diagnostics, warning)

        updated: Dict[str, Dict[str, Any]] = {}
        reused_files = 0
        updated_files = 0
        failed_files = 0

        for absolute_path in scanned_paths:
            relative_path = _relative_file_path(workspace_root, absolute_path)
            if not relative_path:
                continue

            try:
                stats = absolute_path.stat()
            except OSError as exc:
                logger.warning("Skipping file with unreadable stat: %s (%s)", relative_path, exc)
                failed_files += 1
                _append_diagnostic(diagnostics, f"file-stat-failed:{relative_path}")
                continue

            existing = previous.get(relative_path)
            if (
                mode == "incremental"
                and existing
                and existing.get("mtimeNs") == stats.st_mtime_ns
                and existing.get("sizeBytes") == stats.st_size
            ):
                updated[relative_path] = existing
                reused_files += 1
                continue

            try:
                content_hash = _compute_file_hash(absolute_path)
            except OSError as exc:
                logger.warning("Skipping unreadable file during hash pass: %s (%s)", relative_path, exc)
                failed_files += 1
                _append_diagnostic(diagnostics, f"file-hash-failed:{relative_path}")
                continue

            if (
                mode == "incremental"
                and existing
                and existing.get("contentHash") == content_hash
            ):
                reused = dict(existing)
                reused["mtimeNs"] = stats.st_mtime_ns
                reused["sizeBytes"] = stats.st_size
                updated[relative_path] = reused
                reused_files += 1
                continue

            try:
                content, source_meta = _extract_text_for_file(absolute_path)
            except OSError as exc:
                logger.warning("Skipping unreadable file during extraction: %s (%s)", relative_path, exc)
                failed_files += 1
                _append_diagnostic(diagnostics, f"file-extract-failed:{relative_path}")
                continue

            updated[relative_path] = {
                "filePath": relative_path,
                "title": absolute_path.name,
                "subtitle": relative_path,
                "content": content,
                "sourceMeta": source_meta,
                "mtimeNs": stats.st_mtime_ns,
                "sizeBytes": stats.st_size,
                "contentHash": content_hash,
            }
            updated_files += 1

        removed_files = max(0, len(previous) - len(updated))
        summary = {
            "status": "ok",
            "mode": mode,
            "indexedFiles": len(updated),
            "scannedFiles": len(scanned_paths),
            "reusedFiles": reused_files,
            "updatedFiles": updated_files,
            "removedFiles": removed_files,
            "failedFiles": failed_files,
            "diagnostics": diagnostics,
            "tookMs": int((time.perf_counter() - started_at) * 1000),
        }
        _finalize_refresh_state(mode=mode, updated_index=updated, summary=summary, error=None)
        return summary


def _search_index(query: str, limit: int) -> List[Dict[str, Any]]:
    needle_lower = query.lower()
    with _index_lock:
        docs = list(_index_by_path.values())

    results: List[Dict[str, Any]] = []
    for doc in docs:
        file_path = doc.get("filePath") or ""
        title = doc.get("title") or file_path
        content = doc.get("content") or ""

        ranked = _compute_ranked_match(
            file_path=file_path,
            title=title,
            content=content,
            needle_lower=needle_lower,
        )
        if not ranked:
            continue

        source_meta = dict(doc.get("sourceMeta") or {})
        source_meta["matchKind"] = ranked["matchKind"]
        results.append(
            {
                "id": file_path,
                "filePath": file_path,
                "title": title,
                "subtitle": doc.get("subtitle") or file_path,
                "snippet": ranked["snippet"],
                "score": ranked["score"],
                "sourceMeta": source_meta or {"extractor": "unknown"},
            }
        )

    return _sort_results(results)[:limit]


def _background_loop(interval_seconds: int) -> None:
    while not _background_stop.wait(interval_seconds):
        try:
            summary = _refresh_index(mode="incremental", bypass_interval=True)
            if summary.get("status") == "ok":
                logger.info(
                    "OfficeIndex background refresh complete (indexed=%s, updated=%s, failed=%s).",
                    summary.get("indexedFiles"),
                    summary.get("updatedFiles"),
                    summary.get("failedFiles"),
                )
        except Exception:
            logger.exception("OfficeIndex background refresh failed.")


@app.on_event("startup")
def _start_background_sync() -> None:
    interval_seconds = _background_sync_seconds()
    if interval_seconds <= 0:
        return

    global _background_thread
    if _background_thread and _background_thread.is_alive():
        return

    _background_stop.clear()
    _background_thread = Thread(
        target=_background_loop,
        args=(interval_seconds,),
        daemon=True,
        name="officeindex-background-sync",
    )
    _background_thread.start()
    logger.info("OfficeIndex background sync enabled (interval=%ss).", interval_seconds)


@app.on_event("shutdown")
def _stop_background_sync() -> None:
    _background_stop.set()


@app.get("/health")
def health() -> Dict[str, Any]:
    with _index_lock:
        indexed_count = len(_index_by_path)
        last_indexed_at = _last_indexed_at
        last_mode = _last_refresh_mode
        last_summary = dict(_last_refresh_summary)
        last_error = _last_refresh_error

    return {
        "status": "ok",
        "service": "officeindex-adapter",
        "indexedFiles": indexed_count,
        "lastIndexedAt": int(last_indexed_at * 1000) if last_indexed_at > 0 else None,
        "refreshIntervalSeconds": _refresh_interval_seconds(),
        "backgroundSyncSeconds": _background_sync_seconds(),
        "backgroundSyncActive": bool(_background_thread and _background_thread.is_alive()),
        "lastRefreshMode": last_mode,
        "lastRefreshSummary": last_summary,
        "lastRefreshError": last_error,
    }


@app.post("/search")
def search(payload: OfficeSearchRequest) -> Dict[str, Any]:
    started_at = time.perf_counter()

    try:
        query = parse_query(payload.query)
    except ValueError as exc:
        raise HTTPException(
            status_code=400,
            detail={"errorCode": "INVALID_QUERY", "message": str(exc)},
        ) from exc

    limit = parse_limit(payload.limit)
    degraded = False
    diagnostics: List[str] = []

    try:
        summary = _refresh_index(mode="incremental", bypass_interval=False)
        failed_count = int(summary.get("failedFiles", 0) or 0)
        if failed_count > 0:
            degraded = True
            for warning in summary.get("diagnostics", []):
                _append_diagnostic(diagnostics, warning)
    except FileNotFoundError as exc:
        degraded = True
        logger.warning("OfficeIndex refresh skipped due to missing workspace root: %s", exc)
        _append_diagnostic(diagnostics, f"refresh-failed:{exc}")
    except Exception:
        degraded = True
        logger.exception("OfficeIndex refresh failed; serving stale/partial index.")
        _append_diagnostic(diagnostics, "refresh-failed:unexpected-error")

    results = _search_index(query, limit)

    payload_out: Dict[str, Any] = {
        "query": query,
        "total": len(results),
        "tookMs": int((time.perf_counter() - started_at) * 1000),
        "results": results,
    }
    if degraded:
        payload_out["degraded"] = True
    if diagnostics:
        payload_out["diagnostics"] = diagnostics
    return payload_out


@app.post("/reindex")
def reindex(payload: Optional[OfficeReindexRequest] = None) -> Dict[str, Any]:
    requested_mode = payload.mode if payload else None
    try:
        mode = _parse_reindex_mode(requested_mode, default="full")
    except ValueError as exc:
        raise HTTPException(
            status_code=400,
            detail={"errorCode": "INVALID_MODE", "message": str(exc)},
        ) from exc

    try:
        summary = _refresh_index(mode=mode, bypass_interval=True)
    except FileNotFoundError as exc:
        raise HTTPException(
            status_code=503,
            detail={"errorCode": "WORKSPACE_ROOT_NOT_FOUND", "message": str(exc)},
        ) from exc
    except Exception:
        logger.exception("OfficeIndex reindex failed.")
        raise HTTPException(
            status_code=500,
            detail={"errorCode": "REINDEX_FAILED", "message": "Reindex failed due to an unexpected error."},
        )

    status = "degraded" if int(summary.get("failedFiles", 0) or 0) > 0 else "ok"
    return {
        "status": status,
        "mode": mode,
        "indexedFiles": summary.get("indexedFiles", 0),
        "scannedFiles": summary.get("scannedFiles", 0),
        "reusedFiles": summary.get("reusedFiles", 0),
        "updatedFiles": summary.get("updatedFiles", 0),
        "removedFiles": summary.get("removedFiles", 0),
        "failedFiles": summary.get("failedFiles", 0),
        "diagnostics": summary.get("diagnostics", []),
        "tookMs": summary.get("tookMs", 0),
    }
