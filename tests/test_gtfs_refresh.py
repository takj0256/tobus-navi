import copy
import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

from tools.convert_gtfs import build_dataset
from tools.refresh_gtfs import immutable_routes, refresh, stop_audit, validate_release
import test_converter


class RefreshTest(unittest.TestCase):
    def setUp(self):
        self.fixture = test_converter.ConverterTest()
        self.fixture.setUp()
        self.addCleanup(self.fixture.tearDown)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.out = Path(self.temp.name) / "data"
        self.now = datetime(2026, 10, 11, tzinfo=timezone.utc)

    def test_refresh_and_unchanged_content_keep_index_and_routes(self):
        a = refresh(self.fixture.path, self.out, self.now)
        before = (self.out / "transit-index.json").read_bytes()
        routes = list((self.out / "routes").glob("*.json"))
        b = refresh(self.fixture.path, self.out, self.now.replace(day=12))
        self.assertTrue(a["changed"])
        self.assertFalse(b["changed"])
        self.assertEqual(before, (self.out / "transit-index.json").read_bytes())
        self.assertEqual(routes, list((self.out / "routes").glob("*.json")))
        self.assertEqual(3, b["weekly_audit"]["platforms_checked"])

    def test_failure_preserves_last_good_files(self):
        refresh(self.fixture.path, self.out, self.now)
        before = {str(p): p.read_bytes() for p in self.out.rglob("*.json")}
        (self.fixture.path / "calendar.txt").write_text("service_id,start_date,end_date\n", encoding="utf-8")
        with self.assertRaises(ValueError):
            refresh(self.fixture.path, self.out, self.now)
        self.assertEqual(before, {str(p): p.read_bytes() for p in self.out.rglob("*.json")})

    def test_new_version_retains_previous_route_urls(self):
        refresh(self.fixture.path, self.out, self.now)
        old = list((self.out / "routes").glob("*.json"))[0]
        stops = self.fixture.path / "stops.txt"
        stops.write_text(stops.read_text().replace("35.01,139.01", "35.011,139.011"))
        result = refresh(self.fixture.path, self.out, self.now)
        self.assertTrue(old.exists())
        self.assertEqual(2, len(list((self.out / "routes").glob("*.json"))))
        self.assertEqual("s3", result["stop_changes"]["moved"][0]["stop_id"])

    def test_weekly_audit_uses_saved_baseline(self):
        baseline = Path(self.temp.name) / "baseline.json"
        refresh(self.fixture.path, self.out, self.now, baseline)
        stops = self.fixture.path / "stops.txt"
        stops.write_text(stops.read_text().replace("35.01,139.01", "35.011,139.011"))
        refresh(self.fixture.path, self.out, self.now, baseline)
        result = refresh(self.fixture.path, self.out, self.now.replace(day=12), baseline)
        self.assertEqual(1, len(result["weekly_audit"]["moved"]))
        self.assertFalse(result["weekly_audit"]["historical_ids_remapped"])

    def test_rejects_invalid_order_and_coordinate_and_drop(self):
        index, routes = build_dataset(self.fixture.path, None, None, None)
        routes = immutable_routes(index, routes)
        bad = copy.deepcopy(routes)
        next(iter(bad.values()))["trips"][0]["stop_times"][1][1] = 1
        with self.assertRaisesRegex(ValueError, "order"):
            validate_release(index, bad, None, self.now.date())
        old = copy.deepcopy(index)
        old["routes"].update({"fake1": {}, "fake2": {}})
        with self.assertRaisesRegex(ValueError, "loss"):
            validate_release(index, routes, old, self.now.date())
        index["stop_groups"][0]["platforms"][0]["lat"] = float("nan")
        with self.assertRaisesRegex(ValueError, "coordinate"):
            validate_release(index, routes, None, self.now.date())

    def test_immutable_collision_does_not_switch_index(self):
        refresh(self.fixture.path, self.out, self.now)
        index = (self.out / "transit-index.json").read_bytes()
        route = next((self.out / "routes").glob("*.json"))
        route.write_text("{}")
        with self.assertRaisesRegex(ValueError, "collision"):
            refresh(self.fixture.path, self.out, self.now)
        self.assertEqual(index, (self.out / "transit-index.json").read_bytes())

    def test_retention_only_expires_managed_generations(self):
        self.out.mkdir()
        (self.out / "routes").mkdir()
        legacy = self.out / "routes/route-0000000000000000.json"
        legacy.write_text("{}")
        stops = self.fixture.path / "stops.txt"
        original = stops.read_text()
        for n in range(10):
            stops.write_text(original.replace("35.01,139.01", f"35.0{100+n},139.01"))
            refresh(self.fixture.path, self.out, self.now)
        self.assertTrue(legacy.exists())
        self.assertEqual(9, len(list((self.out / "routes").glob("*.json"))))
        self.assertEqual(8, len(json.loads((self.out / "gtfs-retention.json").read_text())["generations"]))

    def test_retention_rejects_untrusted_paths_before_writes(self):
        refresh(self.fixture.path, self.out, self.now)
        (self.out / "gtfs-retention.json").write_text(json.dumps({"generations": [{"revision": "x", "files": ["../other.json"]}]}))
        before = (self.out / "gtfs-status.json").read_bytes()
        with self.assertRaisesRegex(ValueError, "path"):
            refresh(self.fixture.path, self.out, self.now)
        self.assertEqual(before, (self.out / "gtfs-status.json").read_bytes())


if __name__ == "__main__":
    unittest.main()
