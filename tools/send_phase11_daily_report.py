#!/usr/bin/env python3
"""Send the Phase 11 daily aggregation report without depending on Codex."""

from __future__ import annotations

import argparse
import json
import os
import smtplib
import subprocess
from datetime import datetime
from email.message import EmailMessage
from pathlib import Path
from zoneinfo import ZoneInfo


TOKYO = ZoneInfo("Asia/Tokyo")


def query_status(project_dir: Path) -> list[dict]:
    sql = " ".join([
        "SELECT * FROM job_status WHERE job_name='profile-aggregation';",
        "SELECT COUNT(*) AS profiles, ROUND(AVG(confidence),3) AS avg_confidence,",
        "ROUND(MAX(confidence),3) AS max_confidence, MAX(sample_count) AS max_samples,",
        "MIN(generated_at) AS generated_at FROM profiles;",
        "SELECT COUNT(*) AS weather_profiles, ROUND(AVG(confidence),3) AS avg_weather_confidence,",
        "ROUND(MAX(confidence),3) AS max_weather_confidence, MAX(sample_count) AS max_weather_samples,",
        "MIN(generated_at) AS generated_at FROM weather_profiles;",
    ])
    completed = subprocess.run(
        [
            "npx", "wrangler@latest", "d1", "execute", "tobus-phase11", "--remote", "--yes",
            "--json", f"--command={sql}", "--config", str(project_dir / "worker" / "wrangler.toml"),
        ],
        cwd=project_dir,
        text=True,
        capture_output=True,
        check=False,
        timeout=120,
    )
    if completed.returncode != 0:
        raise RuntimeError(completed.stderr.strip() or completed.stdout.strip() or "D1 query failed")
    return json.loads(completed.stdout)


def first_row(results: list[dict], index: int) -> dict:
    rows = results[index].get("results", []) if index < len(results) else []
    return rows[0] if rows else {}


def tokyo_time(value: str | None) -> datetime | None:
    if not value:
        return None
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(TOKYO)


def build_report(results: list[dict], now: datetime) -> tuple[str, str]:
    job = first_row(results, 0)
    profiles = first_row(results, 1)
    weather = first_row(results, 2)
    completed_at = tokyo_time(job.get("completed_at"))
    fresh = bool(completed_at and completed_at.date() == now.date() and completed_at.hour >= 4)
    successful = job.get("status") == "complete" and not job.get("error") and fresh
    verdict = "正常" if successful else "要確認"
    subject = (f"【都バスPhase 11】日次集計 正常 {now:%Y-%m-%d}" if successful
               else f"【要確認・都バスPhase 11】日次集計 {now:%Y-%m-%d}")
    concerns: list[str] = []
    if job.get("status") != "complete":
        concerns.append(f"job_status={job.get('status') or '不明'}")
    if not fresh:
        concerns.append("本日04:00以降の完了記録がありません")
    if job.get("error"):
        concerns.append(str(job["error"]))
    body = "\n".join([
        f"総合判定：{verdict}",
        "",
        f"確認時刻：{now:%Y-%m-%d %H:%M:%S} JST",
        f"最終ジョブ終了：{completed_at:%Y-%m-%d %H:%M:%S JST}" if completed_at else "最終ジョブ終了：不明",
        f"job_status：{job.get('status') or '不明'}",
        f"sourceObjects：{job.get('source_objects', 0)}",
        f"profiles：{profiles.get('profiles', 0)}",
        f"平均信頼度：{profiles.get('avg_confidence', '不明')}",
        f"最大信頼度：{profiles.get('max_confidence', '不明')}",
        f"最大sample_count：{profiles.get('max_samples', '不明')}",
        f"weather_profiles：{weather.get('weather_profiles', 0)}",
        f"天気プロファイル平均信頼度：{weather.get('avg_weather_confidence', '不明')}",
        "",
        "懸念事項：" if concerns else "懸念事項：なし",
        *(f"- {item}" for item in concerns),
    ])
    return subject, body


def send_email(subject: str, body: str) -> None:
    user = os.environ.get("PHASE11_GMAIL_USER", "").strip()
    password = os.environ.get("PHASE11_GMAIL_APP_PASSWORD", "").replace(" ", "")
    recipient = os.environ.get("PHASE11_REPORT_TO", "tatatakakaka1009@gmail.com").strip()
    if not user or not password:
        raise RuntimeError("PHASE11_GMAIL_USERまたはPHASE11_GMAIL_APP_PASSWORDが未設定です")
    message = EmailMessage()
    message["From"] = user
    message["To"] = recipient
    message["Subject"] = subject
    message.set_content(body)
    with smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=30) as smtp:
        smtp.login(user, password)
        smtp.send_message(message)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true", help="メールを送らず本文だけ表示")
    parser.add_argument("--project-dir", type=Path, default=Path(__file__).resolve().parent.parent)
    args = parser.parse_args()
    now = datetime.now(TOKYO)
    try:
        subject, body = build_report(query_status(args.project_dir), now)
    except Exception as error:  # D1自体が落ちた場合もメールへ載せる
        subject = f"【要確認・都バスPhase 11】日次集計 {now:%Y-%m-%d}"
        body = f"総合判定：失敗\n\n確認時刻：{now:%Y-%m-%d %H:%M:%S} JST\nD1状態取得エラー：{error}"
    if args.dry_run:
        print(subject)
        print()
        print(body)
        return 0
    send_email(subject, body)
    print(f"sent: {subject}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
