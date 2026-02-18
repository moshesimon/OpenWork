# Global Search Handover (OpenWork)

Updated: **February 18, 2026**

## Scope Completed
- Global search across channels, DMs, messages, files, tasks, calendar events, and users is live.
- Search is wired to both UI and agent tooling.
- Provider fanout is live for chat + files with safe fallback behavior.
- Non-PDF Office search Phases 1-4 are implemented (adapter, wiring, lifecycle, and validation).

## Current Architecture (Live)
1. UI calls:
   - `GET /api/search/global?q=<query>&limit=<n>`
   - Route: `/Users/moshesimon/GitHub/OpenWork/src/app/api/search/global/route.ts`
2. Global search service fans out by provider:
   - Chat providers: native + optional `CHATINDEX_SEARCH_URL`
   - File providers: native + optional `PAGEINDEX_SEARCH_URL` + optional `OFFICEINDEX_SEARCH_URL`
   - Service: `/Users/moshesimon/GitHub/OpenWork/src/server/global-search.ts`
3. Results are merged, deduped by entity key, ranked, and returned in one payload.

## Implemented Adapter Surfaces

### Next.js adapter endpoints
- `POST /api/search/chatindex`
  - File: `/Users/moshesimon/GitHub/OpenWork/src/app/api/search/chatindex/route.ts`
  - Body: `{ query, userId?, limit? }`
  - Uses body `userId` with `x-user-id` fallback.
- `POST /api/search/pageindex`
  - File: `/Users/moshesimon/GitHub/OpenWork/src/app/api/search/pageindex/route.ts`
  - Body: `{ query, limit? }`

### In-process TypeScript adapter services
- Chat adapter:
  - `/Users/moshesimon/GitHub/OpenWork/src/server/chatindex-search.ts`
- File adapter:
  - `/Users/moshesimon/GitHub/OpenWork/src/server/pageindex-search.ts`

### Python FastAPI adapters (external mode)
- Root: `/Users/moshesimon/GitHub/OpenWork/agent_runtime/search_adapters`
- Chat service (`:8101`):
  - `/Users/moshesimon/GitHub/OpenWork/agent_runtime/search_adapters/chatindex_api.py`
- Page service (`:8102`):
  - `/Users/moshesimon/GitHub/OpenWork/agent_runtime/search_adapters/pageindex_api.py`
- Office service (`:8103`):
  - `/Users/moshesimon/GitHub/OpenWork/agent_runtime/search_adapters/officeindex_api.py`
  - Supports `POST /search`, `POST /reindex`, `GET /health`
  - Supports full and incremental indexing by mtime/hash, optional background sync, and diagnostics.
- Office reindex CLI:
  - `/Users/moshesimon/GitHub/OpenWork/agent_runtime/search_adapters/officeindex_reindex.py`

## Current Search Behavior by File Type
- Text-like files (`.md`, `.txt`, `.json`, `.ts`, etc.):
  - Path/name + content search.
- Office OOXML (`.docx`, `.pptx`, `.xlsx`):
  - Content extraction + snippet search is live in OfficeIndex.
- Legacy Office binaries (`.doc`, `.ppt`, `.xls`):
  - Path-only unless OpenSearch ingest extraction is configured.
- PDFs:
  - PageIndex path/search behavior preserved; OfficeIndex can optionally include PDF by config.

## Shared Response Shape
- `query`, `total`, `tookMs`, `providers`, `results[]`
- Result fields include:
  - `kind`: `channel | dm | message | file | task | event | user`
  - `source`: `native | chatindex-service | pageindex-service | officeindex-service`
  - `score`, `title`, `subtitle`, `snippet`
  - navigation fields (`conversationId`, `messageId`, `filePath`, `taskId`, etc.)
- Current UI renders `snippet` text but does not visually highlight the matched substring yet.

## Tests Implemented
- Global search:
  - `/Users/moshesimon/GitHub/OpenWork/src/server/global-search.unit.test.ts`
  - `/Users/moshesimon/GitHub/OpenWork/src/server/global-search.integration.test.ts`
  - Includes Office provider merge, fallback, and dedupe assertions.
- Office adapter fixture tests:
  - `/Users/moshesimon/GitHub/OpenWork/agent_runtime/search_adapters/test_officeindex_api.py`
  - Covers `.docx/.pptx/.xlsx` content hits and rank tuning order.

## Environment Wiring
- `.env.example` documents:
  - `CHATINDEX_SEARCH_URL`
  - `PAGEINDEX_SEARCH_URL`
  - `OFFICEINDEX_SEARCH_URL`
  - Office lifecycle vars (`OFFICEINDEX_REFRESH_INTERVAL_SECONDS`, `OFFICEINDEX_BACKGROUND_SYNC_SECONDS`, etc.)
- Current local `.env` points Office search to:
  - `OFFICEINDEX_SEARCH_URL="http://localhost:8103/search"`

## Non-PDF Office Content Search Plan Status
Goal: search inside `.doc/.docx/.ppt/.pptx/.xls/.xlsx` while keeping PageIndex workflows stable.

### Phase 1: Office extraction/index service
- Status: Completed.
- Delivered:
  - FastAPI OfficeIndex adapter with extraction + normalized `POST /search`.

### Phase 2: Global search wiring
- Status: Completed.
- Delivered:
  - `OFFICEINDEX_SEARCH_URL` support in `src/server/global-search.ts`
  - Merge and dedupe with `officeindex-service + pageindex-service + native`

### Phase 3: Index lifecycle and freshness
- Status: Completed.
- Delivered:
  - Full and incremental reindex
  - mtime/hash-based reuse
  - optional background sync
  - degraded-but-valid responses with diagnostics

### Phase 4: Quality and validation
- Status: Completed.
- Delivered:
  - Integration tests with mocked Office provider
  - Fixture tests for `.docx/.pptx/.xlsx`
  - Dedupe checks for same `filePath` across providers
  - Rank tuning: exact filename > exact content phrase > partial content

## New Plan: Highlight Matched Text in Results (Documents + Chat + Events)
Goal: visually highlight matched query text in result title/snippet, similar to IDE search UX.

### Phase 5A: Highlight metadata contract
1. Extend `GlobalSearchResult` payload with optional highlight metadata:
   - `highlights?: { title?: Array<{start:number,end:number}>; snippet?: Array<{start:number,end:number}>; subtitle?: Array<{start:number,end:number}> }`
2. Keep `snippet` plain text for backward compatibility.
3. For external providers, accept optional provider highlights and normalize in `global-search.ts`.

### Phase 5B: Backend highlight generation
1. Add a shared helper that finds case-insensitive match ranges in text.
2. Generate ranges for:
   - `file`: `title` and `snippet`
   - `message/chat`: `title` and `snippet`
   - `event`: `title`, `subtitle`, and `snippet` where applicable
3. When no match ranges are found, omit `highlights` and keep current behavior.

### Phase 5C: UI rendering with `<mark>`
1. In `/Users/moshesimon/GitHub/OpenWork/src/app/page.tsx`, render highlighted spans for title/snippet/subtitle using range metadata.
2. Add safe text-splitting renderer (no raw HTML injection).
3. Add styles in `/Users/moshesimon/GitHub/OpenWork/src/app/globals.css` for high-contrast match highlights.

### Phase 5D: Validation
1. Unit tests for range generation (case-insensitive, multiple hits, overlapping edge cases).
2. Integration tests asserting highlights for file/chat/event results.
3. UI test coverage (or component-level assertions) that `<mark>` renders correctly.

## Acceptance Criteria for Highlighting
- Query matches appear visually highlighted in global search results for:
  - document results
  - chat/message results
  - calendar event results
- Highlighting works for multiple matches in the same snippet.
- No regression in ranking, navigation, or provider fallback behavior.

## Prompt for Next Chat
Use this instruction:

> Continue from `GLOBAL_SEARCH_HANDOVER.md` (Updated February 18, 2026). Implement Phase 5A and 5B for highlighted search matches by extending global search result contracts with highlight ranges and populating them for document/chat/event results.
