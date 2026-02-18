# OpenWork Search FastAPI Adapters

These services expose Python FastAPI endpoints compatible with OpenWork global search provider hooks.

## Services

- ChatIndex adapter: `POST /search` on port `8101`
  - Reads channels, DMs, and messages from the SQLite DB (`DATABASE_URL`).
- PageIndex adapter: `POST /search` on port `8102`
  - Scans workspace files from `WORKSPACE_FILES_ROOT` (or `company_files`).
- OfficeIndex adapter: `POST /search` on port `8103`
  - Crawls Office binaries (`.doc/.docx/.ppt/.pptx/.xls/.xlsx` by default).
  - Extracts content through OpenSearch ingest attachment pipeline when configured.
  - Falls back to local OOXML extraction for `.docx/.pptx/.xlsx`.
  - Supports full and incremental reindex jobs via `POST /reindex`.

## Install

```bash
python3 -m venv .venv-search
source .venv-search/bin/activate
pip install -r agent_runtime/search_adapters/requirements.txt
```

## Run

Terminal 1:

```bash
python3 -m uvicorn agent_runtime.search_adapters.chatindex_api:app --host 127.0.0.1 --port 8101 --reload
```

Terminal 2:

```bash
python3 -m uvicorn agent_runtime.search_adapters.pageindex_api:app --host 127.0.0.1 --port 8102 --reload
```

Terminal 3:

```bash
python3 -m uvicorn agent_runtime.search_adapters.officeindex_api:app --host 127.0.0.1 --port 8103 --reload
```

Manual OfficeIndex jobs:

```bash
# Full rebuild
python3 -m agent_runtime.search_adapters.officeindex_reindex --mode full

# Incremental refresh (mtime/hash reuse)
python3 -m agent_runtime.search_adapters.officeindex_reindex --mode incremental
```

Run OfficeIndex fixture tests:

```bash
python3 -m unittest agent_runtime.search_adapters.test_officeindex_api
```

## OpenWork `.env`

```bash
CHATINDEX_SEARCH_URL="http://localhost:8101/search"
PAGEINDEX_SEARCH_URL="http://localhost:8102/search"
OFFICEINDEX_SEARCH_URL="http://localhost:8103/search"
```

## Request Contracts

ChatIndex request:

```json
{
  "query": "release notes",
  "userId": "u_alex",
  "limit": 40
}
```

PageIndex request:

```json
{
  "query": "roadmap",
  "limit": 40
}
```

OfficeIndex request:

```json
{
  "query": "q4 budget assumptions",
  "limit": 40
}
```

OfficeIndex reindex request:

```json
{
  "mode": "full"
}
```

## OfficeIndex Environment

All optional:

- `OFFICEINDEX_REFRESH_INTERVAL_SECONDS` (default: `25`)
- `OFFICEINDEX_BACKGROUND_SYNC_SECONDS` (default: `0`, disabled)
- `OFFICEINDEX_INCLUDE_PDF` (`true/false`, default: `false`)
- `OFFICEINDEX_OPENSEARCH_URL` (example: `http://localhost:9200`)
- `OFFICEINDEX_OPENSEARCH_PIPELINE` (default: `attachment`)
- `OFFICEINDEX_OPENSEARCH_USERNAME`
- `OFFICEINDEX_OPENSEARCH_PASSWORD`
- `OFFICEINDEX_EXTRACT_TIMEOUT_SECONDS` (default: `8`)
- `OFFICEINDEX_REINDEX_URL` (used by `officeindex_reindex.py`, default: `http://127.0.0.1:8103/reindex`)

## Health Checks

- `GET http://localhost:8101/health`
- `GET http://localhost:8102/health`
- `GET http://localhost:8103/health`

## Failure Handling

- Unreadable files/directories are skipped with diagnostics logged by the service.
- Search responses remain valid during refresh failures (`degraded: true` when applicable).
