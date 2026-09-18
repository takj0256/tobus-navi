import importlib.util
import tempfile
import unittest
from pathlib import Path

import numpy as np

spec = importlib.util.spec_from_file_location("demo", Path(__file__).parents[1] / "tools/train_phase11_demo.py")
demo = importlib.util.module_from_spec(spec)
spec.loader.exec_module(demo)


class DemoTests(unittest.TestCase):
    def test_features_do_not_use_own_or_future_labels(self):
        start = demo.dt.datetime(2026, 8, 1, tzinfo=demo.JST).timestamp() * 1000
        events = [("s", start + i * demo.DAY + 3600000, 60) for i in range(6)]
        rows = demo.build_examples(events, "2026-08-04")
        # Alter a later completion; earlier examples stay exactly identical.
        changed = demo.build_examples(events + [("s", start + 7 * demo.DAY, 1700)], "2026-08-04")
        self.assertEqual(rows, changed[:len(rows)])
        self.assertEqual(rows[0]["baseline"], 60)
        self.assertEqual(rows[0]["features"][10], 1)  # Yesterday's event is stale.

    def test_recent_event_must_finish_before_prediction(self):
        start = demo.dt.datetime(2026, 8, 5, 12, tzinfo=demo.JST).timestamp() * 1000
        history = [("s", start - i * demo.DAY, 60) for i in (1, 2, 3)]
        events = history + [("s", start - 10000, 80), ("s", start + 10000, 1700), ("s", start + 60000, 60)]
        row = next(r for r in demo.build_examples(events, "2026-08-04") if r["actual"] == 60)
        self.assertEqual(row["features"][8], 20)  # Not future 1700, not target 60.

    def test_split_has_no_future_training_labels(self):
        rows = [{"date": f"2026-08-{day:02}", "observed_at": f"2026-08-{day:02}T12:00:00+09:00"}
                for day in range(1, 16) for _ in range(30)]
        splits, dates = demo.split_rows(rows)
        self.assertLess(max(r["observed_at"] for r in splits[0]), dates[1][0])
        self.assertLess(max(r["observed_at"] for r in splits[1]), dates[2][0])
        self.assertFalse(set(dates[0]) & set(dates[2]))

    def test_network_really_learns_and_is_reproducible(self):
        rows = [{"features": [float(i % 10), float(i % 3)], "baseline": 60., "actual": 90.} for i in range(300)]
        p, mean, scale, history, epoch = demo.fit(rows, rows, epochs=25)
        x = np.clip((np.array([r["features"] for r in rows]) - mean) / scale, -8, 8)
        result = demo.predict(x, np.full(len(rows), 60), p)
        self.assertLess(np.mean(np.abs(result - 90)), 15)
        again = demo.fit(rows, rows, epochs=25)
        for a, b in zip(p, again[0]):
            np.testing.assert_array_equal(a, b)

    def test_metrics_and_output_protection(self):
        result = demo.metrics([10, 20], [10, 40])
        self.assertEqual(result["mae"], 10)
        self.assertEqual(result["within_15"], .5)
        with tempfile.TemporaryDirectory() as folder:
            Path(folder, "keep.txt").write_text("keep")
            with self.assertRaisesRegex(ValueError, "Output must"):
                demo.run("missing", folder)
            self.assertEqual(Path(folder, "keep.txt").read_text(), "keep")


if __name__ == "__main__":
    unittest.main()
