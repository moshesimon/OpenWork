from __future__ import annotations

import os
import re
from datetime import datetime
from pathlib import Path
from typing import Optional

DEFAULT_LIMIT = 40
MAX_LIMIT = 100
MIN_QUERY_LENGTH = 2
MAX_QUERY_LENGTH = 180

REPO_ROOT = Path(__file__).resolve().parents[2]


def parse_query(raw_query: str) -> str:
    query = (raw_query or "").strip()
    if not query:
        raise ValueError("Search query is required.")
    if len(query) < MIN_QUERY_LENGTH:
        raise ValueError(f"Search query must be at least {MIN_QUERY_LENGTH} characters.")
    return query[:MAX_QUERY_LENGTH]


def parse_limit(raw_limit: Optional[int]) -> int:
    if raw_limit is None:
        return DEFAULT_LIMIT
    return max(1, min(int(raw_limit), MAX_LIMIT))


def score_text_match(haystack: str, needle_lower: str) -> int:
    if not haystack:
        return 0

    value = haystack.lower()
    if value == needle_lower:
        return 220
    if value.startswith(needle_lower):
        return 170

    index = value.find(needle_lower)
    if index == -1:
        return 0

    early_bonus = max(0, 40 - (index // 4))
    return 120 + early_bonus


def extract_search_snippet(text: str, needle_lower: str, radius: int = 90) -> Optional[str]:
    if not text:
        return None

    normalized = re.sub(r"\s+", " ", text).strip()
    if not normalized:
        return None

    lower = normalized.lower()
    index = lower.find(needle_lower)
    if index == -1:
        fallback = normalized[: radius * 2]
        return f"{fallback}…" if len(normalized) > len(fallback) else fallback

    start = max(0, index - radius)
    end = min(len(normalized), index + len(needle_lower) + radius)
    snippet = normalized[start:end].strip()
    prefix = "…" if start > 0 else ""
    suffix = "…" if end < len(normalized) else ""
    return f"{prefix}{snippet}{suffix}"


def sort_time_value(raw_value: Optional[str]) -> float:
    if not raw_value:
        return 0.0

    value = raw_value.strip()
    if not value:
        return 0.0

    try:
        candidate = value.replace("Z", "+00:00")
        return datetime.fromisoformat(candidate).timestamp()
    except ValueError:
        return 0.0


def resolve_database_path() -> Path:
    database_url = (os.getenv("DATABASE_URL") or "file:./prisma/dev.db").strip()
    if database_url.startswith("file:"):
        raw_path = database_url[5:].split("?", 1)[0]
    else:
        raw_path = database_url.split("?", 1)[0]

    if raw_path.startswith("//"):
        resolved = Path(raw_path[2:])
    else:
        resolved = Path(raw_path)

    if not resolved.is_absolute():
        resolved = REPO_ROOT / resolved

    return resolved.resolve()


def resolve_workspace_root() -> Path:
    configured_root = (os.getenv("WORKSPACE_FILES_ROOT") or "").strip()
    if not configured_root:
        return (REPO_ROOT / "company_files").resolve()

    root = Path(configured_root)
    if not root.is_absolute():
        root = REPO_ROOT / root
    return root.resolve()
