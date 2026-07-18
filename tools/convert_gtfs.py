#!/usr/bin/env python3
"""GTFS/GTFS-JPを都バスナビ Phase 6 用データへ変換する。

出力:
  data/transit-index.json      停留所グループ・系統索引
  data/routes/<hash>.json      系統別の時刻表・便・停留所列

標準ライブラリだけで動作し、入力はGTFS ZIPまたは展開済みディレクトリ。
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import math
import re
import shutil
import sys
import unicodedata
import zipfile
from collections import defaultdict
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator, Optional, TextIO

REQUIRED_FILES = ("stops.txt", "routes.txt", "trips.txt", "stop_times.txt")
WEEKDAY_FIELDS = (
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
)


@dataclass(frozen=True)
class Trip:
    trip_id: str
    route_id: str
    service_id: str
    headsign: str
    direction_id: str
    shape_id: str


@contextmanager
def open_text(source: Path, filename: str, required: bool = True) -> Iterator[Optional[TextIO]]:
    if source.is_dir():
        path = source / filename
        if not path.exists():
            if required:
                raise FileNotFoundError(f"{filename} が見つかりません: {path}")
            yield None
            return
        with path.open("r", encoding="utf-8-sig", newline="") as handle:
            yield handle
        return

    if source.is_file() and zipfile.is_zipfile(source):
        with zipfile.ZipFile(source) as archive:
            try:
                raw = archive.open(filename)
            except KeyError:
                if required:
                    raise FileNotFoundError(f"ZIP内に {filename} が見つかりません")
                yield None
                return
            with raw:
                with io.TextIOWrapper(raw, encoding="utf-8-sig", newline="") as handle:
                    yield handle
        return

    raise ValueError("入力はGTFS ZIPまたは展開済みディレクトリを指定してください。")


def read_csv(source: Path, filename: str, required: bool = True) -> Iterator[dict[str, str]]:
    with open_text(source, filename, required=required) as handle:
        if handle is None:
            return
        reader = csv.DictReader(handle)
        if not reader.fieldnames:
            raise ValueError(f"{filename} にヘッダーがありません。")
        for row in reader:
            yield {key: (value or "").strip() for key, value in row.items()}


def stable_id(prefix: str, value: str, length: int = 16) -> str:
    digest = hashlib.sha1(value.encode("utf-8")).hexdigest()[:length]
    return f"{prefix}-{digest}"


def parse_gtfs_time(value: str) -> Optional[int]:
    value = value.strip()
    if not value:
        return None
    parts = value.split(":")
    if len(parts) != 3:
        return None
    try:
        hours, minutes, seconds = (int(part) for part in parts)
    except ValueError:
        return None
    if hours < 0 or minutes not in range(60) or seconds not in range(60):
        return None
    return hours * 3600 + minutes * 60 + seconds


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    radius = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return radius * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def normalize_headsign(value: str) -> str:
    return value.strip() or "行き先不明"


def normalize_platform_label(platform_code: str, child_name: str, parent_name: str) -> str:
    """GTFSのplatform_codeまたは子停留所名から、利用者向けのりば表記を作る。"""
    value = (platform_code or "").strip()
    if not value and child_name and child_name != parent_name:
        value = child_name.strip()
    if not value:
        return ""
    if re.fullmatch(r"[0-9０-９]+", value):
        return f"{value}番のりば"
    if re.fullmatch(r"[0-9０-９]+番", value):
        return f"{value}のりば"
    return value


def platform_sort_key(platform: dict) -> tuple:
    value = unicodedata.normalize("NFKC", str(platform.get("platform_code", "")))
    match = re.match(r"^(\d+)", value)
    if match:
        return (0, int(match.group(1)), value, platform.get("stop_id", ""))
    return (1, value, platform.get("stop_id", ""))


def cluster_same_name_platforms(platforms: list[dict], threshold_km: float = 0.5) -> list[list[dict]]:
    """同名停留所を近接クラスタへ分け、別地域の同名停留所を誤結合しない。"""
    remaining = list(platforms)
    clusters: list[list[dict]] = []
    while remaining:
        cluster = [remaining.pop(0)]
        changed = True
        while changed:
            changed = False
            for candidate in list(remaining):
                if any(
                    haversine_km(candidate["lat"], candidate["lon"], member["lat"], member["lon"]) <= threshold_km
                    for member in cluster
                ):
                    cluster.append(candidate)
                    remaining.remove(candidate)
                    changed = True
        clusters.append(cluster)
    return clusters


def load_calendars(source: Path) -> tuple[dict[str, dict], dict[str, dict[str, list[str]]]]:
    calendars: dict[str, dict] = {}
    for row in read_csv(source, "calendar.txt", required=False):
        service_id = row.get("service_id", "")
        if not service_id:
            continue
        calendars[service_id] = {
            "start_date": row.get("start_date", ""),
            "end_date": row.get("end_date", ""),
            "weekdays": [1 if row.get(field) == "1" else 0 for field in WEEKDAY_FIELDS],
        }

    exceptions: dict[str, dict[str, list[str]]] = defaultdict(lambda: {"add": [], "remove": []})
    for row in read_csv(source, "calendar_dates.txt", required=False):
        service_id = row.get("service_id", "")
        date = row.get("date", "")
        if not service_id or not date:
            continue
        if row.get("exception_type") == "1":
            exceptions[date]["add"].append(service_id)
        elif row.get("exception_type") == "2":
            exceptions[date]["remove"].append(service_id)

    normalized = {
        date: {
            "add": sorted(set(values["add"])),
            "remove": sorted(set(values["remove"])),
        }
        for date, values in exceptions.items()
    }
    return calendars, normalized


def build_dataset(
    source: Path,
    center_lat: Optional[float],
    center_lon: Optional[float],
    radius_km: Optional[float],
) -> tuple[dict, dict[str, dict]]:
    routes: dict[str, dict[str, str]] = {}
    for row in read_csv(source, "routes.txt"):
        route_id = row.get("route_id", "")
        if not route_id:
            continue
        route_file = f"routes/{stable_id('route', route_id)}.json"
        routes[route_id] = {
            "route_id": route_id,
            "route_name": row.get("route_short_name") or row.get("route_long_name") or route_id,
            "route_long_name": row.get("route_long_name", ""),
            "agency_id": row.get("agency_id", ""),
            "route_file": route_file,
        }

    trips: dict[str, Trip] = {}
    route_trip_ids: dict[str, list[str]] = defaultdict(list)
    for row in read_csv(source, "trips.txt"):
        trip_id = row.get("trip_id", "")
        route_id = row.get("route_id", "")
        if not trip_id or route_id not in routes:
            continue
        trip = Trip(
            trip_id=trip_id,
            route_id=route_id,
            service_id=row.get("service_id", ""),
            headsign=normalize_headsign(row.get("trip_headsign", "")),
            direction_id=row.get("direction_id", ""),
            shape_id=row.get("shape_id", ""),
        )
        trips[trip_id] = trip
        route_trip_ids[route_id].append(trip_id)

    # location_type=1 の親停留所を先に読み込み、子のりばの表示名へ反映する。
    raw_stops = list(read_csv(source, "stops.txt"))
    parent_stations: dict[str, dict[str, str]] = {}
    for row in raw_stops:
        stop_id = row.get("stop_id", "")
        location_type = row.get("location_type", "0") or "0"
        if stop_id and location_type == "1":
            parent_stations[stop_id] = row

    stops: dict[str, dict] = {}
    for row in raw_stops:
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

        parent_station_id = row.get("parent_station", "")
        parent = parent_stations.get(parent_station_id, {})
        child_name = row.get("stop_name") or stop_id
        parent_name = parent.get("stop_name", "")
        display_name = parent_name or child_name
        display_kana = (
            parent.get("stop_name_kana")
            or parent.get("stop_name_ja-Hrkt")
            or row.get("stop_name_kana")
            or row.get("stop_name_ja-Hrkt")
            or ""
        )
        platform_label = normalize_platform_label(
            row.get("platform_code", ""),
            child_name,
            display_name,
        )

        stops[stop_id] = {
            "stop_id": stop_id,
            "stop_name": display_name,
            "raw_stop_name": child_name,
            "stop_name_kana": display_kana,
            "platform_code": platform_label,
            "parent_station_id": parent_station_id,
            "lat": lat,
            "lon": lon,
        }

    stop_times_by_trip: dict[str, list[list]] = defaultdict(list)
    platform_routes: dict[str, set[tuple[str, str, str, str, str]]] = defaultdict(set)
    route_stop_ids: dict[str, set[str]] = defaultdict(set)

    for row in read_csv(source, "stop_times.txt"):
        stop_id = row.get("stop_id", "")
        trip = trips.get(row.get("trip_id", ""))
        if trip is None or stop_id not in stops:
            continue

        arrival = parse_gtfs_time(row.get("arrival_time", ""))
        departure = parse_gtfs_time(row.get("departure_time", ""))
        if arrival is None and departure is None:
            continue
        if arrival is None:
            arrival = departure
        if departure is None:
            departure = arrival
        try:
            sequence = int(row.get("stop_sequence", "0"))
        except ValueError:
            sequence = 0

        stop_times_by_trip[trip.trip_id].append([stop_id, arrival, departure, sequence])
        route = routes[trip.route_id]
        platform_routes[stop_id].add(
            (
                trip.route_id,
                route["route_name"],
                trip.headsign,
                trip.direction_id,
                route["route_file"],
            )
        )
        route_stop_ids[trip.route_id].add(stop_id)

    # エリア絞り込みで途中停留所が抜けた便は、残った停留所だけを保持する。
    for values in stop_times_by_trip.values():
        values.sort(key=lambda item: item[3])

    calendars, exceptions = load_calendars(source)

    # parent_station がある場合は親IDを最優先で一つの停留所カードにまとめる。
    # 親IDがない停留所は従来どおり同名＋近接距離でクラスタ化する。
    groups_by_parent: dict[str, list[dict]] = defaultdict(list)
    groups_by_name: dict[str, list[dict]] = defaultdict(list)
    for stop in stops.values():
        route_values = platform_routes.get(stop["stop_id"], set())
        platform = {
            **stop,
            "routes": [
                {
                    "route_id": route_id,
                    "route_name": route_name,
                    "headsign": headsign,
                    "direction_id": direction_id,
                    "route_file": route_file,
                }
                for route_id, route_name, headsign, direction_id, route_file in sorted(
                    route_values,
                    key=lambda item: (item[1], item[2], item[3]),
                )
            ],
        }
        parent_station_id = stop.get("parent_station_id", "")
        if parent_station_id:
            groups_by_parent[parent_station_id].append(platform)
        else:
            groups_by_name[stop["stop_name"]].append(platform)

    stop_groups: list[dict] = []

    def append_group(platforms: list[dict], group_seed_prefix: str) -> None:
        platforms.sort(key=platform_sort_key)
        lat = sum(item["lat"] for item in platforms) / len(platforms)
        lon = sum(item["lon"] for item in platforms) / len(platforms)
        stop_name = next((item["stop_name"] for item in platforms if item["stop_name"]), "停留所")
        kana = next((item["stop_name_kana"] for item in platforms if item["stop_name_kana"]), "")
        group_seed = group_seed_prefix + "|" + "|".join(sorted(item["stop_id"] for item in platforms))
        stop_groups.append(
            {
                "group_id": stable_id("stop", group_seed),
                "stop_name": stop_name,
                "stop_name_kana": kana,
                "lat": lat,
                "lon": lon,
                "platforms": platforms,
            }
        )

    for parent_station_id, platforms in groups_by_parent.items():
        append_group(platforms, f"parent:{parent_station_id}")

    for stop_name, same_name_platforms in groups_by_name.items():
        for cluster_index, platforms in enumerate(cluster_same_name_platforms(same_name_platforms)):
            append_group(platforms, f"name:{stop_name}:{cluster_index}")

    stop_groups.sort(key=lambda item: item["stop_name"])
    generated_at = datetime.now(timezone.utc).isoformat()

    index = {
        "meta": {
            "schema_version": 5,
            "dataset_name": "都バスGTFS-JP正式データ",
            "generated_at": generated_at,
            "provider": "東京都交通局・公共交通オープンデータ協議会",
            "license": "CC BY 4.0",
            "demo": False,
            "source": source.name,
            "stop_group_count": len(stop_groups),
            "platform_count": len(stops),
            "route_count": len(routes),
        },
        "stop_groups": stop_groups,
        "routes": routes,
    }

    route_files: dict[str, dict] = {}
    for route_id, route in routes.items():
        route_trips = []
        used_service_ids: set[str] = set()
        used_stop_ids = route_stop_ids.get(route_id, set())

        for trip_id in route_trip_ids.get(route_id, []):
            trip = trips[trip_id]
            stop_times = stop_times_by_trip.get(trip_id, [])
            if not stop_times:
                continue
            used_service_ids.add(trip.service_id)
            route_trips.append(
                {
                    "trip_id": trip.trip_id,
                    "service_id": trip.service_id,
                    "headsign": trip.headsign,
                    "direction_id": trip.direction_id,
                    "shape_id": trip.shape_id,
                    "stop_times": stop_times,
                }
            )

        route_trips.sort(
            key=lambda item: (
                item["direction_id"],
                item["headsign"],
                item["stop_times"][0][2] if item["stop_times"] else 0,
                item["trip_id"],
            )
        )

        route_calendars = {
            service_id: calendars[service_id]
            for service_id in sorted(used_service_ids)
            if service_id in calendars
        }
        route_exceptions = {
            date: {
                "add": [service_id for service_id in values["add"] if service_id in used_service_ids],
                "remove": [service_id for service_id in values["remove"] if service_id in used_service_ids],
            }
            for date, values in exceptions.items()
            if any(service_id in used_service_ids for service_id in values["add"] + values["remove"])
        }
        route_exceptions = {
            date: values
            for date, values in route_exceptions.items()
            if values["add"] or values["remove"]
        }

        route_files[route["route_file"]] = {
            "meta": {
                "schema_version": 5,
                "generated_at": generated_at,
                "provider": index["meta"]["provider"],
                "license": "CC BY 4.0",
            },
            "route": {
                "route_id": route_id,
                "route_name": route["route_name"],
                "route_long_name": route["route_long_name"],
            },
            "stops": {
                stop_id: stops[stop_id]
                for stop_id in sorted(used_stop_ids)
                if stop_id in stops
            },
            "services": {
                "calendars": route_calendars,
                "exceptions": route_exceptions,
            },
            "trips": route_trips,
        }

    return index, route_files


def write_dataset(index: dict, route_files: dict[str, dict], output_dir: Path, pretty: bool) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    route_dir = output_dir / "routes"
    if route_dir.exists():
        shutil.rmtree(route_dir)
    route_dir.mkdir(parents=True, exist_ok=True)

    json_kwargs = {
        "ensure_ascii": False,
        "indent": 2 if pretty else None,
        "separators": None if pretty else (",", ":"),
    }
    (output_dir / "transit-index.json").write_text(
        json.dumps(index, **json_kwargs),
        encoding="utf-8",
    )

    for relative_path, payload in route_files.items():
        target = output_dir / relative_path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(payload, **json_kwargs), encoding="utf-8")


def parse_args(argv: Optional[list[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="GTFS/GTFS-JPを都バスナビ用データへ変換します。")
    parser.add_argument("source", type=Path, help="GTFS ZIPまたは展開済みディレクトリ")
    parser.add_argument("-o", "--output-dir", type=Path, default=Path("data"), help="出力ディレクトリ")
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
        index, route_files = build_dataset(args.source, args.center_lat, args.center_lon, args.radius_km)
        write_dataset(index, route_files, args.output_dir, args.pretty)
        print(
            "生成完了: "
            f"{args.output_dir / 'transit-index.json'} "
            f"({index['meta']['stop_group_count']}停留所名 / "
            f"{index['meta']['platform_count']}のりば / {len(route_files)}系統)"
        )
        return 0
    except (OSError, ValueError, csv.Error, json.JSONDecodeError) as exc:
        print(f"エラー: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
