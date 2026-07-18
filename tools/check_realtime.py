#!/usr/bin/env python3
"""GTFS-RT配信のHTTP応答とCORSヘッダーを確認する簡易診断。"""
from __future__ import annotations

import argparse
import sys
import urllib.error
import urllib.request

DEFAULT_URL = "https://api-public.odpt.org/api/v4/gtfs/realtime/ToeiBus"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default=DEFAULT_URL, help="確認するGTFS-RT URL")
    parser.add_argument("--timeout", type=float, default=10.0)
    args = parser.parse_args()

    request = urllib.request.Request(
        args.url,
        headers={
            "Accept": "application/x-protobuf, application/octet-stream",
            "User-Agent": "tobus-navi-realtime-check/1.0",
        },
    )

    try:
        with urllib.request.urlopen(request, timeout=args.timeout) as response:
            body = response.read()
            print(f"HTTP: {response.status}")
            print(f"Content-Type: {response.headers.get('Content-Type', '(なし)')}")
            print(f"Bytes: {len(body)}")
            cors = response.headers.get("Access-Control-Allow-Origin")
            print(f"Access-Control-Allow-Origin: {cors or '(なし)'}")
            if not body:
                print("ERROR: 応答本文が空です。", file=sys.stderr)
                return 2
            if not cors:
                print("NOTE: CORSヘッダーがないため、ブラウザでは中継Workerが必要な可能性があります。")
            else:
                print("OK: HTTP応答と本文を取得できました。")
            return 0
    except urllib.error.HTTPError as error:
        print(f"ERROR: HTTP {error.code} {error.reason}", file=sys.stderr)
    except urllib.error.URLError as error:
        print(f"ERROR: {error.reason}", file=sys.stderr)
    except TimeoutError:
        print("ERROR: タイムアウトしました。", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
