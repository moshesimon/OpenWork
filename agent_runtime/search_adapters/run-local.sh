#!/usr/bin/env bash
set -euo pipefail

python3 -m uvicorn agent_runtime.search_adapters.chatindex_api:app --host 127.0.0.1 --port 8101 --reload &
CHAT_PID=$!

python3 -m uvicorn agent_runtime.search_adapters.pageindex_api:app --host 127.0.0.1 --port 8102 --reload &
PAGE_PID=$!

python3 -m uvicorn agent_runtime.search_adapters.officeindex_api:app --host 127.0.0.1 --port 8103 --reload &
OFFICE_PID=$!

cleanup() {
  kill "$CHAT_PID" "$PAGE_PID" "$OFFICE_PID" 2>/dev/null || true
}

trap cleanup EXIT INT TERM
wait
