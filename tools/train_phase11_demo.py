"""Offline proxy-label experiment. Never publishes or changes operational data."""
import argparse
import bisect
import collections
import datetime as dt
import hashlib
import json
import math
import os
from pathlib import Path
import shutil

# Small matrices are faster and less disruptive to the daily batch with one thread.
os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
import numpy as np

JST = dt.timezone(dt.timedelta(hours=9))
DAY = 86400000
FEATURES = ["baseline_seconds", "prior_mad", "log_prior_count", "hour_sin",
            "hour_cos", "weekday_sin", "weekday_cos", "weekend",
            "last_known_residual", "last_known_age_minutes", "last_known_missing"]
LIMITATIONS = [
    "目的変数は停留所切替前後の観測間隔。厳密な区間走行時間・実到着ではありません。",
    "過去データ再生の研究デモ。本番の予測ログや本番方式との比較ではありません。",
    "観測タイムスタンプを使用。受信時刻がなく、実配信遅延を再現できません。",
    "頻出区間の小規模標本です。全路線・季節・悪天候への汎化は未確認です。",
    "天候は予測時点の取得を証明できないため除外。GPS速度・時刻表・当日交通補正も未使用。",
    "次停留所以降への累積予測、LightGBM比較、本番組込みは未実装です。",
]


def local_time(ms):
    return dt.datetime.fromtimestamp(ms / 1000, JST)


def load_events(source, max_segments):
    files = sorted(Path(source).glob("????-??-??.json"))
    if len(files) < 12:
        raise ValueError("At least 12 daily-v2 files required")
    events, seen, counts, inputs = [], {}, collections.Counter(), []
    rejected, duplicates = 0, 0
    for i, file in enumerate(files):
        raw = file.read_bytes()
        payload = json.loads(raw)
        if payload.get("version") != 2 or payload.get("date_key") != file.stem:
            raise ValueError(f"Not daily-v2: {file.name}")
        inputs.append({"date": file.stem, "sha256": hashlib.sha256(raw).hexdigest()})
        group_keys = set()
        for group in payload["groups"]:
            segment = group["segment_key"]
            key = (segment, group["day_type"], group["time_bin"])
            if key in group_keys:
                raise ValueError(f"Duplicate group in {file.name}")
            group_keys.add(key)
            for sample in group["samples"]:
                seconds, end = sample[:2]
                if not all(isinstance(v, (int, float)) and math.isfinite(v) for v in [seconds, end]):
                    rejected += 1
                    continue
                if not 15 <= seconds <= 1800 or local_time(end).date().isoformat() != file.stem:
                    rejected += 1
                    continue
                identity = str(sample[5]) if len(sample) > 5 and sample[5] else json.dumps([segment, sample])
                value = (segment, float(end), float(seconds))
                if identity in seen:
                    if seen[identity] != value:
                        raise ValueError("Conflicting duplicate event")
                    duplicates += 1
                    continue
                seen[identity] = value
                events.append(value)
                if i < 4:  # Selection uses only warm-up days, never validation/test.
                    counts[segment] += 1
    selected = {k for k, _ in sorted(counts.items(), key=lambda x: (-x[1], x[0]))[:max_segments]}
    if not selected:
        raise ValueError("No valid warm-up observations")
    return sorted(e for e in events if e[0] in selected), inputs, {
        "rejected": rejected, "duplicates": duplicates, "selected_segments": len(selected),
        "selection_dates": [f.stem for f in files[:4]],
    }


def build_examples(events, warmup_end):
    """Predict at inferred previous observation; every history item ends strictly earlier."""
    grouped = collections.defaultdict(list)
    for segment, end, seconds in events:
        grouped[segment].append((end, seconds))
    rows = []
    for segment, samples in sorted(grouped.items()):
        samples.sort()
        ends = [s[0] for s in samples]
        # Daily baseline is frozen at midnight; test histories may update causally.
        cache = {}
        for end, seconds in samples:
            start = end - seconds * 1000
            clock = local_time(start)
            date = clock.date().isoformat()
            if date <= warmup_end:
                continue
            midnight = clock.replace(hour=0, minute=0, second=0, microsecond=0).timestamp() * 1000
            if date not in cache:
                lo = bisect.bisect_left(ends, midnight - 28 * DAY)
                hi = bisect.bisect_left(ends, midnight)
                history = [s[1] for s in samples[lo:hi]]
                if len(history) < 3:
                    cache[date] = None
                else:
                    base = float(np.median(history))
                    cache[date] = (base, float(np.median(np.abs(np.array(history) - base))), len(history))
            if cache[date] is None:
                continue
            base, mad, count = cache[date]
            prior = bisect.bisect_left(ends, start) - 1
            age = (start - ends[prior]) / 60000 if prior >= 0 else 180
            missing = prior < 0 or age > 120
            recent = 0 if missing else samples[prior][1] - base
            hour = clock.hour + clock.minute / 60
            weekday = clock.weekday()
            x = [base, mad, math.log1p(count), math.sin(hour * math.tau / 24),
                 math.cos(hour * math.tau / 24), math.sin(weekday * math.tau / 7),
                 math.cos(weekday * math.tau / 7), float(weekday >= 5),
                 max(-300, min(300, recent)), min(180, age), float(missing)]
            rows.append({"segment": segment, "date": date, "predicted_at": clock.isoformat(),
                         "observed_at": local_time(end).isoformat(), "features": x,
                         "baseline": base, "actual": seconds})
    return sorted(rows, key=lambda r: (r["predicted_at"], r["segment"], r["observed_at"]))


def split_rows(rows):
    dates = sorted({r["date"] for r in rows})
    if len(dates) < 8:
        raise ValueError("Insufficient dates after warm-up")
    train_end, val_end = int(len(dates) * .6), int(len(dates) * .8)
    partitions = [dates[:train_end], dates[train_end:val_end], dates[val_end:]]
    splits = [[r for r in rows if r["date"] in days] for days in partitions]
    # Purge labels that complete across a partition boundary.
    for i in (0, 1):
        boundary = partitions[i + 1][0] + "T00:00:00+09:00"
        splits[i] = [r for r in splits[i] if r["observed_at"] < boundary]
    if min(map(len, splits)) < 30:
        raise ValueError("Each split needs at least 30 observations")
    return splits, partitions


def forward(x, params):
    a = np.maximum(0, x @ params[0] + params[1])
    b = np.maximum(0, a @ params[2] + params[3])
    return (b @ params[4] + params[5]).ravel(), a, b


def predict(x, base, params):
    delta = np.clip(forward(x, params)[0] * 60, -120, 120)
    return np.clip(base + delta, 15, 1800)


def fit(train, validation, epochs=60, seed=11):
    rng = np.random.default_rng(seed)
    raw = np.array([r["features"] for r in train])
    mean, scale = raw.mean(axis=0), raw.std(axis=0)
    scale = np.maximum(scale, 1e-6)
    x = np.clip((raw - mean) / scale, -8, 8)
    vx = np.clip((np.array([r["features"] for r in validation]) - mean) / scale, -8, 8)
    base = np.array([r["baseline"] for r in train])
    actual = np.array([r["actual"] for r in train])
    target = (actual - base) / 60
    vb = np.array([r["baseline"] for r in validation])
    vy = np.array([r["actual"] for r in validation])
    params = [rng.normal(0, np.sqrt(2 / x.shape[1]), (x.shape[1], 32)), np.zeros(32),
              rng.normal(0, np.sqrt(2 / 32), (32, 16)), np.zeros(16),
              np.zeros((16, 1)), np.zeros(1)]
    m, v = [np.zeros_like(p) for p in params], [np.zeros_like(p) for p in params]
    best, best_loss, best_epoch, step = None, float("inf"), 0, 0
    history = []
    for epoch in range(1, epochs + 1):
        order = rng.permutation(len(x))
        for offset in range(0, len(x), 256):
            ids = order[offset:offset + 256]
            batch = x[ids]
            out, a, b = forward(batch, params)
            # Huber loss, threshold 30 seconds; robust to long observation gaps.
            grad = (np.clip(out - target[ids], -.5, .5) / len(ids))[:, None]
            gb = (grad @ params[4].T) * (b > 0)
            ga = (gb @ params[2].T) * (a > 0)
            grads = [batch.T @ ga, ga.sum(0), a.T @ gb, gb.sum(0), b.T @ grad, grad.sum(0)]
            step += 1
            for j, g in enumerate(grads):
                g = np.clip(g, -5, 5)
                m[j] = .9 * m[j] + .1 * g
                v[j] = .999 * v[j] + .001 * g * g
                params[j] -= .001 * (m[j] / (1 - .9 ** step)) / (np.sqrt(v[j] / (1 - .999 ** step)) + 1e-8)
        loss = float(np.mean(np.abs(predict(vx, vb, params) - vy)))
        history.append({"epoch": epoch, "validation_mae": loss})
        if loss < best_loss:
            best, best_loss, best_epoch = [p.copy() for p in params], loss, epoch
        if epoch - best_epoch >= 12:
            break
    return best, mean, scale, history, best_epoch


def metrics(actual, predicted):
    error = np.abs(np.asarray(actual) - np.asarray(predicted))
    return {"count": len(error), "mae": float(error.mean()), "p90": float(np.percentile(error, 90)),
            **{f"within_{s}": float((error <= s).mean()) for s in (15, 30, 60)}}


def run(source, output, max_segments=64, epochs=60, seed=11):
    output = Path(output)
    if output.exists() and any(output.iterdir()):
        raise ValueError("Output must be absent or empty; do not overwrite earlier experiments")
    events, inputs, audit = load_events(source, max_segments)
    rows = build_examples(events, audit["selection_dates"][-1])
    (train, validation, test), dates = split_rows(rows)
    params, mean, scale, history, epoch = fit(train, validation, epochs, seed)
    model = {"version": 1, "candidate_only": True, "target": "stop_transition_observation_interval",
             "features": FEATURES, "mean": mean.tolist(), "scale": scale.tolist(),
             "params": [p.tolist() for p in params], "residual_scale": 60, "residual_limit": 120,
             "prediction_min": 15, "prediction_max": 1800}
    evaluations = {}
    test_predictions = None
    for name, split in zip(["train", "validation", "test"], [train, validation, test]):
        x = np.clip((np.array([r["features"] for r in split]) - mean) / scale, -8, 8)
        base, actual = [r["baseline"] for r in split], [r["actual"] for r in split]
        predicted = predict(x, np.array(base), params)
        evaluations[name] = {"baseline": metrics(actual, base), "mlp": metrics(actual, predicted)}
        if name == "test":
            test_predictions = predicted
    examples = []
    for i in np.linspace(0, len(test) - 1, min(100, len(test)), dtype=int):
        examples.append({**test[i], "prediction": float(test_predictions[i])})
    report = {"version": 1, "candidate_only": True, "generated_at": dt.datetime.now(JST).isoformat(),
              "architecture": [len(FEATURES), 32, 16, 1], "parameters": sum(p.size for p in params),
              "seed": seed, "numpy_version": np.__version__, "source_inputs": inputs, "audit": audit,
              "split_dates": dict(zip(["train", "validation", "test"], dates)), "metrics": evaluations,
              "best_epoch": epoch, "history": history, "limitations": LIMITATIONS,
              "baseline": "区間別・当日開始より前の28日中央値（デモ専用。本番方式とは異なる）",
              "evaluation": "時系列分割。重み・正規化はtest前に固定。履歴特徴のみ観測済み実績で逐次更新。"}
    output.mkdir(parents=True, exist_ok=True)
    for name, value in [("model.json", model), ("report.json", report), ("examples.json", examples)]:
        (output / name).write_text(json.dumps(value, ensure_ascii=False, allow_nan=False), encoding="utf-8")
    for file in (Path(__file__).parent / "phase11-ml-demo-ui").iterdir():
        shutil.copyfile(file, output / file.name)
    print(json.dumps({"output": str(output), "parameters": report["parameters"],
                      "best_epoch": epoch, "test": evaluations["test"]}, ensure_ascii=False))
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", help="Local daily-v2 directory (read only)")
    parser.add_argument("output", help="New local experiment directory")
    parser.add_argument("--segments", type=int, default=64)
    parser.add_argument("--epochs", type=int, default=60)
    parser.add_argument("--seed", type=int, default=11)
    args = parser.parse_args()
    if not 1 <= args.segments <= 256 or not 1 <= args.epochs <= 200:
        parser.error("segments must be 1..256 and epochs 1..200")
    run(args.input, args.output, args.segments, args.epochs, args.seed)
