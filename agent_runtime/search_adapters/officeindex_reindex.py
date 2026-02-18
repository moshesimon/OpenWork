from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any, Dict
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Trigger OfficeIndex full or incremental reindex.")
    parser.add_argument(
        "--url",
        default=os.getenv("OFFICEINDEX_REINDEX_URL", "http://127.0.0.1:8103/reindex"),
        help="OfficeIndex reindex endpoint URL.",
    )
    parser.add_argument(
        "--mode",
        choices=("full", "incremental"),
        default="full",
        help="Reindex mode.",
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=25,
        help="HTTP timeout in seconds.",
    )
    return parser.parse_args()


def _post_json(url: str, payload: Dict[str, Any], timeout_seconds: int) -> Dict[str, Any]:
    request = Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"content-type": "application/json"},
        method="POST",
    )

    with urlopen(request, timeout=max(1, timeout_seconds)) as response:
        body = response.read().decode("utf-8")

    parsed = json.loads(body)
    if not isinstance(parsed, dict):
        raise ValueError("Expected JSON object in response.")

    return parsed


def main() -> int:
    args = _parse_args()
    payload = {"mode": args.mode}

    try:
        response = _post_json(args.url, payload, args.timeout)
    except HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        print(raw or f"HTTP {exc.code}", file=sys.stderr)
        return 1
    except URLError as exc:
        print(f"Request failed: {exc}", file=sys.stderr)
        return 1
    except (json.JSONDecodeError, ValueError) as exc:
        print(f"Invalid response: {exc}", file=sys.stderr)
        return 1

    print(json.dumps(response, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
