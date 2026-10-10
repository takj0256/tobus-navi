import os
import subprocess
import tempfile
import unittest
from pathlib import Path


class ScheduleTest(unittest.TestCase):
    def run_case(self, code=0, succeeded=False, refresh_code=0, nvm_missing=False):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "app/tools").mkdir(parents=True)
            (root / "gtfs-refresh").mkdir()
            (root / "nvm").mkdir()
            if not nvm_missing:
                (root / "nvm/nvm.sh").write_text(":\n")
            (root / "gtfs-refresh/enabled").touch()
            (root / "app/tools/run_phase11_local_aggregation.sh").write_text(f"exit {code}\n")
            (root / "gtfs-refresh/run_gtfs_refresh.sh").write_text(
                'flock -n "$1/../aggregation.lock" true || exit 99\n'
                'touch "$1/executed"\n' + f'exit {refresh_code}\n')
            if succeeded:
                day = subprocess.check_output(["date", "+%F"], env={**os.environ, "TZ": "Asia/Tokyo"}, text=True).strip()
                (root / "aggregation-success-date").write_text(day)
            result = subprocess.run(["bash", "tools/run_phase11_scheduled.sh", str(root)],
                                    env={**os.environ, "NVM_DIR": str(root / "nvm")})
            return result.returncode, (root / "gtfs-refresh/executed").exists(), (root / "aggregation-success-date").exists()

    def test_after_success_releases_lock(self):
        self.assertEqual(self.run_case(), (0, True, True))

    def test_failure_keeps_aggregation_result(self):
        self.assertEqual(self.run_case(code=7), (7, True, False))

    def test_gtfs_failure_does_not_change_aggregation_success(self):
        self.assertEqual(self.run_case(refresh_code=3), (0, True, True))

    def test_success_guard_still_retries_unfinished_gtfs(self):
        self.assertEqual(self.run_case(code=7, succeeded=True), (0, True, True))

    def test_early_environment_failure_still_refreshes(self):
        self.assertEqual(self.run_case(nvm_missing=True), (1, True, False))
