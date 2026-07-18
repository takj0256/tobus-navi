import json
import tempfile
import unittest
from pathlib import Path

from tools.validate_dataset import validate_dataset_file


class ValidateDatasetTest(unittest.TestCase):
    def write_dataset(self, payload):
        temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(temp_dir.cleanup)
        path = Path(temp_dir.name) / "stops.json"
        path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        return path

    def test_accepts_production_dataset(self):
        path = self.write_dataset({
            "meta": {"demo": False, "generated_at": "2026-07-19T00:00:00+00:00"},
            "stops": [{"stop_id": "1"}],
        })
        self.assertEqual(validate_dataset_file(path)[0], 1)

    def test_rejects_demo_dataset(self):
        path = self.write_dataset({"meta": {"demo": True}, "stops": [{"stop_id": "1"}]})
        with self.assertRaisesRegex(ValueError, "デモデータ"):
            validate_dataset_file(path)

    def test_rejects_empty_dataset(self):
        path = self.write_dataset({"meta": {"demo": False}, "stops": []})
        with self.assertRaisesRegex(ValueError, "空です"):
            validate_dataset_file(path)


if __name__ == "__main__":
    unittest.main()
