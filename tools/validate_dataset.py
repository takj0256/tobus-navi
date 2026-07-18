#!/usr/bin/env python3
"""GitHub Pages公開前にPhase 4正式データを検証する。"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def validate_dataset_file(path: Path) -> tuple[int, int, int, str]:
    if not path.exists():
        raise ValueError(f"{path} がありません。公式GTFS-JPから再生成してください。")

    try:
        dataset = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"{path} を読み込めません: {exc}") from exc

    if not isinstance(dataset, dict) or not isinstance(dataset.get("stop_groups"), list):
        raise ValueError("Phase 4の停留所グループデータ形式ではありません。")
    meta = dataset.get("meta", {})
    if meta.get("demo") is True:
        raise ValueError("デモデータは正式公開できません。")
    if int(meta.get("schema_version", 0)) < 4:
        raise ValueError("データが旧形式です。convert_gtfs.pyで再生成してください。")
    if not dataset["stop_groups"]:
        raise ValueError("停留所データが空です。")

    routes = dataset.get("routes")
    if not isinstance(routes, dict) or not routes:
        raise ValueError("系統索引がありません。")

    route_dir = path.parent / "routes"
    missing = []
    for route in routes.values():
        relative = route.get("route_file", "")
        if not relative:
            missing.append(f"{route.get('route_id', 'unknown')}: route_fileなし")
            continue
        route_path = path.parent / relative
        if not route_path.exists():
            missing.append(relative)
    if missing:
        sample = ", ".join(missing[:5])
        raise ValueError(f"系統別データが不足しています: {sample}")

    platform_count = sum(len(group.get("platforms", [])) for group in dataset["stop_groups"])
    generated_at = str(meta.get("generated_at") or "不明")
    return len(dataset["stop_groups"]), platform_count, len(routes), generated_at


def main() -> int:
    parser = argparse.ArgumentParser(description="正式な都バスPhase 4データを検証します。")
    parser.add_argument(
        "path",
        nargs="?",
        type=Path,
        default=Path("data/transit-index.json"),
    )
    args = parser.parse_args()

    try:
        groups, platforms, routes, generated_at = validate_dataset_file(args.path)
    except ValueError as exc:
        print(f"エラー: {exc}", file=sys.stderr)
        return 1

    print(
        f"正式データ確認: {groups}停留所名 / {platforms}のりば / "
        f"{routes}系統 / 生成日時 {generated_at}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
