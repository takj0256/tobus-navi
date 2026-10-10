#!/usr/bin/env python3
"""Validated GTFS release builder. Run only in the dedicated publication checkout.

Old route objects are retained for clients holding an older index. No D1/R2 writes.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import math
import os
import re
import tempfile
import urllib.request
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

try:
    from .convert_gtfs import build_dataset, haversine_km, read_csv
except ImportError:
    from convert_gtfs import build_dataset, haversine_km, read_csv

SOURCE_URL = "https://api-public.odpt.org/api/v4/files/Toei/data/ToeiBus-GTFS.zip"
JST = ZoneInfo("Asia/Tokyo")


def encoded(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()


def digest(value):
    return hashlib.sha256(encoded(value)).hexdigest()


def load(path, default=None):
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else default


def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=".gtfs-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(encoded(value))
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def platforms(index):
    return {p["stop_id"]: p for g in index["stop_groups"] for p in g["platforms"]}


def stop_audit(previous, current, checked_at):
    before, after = platforms(previous), platforms(current)
    moved, renamed = [], []
    for key in sorted(before.keys() & after.keys()):
        a, b = before[key], after[key]
        meters = haversine_km(a["lat"], a["lon"], b["lat"], b["lon"]) * 1000
        if meters >= 5:
            moved.append({"stop_id": key, "stop_name": b["stop_name"], "meters": round(meters, 1),
                          "before": [a["lat"], a["lon"]], "after": [b["lat"], b["lon"]]})
        if a["stop_name"] != b["stop_name"]:
            renamed.append({"stop_id": key, "before": a["stop_name"], "after": b["stop_name"]})
    return {"checked_at": checked_at, "platforms_checked": len(after),
            "added": sorted(after.keys() - before.keys()), "removed": sorted(before.keys() - after.keys()),
            "moved": moved, "renamed": renamed,
            "historical_ids_remapped": False, "temporary_moves_not_in_feed": "unconfirmed"}


def active_services(payload, day):
    key = day.strftime("%Y%m%d")
    services = payload["services"]
    active = {sid for sid, c in services["calendars"].items()
              if c["start_date"] <= key <= c["end_date"] and c["weekdays"][day.weekday()]}
    exception = services["exceptions"].get(key, {})
    return (active | set(exception.get("add", []))) - set(exception.get("remove", []))


def validate_release(index, routes, previous, today):
    stops = platforms(index)
    if not stops or not routes or index["meta"].get("demo"):
        raise ValueError("empty or demo feed")
    for p in stops.values():
        if not (math.isfinite(p["lat"]) and math.isfinite(p["lon"])
                and 34 < p["lat"] < 37 and 138 < p["lon"] < 141):
            raise ValueError("invalid Tokyo stop coordinate")
        for r in p["routes"]:
            if r["route_file"] not in routes:
                raise ValueError("platform references a missing route")
    if previous:
        if len(stops) < len(platforms(previous)) * .9 or len(routes) < len(previous["routes"]) * .9:
            raise ValueError("over 10 percent stop/route loss; manual review required")
    active = [0] * 8
    trip_count = 0
    seen = set()
    for name, payload in routes.items():
        if index["routes"][payload["route"]["route_id"]]["route_file"] != name:
            raise ValueError("route identity mismatch")
        if not payload["trips"]:
            raise ValueError("route without trips")
        for shape in payload.get("shapes", {}).values():
            if any(not (-90 <= p[0] <= 90 and -180 <= p[1] <= 180) for p in shape):
                raise ValueError("invalid shape")
        service_days = [active_services(payload, today + timedelta(days=n)) for n in range(8)]
        for trip in payload["trips"]:
            if trip["trip_id"] in seen:
                raise ValueError("duplicate trip id")
            seen.add(trip["trip_id"])
            times = trip["stop_times"]
            if len(times) < 2:
                raise ValueError("trip without a usable stop sequence")
            last_seq, last_departure = -1, -1
            for sid, arrival, departure, seq in times:
                if sid not in payload["stops"] or arrival is None or departure is None:
                    raise ValueError("missing stop/time")
                if seq <= last_seq or arrival < last_departure or departure < arrival:
                    raise ValueError("invalid timetable order")
                last_seq, last_departure = seq, departure
            trip_count += 1
            for n, sids in enumerate(service_days):
                active[n] += trip["service_id"] in sids
    if min(active) == 0:
        raise ValueError("feed has no active trips on one of the next 8 days")
    return {"platforms": len(stops), "routes": len(routes), "trips": trip_count,
            "active_trips_next_8_days": active}


def immutable_routes(index, routes):
    mapping, result = {}, {}
    for old, payload in routes.items():
        payload = copy.deepcopy(payload)
        # Generation time must not force every route to be rewritten each morning.
        payload["meta"].pop("generated_at", None)
        payload["meta"]["versioning"] = "content-sha256"
        new = f"routes/route-{digest(payload)[:16]}.json"
        if new in result and result[new] != payload:
            raise ValueError("route hash collision")
        mapping[old], result[new] = new, payload
    for r in index["routes"].values():
        r["route_file"] = mapping[r["route_file"]]
    for p in platforms(index).values():
        for r in p["routes"]:
            r["route_file"] = mapping[r["route_file"]]
    return result


def refresh(source, output, now, baseline_path=None, audit=False):
    previous = load(output / "transit-index.json")
    old_status = load(output / "gtfs-status.json", {})
    if source.is_file():
        with zipfile.ZipFile(source) as archive:
            if sum(x.file_size for x in archive.infolist()) > 512 * 1024 * 1024:
                raise ValueError("expanded feed exceeds limit")
    index, routes = build_dataset(source, None, None, None)
    routes = immutable_routes(index, routes)
    counts = validate_release(index, routes, previous, now.astimezone(JST).date())
    checked_at = now.isoformat()
    info = next(read_csv(source, "feed_info.txt", required=False), {})
    semantic = copy.deepcopy(index)
    for key in ("generated_at", "source", "gtfs_revision", "source_version"):
        semantic["meta"].pop(key, None)
    revision = digest(semantic)
    changed = not previous or previous["meta"].get("gtfs_revision") != revision
    baseline = load(baseline_path, previous or index) if baseline_path else previous or index
    weekly = audit or now.astimezone(JST).weekday() == 0 or not old_status.get("weekly_audit")
    status = {"schema_version": 1, "status": "validated", "checked_at": checked_at,
              "data_updated_at": checked_at if changed else previous["meta"]["generated_at"],
              "revision": revision, "source_url": SOURCE_URL,
              "source_version": info.get("feed_version", "unknown"), "counts": counts,
              "changed": changed, "stop_changes": stop_audit(previous or index, index, checked_at),
              "weekly_audit": stop_audit(baseline, index, checked_at) if weekly else old_status["weekly_audit"]}
    # Only files explicitly recorded as generated by this updater can expire.
    retention = load(output / "gtfs-retention.json", {"generations": []})
    generations = retention["generations"]
    if any(not re.fullmatch(r"routes/route-[a-f0-9]{16}\.json", f)
           for g in generations for f in g["files"]):
        raise ValueError("invalid retention manifest path")
    managed = {f for g in generations for f in g["files"]}
    generations = [g for g in generations if g["revision"] != revision]
    generations.append({"revision": revision, "files": sorted(routes)})
    generations = generations[-8:]
    keep = {f for g in generations for f in g["files"]}
    expired = managed - keep
    route_size = sum(p.stat().st_size for p in (output / "routes").glob("*.json")
                     if str(p.relative_to(output)) not in expired)
    route_size += sum(len(encoded(v)) for f, v in routes.items() if not (output / f).exists())
    if route_size > 450 * 1024 * 1024:
        raise ValueError("retained route objects exceed 450 MiB; manual storage review required")
    status["retention"] = {"generations": len(generations), "expired_objects": len(expired),
                           "route_bytes": route_size, "legacy_files_preserved": True}
    # All validation completed before the first public file is changed. Index switches last.
    for relative, payload in routes.items():
        path = output / relative
        if path.exists():
            if load(path) != payload:
                raise ValueError("immutable route object collision")
    for relative, payload in routes.items():
        path = output / relative
        if not path.exists():
            atomic_json(path, payload)
    if changed:
        index["meta"].update(generated_at=checked_at, gtfs_revision=revision,
                              source_version=info.get("feed_version", "unknown"))
        atomic_json(output / "transit-index.json", index)
    atomic_json(output / "gtfs-status.json", status)
    atomic_json(output / "gtfs-retention.json", {"schema_version": 1, "generations": generations})
    for relative in sorted(expired):
        path = output / relative
        if path.exists():
            path.unlink()
    if weekly and baseline_path:
        atomic_json(baseline_path, index)
    return status


def download(path):
    request = urllib.request.Request(SOURCE_URL, headers={"User-Agent": "Tobus-GTFS-Refresh/1"})
    with urllib.request.urlopen(request, timeout=60) as response, path.open("wb") as handle:
        total = 0
        while chunk := response.read(1024 * 1024):
            total += len(chunk)
            if total > 32 * 1024 * 1024:
                raise ValueError("download exceeds limit")
            handle.write(chunk)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--audit-baseline", type=Path)
    parser.add_argument("--status-file", type=Path)
    parser.add_argument("--audit", action="store_true")
    args = parser.parse_args()
    now = datetime.now(timezone.utc)
    try:
        with tempfile.TemporaryDirectory(prefix="tobus-gtfs-") as temp:
            source = args.source or Path(temp) / "official.zip"
            if not args.source:
                download(source)
            status = refresh(source, args.output, now, args.audit_baseline, args.audit)
        if args.status_file:
            atomic_json(args.status_file, status)
        print(json.dumps(status, ensure_ascii=False))
        return 0
    except Exception as exc:
        # Do not publish failed validation or replace the last successful public status.
        status = {"status": "failed", "checked_at": now.isoformat(), "error_type": type(exc).__name__}
        if args.status_file:
            atomic_json(args.status_file, status)
        print(json.dumps(status), flush=True)
        print(str(exc), file=__import__("sys").stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
