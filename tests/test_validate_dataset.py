import json
import tempfile
import unittest
from pathlib import Path

from tools.validate_dataset import validate_dataset_file


class ValidateDatasetTest(unittest.TestCase):
    def make_dataset(self, *, demo=False, schema=4, groups=True, route_file=True):
        temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(temp_dir.cleanup)
        root = Path(temp_dir.name)
        route_relative = "routes/route-test.json"
        payload = {
            "meta": {"demo": demo, "schema_version": schema, "generated_at": "2026-07-19T00:00:00+00:00"},
            "stop_groups": [{"group_id": "g", "platforms": [{"stop_id": "s"}]}] if groups else [],
            "routes": {"r": {"route_id": "r", "route_file": route_relative}},
        }
        path = root / "transit-index.json"
        path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        if route_file:
            (root / "routes").mkdir()
            (root / route_relative).write_text("{}", encoding="utf-8")
        return path

    def test_accepts_production_dataset(self):
        self.assertEqual(validate_dataset_file(self.make_dataset())[:3], (1, 1, 1))

    def test_rejects_demo_dataset(self):
        with self.assertRaisesRegex(ValueError, "デモデータ"):
            validate_dataset_file(self.make_dataset(demo=True))

    def test_rejects_old_schema(self):
        with self.assertRaisesRegex(ValueError, "旧形式"):
            validate_dataset_file(self.make_dataset(schema=2))

    def test_rejects_missing_route_file(self):
        with self.assertRaisesRegex(ValueError, "不足"):
            validate_dataset_file(self.make_dataset(route_file=False))


if __name__ == "__main__":
    unittest.main()
