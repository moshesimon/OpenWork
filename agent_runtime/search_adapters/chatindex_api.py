from __future__ import annotations

import sqlite3
import time
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel

from .common import (
    extract_search_snippet,
    parse_limit,
    parse_query,
    resolve_database_path,
    score_text_match,
    sort_time_value,
)

app = FastAPI(title="OpenWork ChatIndex Adapter", version="0.1.0")


class ChatSearchRequest(BaseModel):
    query: str
    userId: Optional[str] = None
    limit: Optional[int] = None


def _connect_database() -> sqlite3.Connection:
    database_path = resolve_database_path()
    if not database_path.exists():
        raise FileNotFoundError(f"Database file not found: {database_path}")

    connection = sqlite3.connect(str(database_path))
    connection.row_factory = sqlite3.Row
    return connection


def _require_user(connection: sqlite3.Connection, user_id: str) -> None:
    row = connection.execute(
        'SELECT "id" FROM "User" WHERE "id" = ? LIMIT 1',
        (user_id,),
    ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail={"errorCode": "USER_NOT_FOUND", "message": "User does not exist."})


def _result_key(result: Dict[str, Any]) -> str:
    kind = result["kind"]
    if kind == "channel":
        return f"channel:{result.get('conversationId') or result.get('channelSlug') or result.get('id')}"
    if kind == "dm":
        return f"dm:{result.get('otherUserId') or result.get('conversationId') or result.get('id')}"
    return f"message:{result.get('messageId') or result.get('id')}"


def _dedupe_results(results: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    best_by_key: Dict[str, Dict[str, Any]] = {}
    for result in results:
        key = _result_key(result)
        existing = best_by_key.get(key)
        if existing is None or result["score"] > existing["score"]:
            best_by_key[key] = result
    return list(best_by_key.values())


def _sort_results(results: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    return sorted(
        results,
        key=lambda item: (item["score"], sort_time_value(item.get("createdAt"))),
        reverse=True,
    )


def _search_channels(
    connection: sqlite3.Connection,
    query: str,
    needle_lower: str,
    limit: int,
) -> List[Dict[str, Any]]:
    like_query = f"%{query.lower()}%"
    rows = connection.execute(
        '''
        SELECT
          c."id" AS conversation_id,
          c."createdAt" AS created_at,
          ch."name" AS channel_name,
          ch."slug" AS channel_slug
        FROM "Conversation" c
        JOIN "Channel" ch ON ch."id" = c."channelId"
        WHERE c."type" = 'CHANNEL'
          AND (lower(ch."name") LIKE ? OR lower(ch."slug") LIKE ?)
        ORDER BY c."createdAt" DESC
        LIMIT ?
        ''',
        (like_query, like_query, limit),
    ).fetchall()

    results: List[Dict[str, Any]] = []
    for row in rows:
        channel_name = row["channel_name"] or "channel"
        channel_slug = row["channel_slug"] or ""
        score = max(
            score_text_match(channel_name, needle_lower),
            score_text_match(channel_slug, needle_lower),
        )

        results.append(
            {
                "kind": "channel",
                "id": row["conversation_id"],
                "score": score + 50,
                "title": f"#{channel_name}",
                "subtitle": f"Channel · {channel_slug}",
                "snippet": None,
                "createdAt": row["created_at"],
                "conversationId": row["conversation_id"],
                "threadKind": "channel",
                "channelSlug": channel_slug,
                "channelName": channel_name,
                "otherUserId": None,
                "otherUserName": None,
                "messageId": None,
            }
        )

    return results


def _search_dms(
    connection: sqlite3.Connection,
    user_id: str,
    needle_lower: str,
    limit: int,
) -> List[Dict[str, Any]]:
    rows = connection.execute(
        '''
        SELECT
          c."id" AS conversation_id,
          c."createdAt" AS created_at,
          c."dmUserAId" AS dm_user_a_id,
          c."dmUserBId" AS dm_user_b_id,
          ua."id" AS user_a_id,
          ua."displayName" AS user_a_name,
          ub."id" AS user_b_id,
          ub."displayName" AS user_b_name
        FROM "Conversation" c
        LEFT JOIN "User" ua ON ua."id" = c."dmUserAId"
        LEFT JOIN "User" ub ON ub."id" = c."dmUserBId"
        WHERE c."type" = 'DM'
          AND (c."dmUserAId" = ? OR c."dmUserBId" = ?)
        LIMIT 500
        ''',
        (user_id, user_id),
    ).fetchall()

    results: List[Dict[str, Any]] = []
    for row in rows:
        if row["dm_user_a_id"] == user_id:
            other_user_id = row["user_b_id"]
            other_user_name = row["user_b_name"]
        elif row["dm_user_b_id"] == user_id:
            other_user_id = row["user_a_id"]
            other_user_name = row["user_a_name"]
        else:
            continue

        if not other_user_id or not other_user_name:
            continue

        score = max(
            score_text_match(other_user_name, needle_lower),
            score_text_match(other_user_id, needle_lower),
        )
        if score == 0:
            continue

        results.append(
            {
                "kind": "dm",
                "id": row["conversation_id"],
                "score": score + 44,
                "title": other_user_name,
                "subtitle": "Direct message",
                "snippet": None,
                "createdAt": row["created_at"],
                "conversationId": row["conversation_id"],
                "threadKind": "dm",
                "channelSlug": None,
                "channelName": None,
                "otherUserId": other_user_id,
                "otherUserName": other_user_name,
                "messageId": None,
            }
        )

        if len(results) >= limit:
            break

    return results


def _search_messages(
    connection: sqlite3.Connection,
    user_id: str,
    query: str,
    needle_lower: str,
    limit: int,
) -> List[Dict[str, Any]]:
    like_query = f"%{query.lower()}%"
    rows = connection.execute(
        '''
        SELECT
          m."id" AS message_id,
          m."conversationId" AS conversation_id,
          m."body" AS body,
          m."createdAt" AS created_at,
          sender."displayName" AS sender_name,
          c."type" AS conversation_type,
          ch."name" AS channel_name,
          ch."slug" AS channel_slug,
          c."dmUserAId" AS dm_user_a_id,
          c."dmUserBId" AS dm_user_b_id,
          ua."id" AS user_a_id,
          ua."displayName" AS user_a_name,
          ub."id" AS user_b_id,
          ub."displayName" AS user_b_name
        FROM "Message" m
        JOIN "Conversation" c ON c."id" = m."conversationId"
        JOIN "User" sender ON sender."id" = m."senderId"
        LEFT JOIN "Channel" ch ON ch."id" = c."channelId"
        LEFT JOIN "User" ua ON ua."id" = c."dmUserAId"
        LEFT JOIN "User" ub ON ub."id" = c."dmUserBId"
        WHERE lower(m."body") LIKE ?
          AND (
            c."type" = 'CHANNEL'
            OR (
              c."type" = 'DM'
              AND (c."dmUserAId" = ? OR c."dmUserBId" = ?)
            )
          )
        ORDER BY m."createdAt" DESC
        LIMIT ?
        ''',
        (like_query, user_id, user_id, limit),
    ).fetchall()

    results: List[Dict[str, Any]] = []
    for row in rows:
        body = row["body"] or ""
        body_score = score_text_match(body, needle_lower)
        if body_score == 0:
            continue

        created_at = row["created_at"]
        snippet = extract_search_snippet(body, needle_lower)

        if row["conversation_type"] == "CHANNEL":
            channel_name = row["channel_name"] or "channel"
            channel_slug = row["channel_slug"] or ""
            results.append(
                {
                    "kind": "message",
                    "id": row["message_id"],
                    "score": body_score + 30,
                    "title": f"{row['sender_name']} in #{channel_name}",
                    "subtitle": "Channel message",
                    "snippet": snippet,
                    "createdAt": created_at,
                    "conversationId": row["conversation_id"],
                    "threadKind": "channel",
                    "channelSlug": channel_slug,
                    "channelName": channel_name,
                    "otherUserId": None,
                    "otherUserName": None,
                    "messageId": row["message_id"],
                }
            )
            continue

        if row["dm_user_a_id"] == user_id:
            other_user_id = row["user_b_id"]
            other_user_name = row["user_b_name"]
        elif row["dm_user_b_id"] == user_id:
            other_user_id = row["user_a_id"]
            other_user_name = row["user_a_name"]
        else:
            other_user_id = None
            other_user_name = None

        results.append(
            {
                "kind": "message",
                "id": row["message_id"],
                "score": body_score + 30,
                "title": f"{row['sender_name']} in DM with {other_user_name or 'DM'}",
                "subtitle": "Direct message",
                "snippet": snippet,
                "createdAt": created_at,
                "conversationId": row["conversation_id"],
                "threadKind": "dm",
                "channelSlug": None,
                "channelName": None,
                "otherUserId": other_user_id,
                "otherUserName": other_user_name,
                "messageId": row["message_id"],
            }
        )

    return results


@app.get("/health")
def health() -> Dict[str, str]:
    return {"status": "ok", "service": "chatindex-adapter"}


@app.post("/search")
def search(payload: ChatSearchRequest, request: Request) -> Dict[str, Any]:
    started_at = time.perf_counter()

    try:
        query = parse_query(payload.query)
    except ValueError as exc:
        raise HTTPException(
            status_code=400,
            detail={"errorCode": "INVALID_QUERY", "message": str(exc)},
        ) from exc

    user_id = (payload.userId or request.headers.get("x-user-id") or "").strip()
    if not user_id:
        raise HTTPException(
            status_code=400,
            detail={"errorCode": "INVALID_USER", "message": "userId is required."},
        )

    limit = parse_limit(payload.limit)
    bucket = max(10, limit // 2)
    channel_limit = min(10, max(4, bucket // 3))
    dm_limit = min(10, max(4, bucket // 4))
    message_limit = max(10, int(bucket * 1.8))
    needle_lower = query.lower()

    try:
        connection = _connect_database()
    except FileNotFoundError as exc:
        raise HTTPException(
            status_code=503,
            detail={"errorCode": "DB_NOT_FOUND", "message": str(exc)},
        ) from exc

    try:
        _require_user(connection, user_id)

        channels = _search_channels(connection, query, needle_lower, channel_limit)
        dms = _search_dms(connection, user_id, needle_lower, dm_limit)
        messages = _search_messages(connection, user_id, query, needle_lower, message_limit)

        merged = _sort_results(_dedupe_results([*channels, *dms, *messages]))[:limit]

        return {
            "query": query,
            "total": len(merged),
            "tookMs": int((time.perf_counter() - started_at) * 1000),
            "results": merged,
        }
    finally:
        connection.close()
