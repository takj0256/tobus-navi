import json
import tempfile
import unittest
from pathlib import Path
import sys
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
from convert_gtfs import build_dataset, haversine_km  # noqa: E402


class ConverterTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name)
        (self.path / "stops.txt").write_text(
            "stop_id,stop_name,stop_lat,stop_lon,platform_code\n"
            "s1,試験駅前,35.0,139.0,1\n"
            "s2,遠方停留所,36.0,140.0,2\n", encoding="utf-8")
        (self.path / "routes.txt").write_text(
            "route_id,agency_id,route_short_name,route_long_name,route_type\n"
            "r1,a,都99,試験路線,3\n", encoding="utf-8")
        (self.path / "trips.txt").write_text(
            "route_id,service_id,trip_id,trip_headsign,direction_id\n"
            "r1,svc,t1,終点駅,0\n", encoding="utf-8")
        (self.path / "stop_times.txt").write_text(
            "trip_id,arrival_time,departure_time,stop_id,stop_sequence\n"
            "t1,10:00:00,10:00:00,s1,1\n", encoding="utf-8")

    def tearDown(self):
        self.temp.cleanup()

    def test_build_dataset(self):
        dataset = build_dataset(self.path, None, None, None)
        self.assertEqual(2, len(dataset["stops"]))
        stop = next(item for item in dataset["stops"] if item["stop_id"] == "s1")
        self.assertEqual("都99", stop["routes"][0]["route_name"])
        self.assertEqual("終点駅", stop["routes"][0]["headsign"])
        self.assertNotIn("direction_label", stop)
        self.assertEqual(2, dataset["meta"]["schema_version"])

    def test_area_filter(self):
        dataset = build_dataset(self.path, 35.0, 139.0, 2.0)
        self.assertEqual(["s1"], [item["stop_id"] for item in dataset["stops"]])


    def test_zip_input(self):
        archive_path = self.path / "sample.zip"
        with zipfile.ZipFile(archive_path, "w") as archive:
            for name in ("stops.txt", "routes.txt", "trips.txt", "stop_times.txt"):
                archive.write(self.path / name, arcname=name)
        dataset = build_dataset(archive_path, None, None, None)
        self.assertEqual(2, len(dataset["stops"]))
        self.assertEqual("GTFS-JP変換データ", dataset["meta"]["dataset_name"])

    def test_haversine(self):
        self.assertAlmostEqual(0.0, haversine_km(35, 139, 35, 139))
        self.assertGreater(haversine_km(35, 139, 36, 140), 100)


if __name__ == "__main__":
    unittest.main()
