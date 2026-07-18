import tempfile
import unittest
from pathlib import Path
import sys
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
from convert_gtfs import build_dataset, haversine_km, normalize_platform_label, parse_gtfs_time, platform_sort_key  # noqa: E402


class ConverterTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name)
        (self.path / "stops.txt").write_text(
            "stop_id,stop_name,stop_lat,stop_lon,platform_code,location_type,parent_station\n"
            "p1,試験駅前,35.0,139.0,,1,\n"
            "s1,1,35.0,139.0,,0,p1\n"
            "s2,2,35.0002,139.0002,,0,p1\n"
            "s3,終点駅,35.01,139.01,,0,\n", encoding="utf-8")
        (self.path / "routes.txt").write_text(
            "route_id,agency_id,route_short_name,route_long_name,route_type\n"
            "r1,a,都99,試験路線,3\n", encoding="utf-8")
        (self.path / "trips.txt").write_text(
            "route_id,service_id,trip_id,trip_headsign,direction_id,shape_id\n"
            "r1,svc,t1,終点駅,0,\n"
            "r1,svc,t2,試験駅前,1,\n", encoding="utf-8")
        (self.path / "stop_times.txt").write_text(
            "trip_id,arrival_time,departure_time,stop_id,stop_sequence\n"
            "t1,10:00:00,10:00:00,s1,1\n"
            "t1,10:10:00,10:10:00,s3,2\n"
            "t2,11:00:00,11:00:00,s2,1\n"
            "t2,11:10:00,11:10:00,s3,2\n", encoding="utf-8")
        (self.path / "calendar.txt").write_text(
            "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n"
            "svc,1,1,1,1,1,1,1,20260101,20261231\n", encoding="utf-8")

    def tearDown(self):
        self.temp.cleanup()

    def test_build_dataset_groups_same_stop_name(self):
        index, route_files = build_dataset(self.path, None, None, None)
        group = next(item for item in index["stop_groups"] if item["stop_name"] == "試験駅前")
        self.assertEqual(2, len(group["platforms"]))
        self.assertEqual({"s1", "s2"}, {item["stop_id"] for item in group["platforms"]})
        self.assertEqual(5, index["meta"]["schema_version"])
        self.assertEqual({"1番のりば", "2番のりば"}, {item["platform_code"] for item in group["platforms"]})
        self.assertEqual({"試験駅前"}, {item["stop_name"] for item in group["platforms"]})
        self.assertEqual(1, len(route_files))

    def test_far_same_name_stops_are_separate_groups(self):
        with (self.path / "stops.txt").open("a", encoding="utf-8") as handle:
            handle.write("s4,試験駅前,36.0,140.0,遠方のりば,0,\n")
        index, _ = build_dataset(self.path, None, None, None)
        matching = [group for group in index["stop_groups"] if group["stop_name"] == "試験駅前"]
        self.assertEqual(2, len(matching))
        self.assertEqual(sorted([1, 2]), sorted(len(group["platforms"]) for group in matching))

    def test_parent_station_name_replaces_numeric_child_name(self):
        index, route_files = build_dataset(self.path, None, None, None)
        group = next(item for item in index["stop_groups"] if item["stop_name"] == "試験駅前")
        self.assertEqual({"1", "2"}, {item["raw_stop_name"] for item in group["platforms"]})
        route_file = index["routes"]["r1"]["route_file"]
        route_stops = route_files[route_file]["stops"]
        self.assertEqual("試験駅前", route_stops["s1"]["stop_name"])
        self.assertEqual("1番のりば", route_stops["s1"]["platform_code"])

    def test_platform_label_normalization(self):
        self.assertEqual("3番のりば", normalize_platform_label("3", "", ""))
        self.assertEqual("4番のりば", normalize_platform_label("", "4", "錦糸町駅前"))
        self.assertEqual("北口", normalize_platform_label("北口", "", ""))

    def test_platform_sort_uses_numeric_order(self):
        platforms = [
            {"platform_code": "10番のりば", "stop_id": "s10"},
            {"platform_code": "2番のりば", "stop_id": "s2"},
            {"platform_code": "1番のりば", "stop_id": "s1"},
        ]
        self.assertEqual(
            ["1番のりば", "2番のりば", "10番のりば"],
            [item["platform_code"] for item in sorted(platforms, key=platform_sort_key)],
        )

    def test_route_file_contains_timetable(self):
        index, route_files = build_dataset(self.path, None, None, None)
        route_file = index["routes"]["r1"]["route_file"]
        route_data = route_files[route_file]
        self.assertEqual(2, len(route_data["trips"]))
        self.assertEqual(36000, route_data["trips"][0]["stop_times"][0][1])
        self.assertIn("svc", route_data["services"]["calendars"])

    def test_area_filter(self):
        index, _ = build_dataset(self.path, 35.0, 139.0, 0.2)
        groups = index["stop_groups"]
        self.assertEqual(["試験駅前"], [group["stop_name"] for group in groups])
        self.assertEqual(2, len(groups[0]["platforms"]))

    def test_zip_input(self):
        archive_path = self.path / "sample.zip"
        with zipfile.ZipFile(archive_path, "w") as archive:
            for name in ("stops.txt", "routes.txt", "trips.txt", "stop_times.txt", "calendar.txt"):
                archive.write(self.path / name, arcname=name)
        index, route_files = build_dataset(archive_path, None, None, None)
        self.assertEqual(2, len(index["stop_groups"]))
        self.assertEqual(1, len(route_files))

    def test_time_parser_supports_after_midnight(self):
        self.assertEqual(25 * 3600 + 30 * 60, parse_gtfs_time("25:30:00"))

    def test_haversine(self):
        self.assertAlmostEqual(0.0, haversine_km(35, 139, 35, 139))
        self.assertGreater(haversine_km(35, 139, 36, 140), 100)


if __name__ == "__main__":
    unittest.main()
