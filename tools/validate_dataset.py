#!/usr/bin/env python3
"""GitHub Pages公開前に正式停留所データを検証する。"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def validate_dataset_file(path: Path) -> tuple[int, str]:
    if not path.exists():
        raise ValueError(f"{path} がありません。公式GTFS-JPから生成してください。")

    try:
        dataset = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"{path} を読み込めません: {exc}") from exc

    if not isinstance(dataset, dict) or not isinstance(dataset.get("stops"), list):
        raise ValueError("停留所データの形式が正しくありません。")
    if dataset.get("meta", {}).get("demo") is True:
        raise ValueError("デモデータは正式公開できません。")
    if not dataset["stops"]:
        raise ValueError("停留所データが空です。")

    count = len(dataset["stops"])
    generated_at = str(dataset.get("meta", {}).get("generated_at") or "不明")
    return count, generated_at


def main() -> int:
    parser = argparse.ArgumentParser(description="正式な都バス停留所データを検証します。")
    parser.add_argument("path", nargs="?", type=Path, default=Path("data/stops.json"))
    args = parser.parse_args()

    try:
        count, generated_at = validate_dataset_file(args.path)
    except ValueError as exc:
        print(f"エラー: {exc}", file=sys.stderr)
        return 1

    print(f"正式データ確認: {count}停留所 / 生成日時 {generated_at}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
