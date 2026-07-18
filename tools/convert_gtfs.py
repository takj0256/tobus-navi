#!/usr/bin/env python3
"""GTFS/GTFS-JPから都バスナビ用 stops.json を生成する。

標準ライブラリだけで動作する。入力はGTFS ZIPまたは展開済みディレクトリ。
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import math
import sys
import zipfile
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator, Optional, TextIO
from contextlib import contextmanager

REQUIRED_FILES = ("stops.txt", "routes.txt", "trips.txt", "stop_times.txt")


@dataclass(frozen=True)
class Trip:
    route_id: str
    headsign: str
    direction_id: str


@contextmanager
def open_text(source: Path, filename: str) -> Iterator[TextIO]:
    if source.is_dir():
        path = source / filename
        if not path.exists():
            raise FileNotFoundError(f"{filename} が見つかりません: {path}")
        with path.open("r", encoding="utf-8-sig", newline="") as handle:
            yield handle
        return
    if source.is_file() and zipfile.is_zipfile(source):
        with zipfile.ZipFile(source) as archive:
            try:
                with archive.open(filename) as raw:
                    with io.TextIOWrapper(raw, encoding="utf-8-sig", newline="") as handle:
                        yield handle
            except KeyError as exc:
                raise FileNotFoundError(f"ZIP内に {filename} が見つかりません") from exc
        return
    raise ValueError("入力はGTFS ZIPまたは展開済みディレクトリを指定してください。")


def read_csv(source: Path, filename: str) -> Iterator[dict[str, str]]:
    with open_text(source, filename) as handle:
        reader = csv.DictReader(handle)
        if not reader.fieldnames:
            raise ValueError(f"{filename} にヘッダーがありません。")
        for row in reader:
            yield {key: (value or "").strip() for key, value in row.items()}


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    radius = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return radius * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def normalize_headsign(value: str) -> str:
    value = value.strip()
    # GTFSの正式な表示を加工せず保持する。語尾の補完はUI側の責務とする。
    return value or "行き先不明"


def build_dataset(source: Path, center_lat: Optional[float], center_lon: Optional[float], radius_km: Optional[float]) -> dict:
    routes: dict[str, dict[str, str]] = {}
    for row in read_csv(source, "routes.txt"):
        route_id = row.get("route_id", "")
        if not route_id:
            continue
        routes[route_id] = {
            "route_id": route_id,
            "route_name": row.get("route_short_name") or row.get("route_long_name") or route_id,
            "agency_id": row.get("agency_id", ""),
        }

    trips: dict[str, Trip] = {}
    for row in read_csv(source, "trips.txt"):
        trip_id = row.get("trip_id", "")
        route_id = row.get("route_id", "")
        if not trip_id or route_id not in routes:
            continue
        trips[trip_id] = Trip(
            route_id=route_id,
            headsign=normalize_headsign(row.get("trip_headsign", "")),
            direction_id=row.get("direction_id", ""),
        )

    stops: dict[str, dict] = {}
    for row in read_csv(source, "stops.txt"):
        stop_id = row.get("stop_id", "")
        if not stop_id:
            continue
        location_type = row.get("location_type", "0") or "0"
        if location_type not in ("0", ""):
            continue
        try:
            lat = float(row.get("stop_lat", ""))
            lon = float(row.get("stop_lon", ""))
        except ValueError:
            continue
        if center_lat is not None and center_lon is not None and radius_km is not None:
            if haversine_km(center_lat, center_lon, lat, lon) > radius_km:
                continue
        stops[stop_id] = {
            "stop_id": stop_id,
            "stop_name": row.get("stop_name") or stop_id,
            "stop_name_kana": row.get("stop_name_kana") or row.get("stop_name_ja-Hrkt") or "",
            "platform_code": row.get("platform_code", ""),
            "lat": lat,
            "lon": lon,
            "routes": [],
        }

    stop_routes: dict[str, set[tuple[str, str, str, str]]] = defaultdict(set)
    for row in read_csv(source, "stop_times.txt"):
        stop_id = row.get("stop_id", "")
        if stop_id not in stops:
            continue
        trip = trips.get(row.get("trip_id", ""))
        if trip is None:
            continue
        route = routes[trip.route_id]
        stop_routes[stop_id].add((trip.route_id, route["route_name"], trip.headsign, trip.direction_id))

    for stop_id, values in stop_routes.items():
        stops[stop_id]["routes"] = [
            {
                "route_id": route_id,
                "route_name": route_name,
                "headsign": headsign,
                "direction_id": direction_id,
            }
            for route_id, route_name, headsign, direction_id in sorted(values, key=lambda x: (x[1], x[2], x[3]))
        ]

    output_stops = sorted(stops.values(), key=lambda item: (item["stop_name"], item["platform_code"], item["stop_id"]))
    return {
        "meta": {
            "schema_version": 2,
            "dataset_name": "GTFS-JP変換データ",
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "provider": "東京都交通局・公共交通オープンデータ協議会",
            "license": "CC BY 4.0",
            "demo": False,
            "source": source.name,
            "stop_count": len(output_stops),
        },
        "stops": output_stops,
    }


def parse_args(argv: Optional[list[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="GTFS/GTFS-JPを都バスナビ用JSONへ変換します。")
    parser.add_argument("source", type=Path, help="GTFS ZIPまたは展開済みディレクトリ")
    parser.add_argument("-o", "--output", type=Path, default=Path("data/stops.json"), help="出力JSON")
    parser.add_argument("--center-lat", type=float, help="対象エリア中心緯度")
    parser.add_argument("--center-lon", type=float, help="対象エリア中心経度")
    parser.add_argument("--radius-km", type=float, help="対象エリア半径km")
    parser.add_argument("--pretty", action="store_true", help="読みやすく整形して出力")
    return parser.parse_args(argv)


def validate_area_args(args: argparse.Namespace) -> None:
    values = (args.center_lat, args.center_lon, args.radius_km)
    if any(value is not None for value in values) and not all(value is not None for value in values):
        raise ValueError("エリア絞り込みでは --center-lat, --center-lon, --radius-km をすべて指定してください。")
    if args.radius_km is not None and args.radius_km <= 0:
        raise ValueError("--radius-km は0より大きい値にしてください。")


def main(argv: Optional[list[str]] = None) -> int:
    args = parse_args(argv)
    try:
        validate_area_args(args)
        dataset = build_dataset(args.source, args.center_lat, args.center_lon, args.radius_km)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(
            json.dumps(dataset, ensure_ascii=False, indent=2 if args.pretty else None, separators=None if args.pretty else (",", ":")),
            encoding="utf-8",
        )
        print(f"生成完了: {args.output} ({len(dataset['stops'])}停留所)")
        return 0
    except (OSError, ValueError, csv.Error, json.JSONDecodeError) as exc:
        print(f"エラー: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
