"""Offline MLP candidates for missing durations and next-stop observation ETA.

No operational reads/writes, no synthetic labels used for training.
"""
import argparse
import bisect
import collections
import datetime as dt
import hashlib
import json
import math
from pathlib import Path
import shutil
import numpy as np
from train_phase11_demo import fit, predict, metrics, local_time

FEATURES = ['baseline', 'cumulative_median', 'recent_28d_median', 'today_median',
            'mad', 'log_count', 'hour_sin', 'hour_cos', 'weekday_sin', 'weekday_cos',
            'elapsed_seconds', 'last_duration', 'last_age_minutes', 'gap_minutes']
LIMITATIONS = [
    '実到着ではなく次停留所の初回観測。STOPPED_ATのない配信から実到着を確定しない。',
    'raw予定分末とfeed時刻による再生時計。実受信時刻/配信遅延は再現できない。',
    '本番方式との比較ではなく累積/直近28日/当日中央値の研究用基準との比較。',
    '季節・天候・交通・複数停留所先は未対応。少数日の結果で本番採用しない。',
    '補完は所要時間のみ。欠けた便の存在・車両数・座標や事故を生成しない。',
    '不確実性幅は別の検証標本の残差分位。未観測条件での保証確率ではない。',
]


def day(ms):
    return local_time(ms).date().isoformat()


def partition(events):
    dates = sorted({day(e['started_at']) for e in events})
    if len(dates) < 6:
        raise ValueError('At least six observed days needed')
    a, b = len(dates) - 3, len(dates) - 2
    return dates[:a], dates[a:b], dates[b:]


def make_rows(events, selected, task, gap=None):
    grouped = collections.defaultdict(list)
    for e in events:
        if e['segment'] in selected:
            grouped[e['segment']].append(e)
    rows = []
    for segment, values in grouped.items():
        history = sorted(values, key=lambda e: e['known_at'])
        known = [e['known_at'] for e in history]
        for i, event in enumerate(sorted(values, key=lambda e: e['started_at'])):
            queries = event['queries'] if task == 'eta' else [{'available': event['started_at'], 't': event['started_at']}]
            for point in queries:
                at = point['available']
                if task == 'imputation':
                    missing = gap if gap is not None else [1, 10, 40][i % 3]
                    # A synthetic outage begins each clock hour. All its hidden labels
                    # are excluded from history, not just the row being evaluated.
                    cutoff = at // 3600000 * 3600000
                    if (at - cutoff) >= missing * 60000:
                        continue
                else:
                    missing, cutoff = 0, at
                eligible = history[:bisect.bisect_left(known, cutoff)]
                if len(eligible) < 3:
                    continue
                seconds = np.array([e['seconds'] for e in eligible])
                cumulative = float(np.median(seconds))
                recent = [e['seconds'] for e in eligible if e['known_at'] >= at - 28 * 86400000]
                recent_base = float(np.median(recent)) if recent else cumulative
                today = [e['seconds'] for e in eligible if day(e['known_at']) == day(at)]
                today_base = float(np.median(today)) if len(today) >= 3 else recent_base
                duration = .5 * cumulative + .3 * recent_base + .2 * today_base
                elapsed = (at - event['started_at']) / 1000 if task == 'eta' else 0
                base = max(15, duration - elapsed)
                actual = (event['ended_at'] - at) / 1000 if task == 'eta' else event['seconds']
                if not 15 <= actual <= 1800:
                    continue
                clock = local_time(at)
                hour = clock.hour + clock.minute / 60
                weekday = clock.weekday()
                features = [base, cumulative, recent_base, today_base,
                            float(np.median(np.abs(seconds - cumulative))), math.log1p(len(eligible)),
                            math.sin(hour * math.tau / 24), math.cos(hour * math.tau / 24),
                            math.sin(weekday * math.tau / 7), math.cos(weekday * math.tau / 7),
                            elapsed, eligible[-1]['seconds'], min(2880, (at-known[len(eligible)-1])/60000), missing]
                rows.append({'date': day(at), 'at': at, 'known_at': event['known_at'],
                             'segment': segment, 'baseline': base, 'actual': actual, 'features': features,
                             'history_latest': eligible[-1]['known_at'], 'cutoff': cutoff,
                             'label_width_seconds': (event['crossing_upper']-event['crossing_lower'])/1000})
    return sorted(rows, key=lambda r: (r['at'], r['segment']))


def infer(rows, model):
    x = np.clip((np.array([r['features'] for r in rows])-np.array(model['mean'])) / np.array(model['scale']), -8, 8)
    return predict(x, np.array([r['baseline'] for r in rows]), [np.array(p) for p in model['params']])


def evaluate(rows, prediction):
    return {'baseline': metrics([r['actual'] for r in rows], [r['baseline'] for r in rows]),
            'mlp': metrics([r['actual'] for r in rows], prediction)}


def validate_events(payload):
    if payload.get('version') != 2 or payload.get('target') != 'next_stop_first_observed':
        raise ValueError('Requires versioned observation-arrival labels')
    events, seen = [], set()
    for e in payload['segments']:
        if e.get('provenance') != 'observed':
            raise ValueError('Synthetic labels cannot train this model')
        key = (e['segment'], e['started_at'], e['ended_at'])
        if key in seen:
            raise ValueError('Duplicate label')
        seen.add(key)
        if not (e['started_at'] < e['ended_at'] <= e['known_at']
                and 0 <= e['crossing_upper'] - e['crossing_lower'] <= 120000
                and abs(e['seconds'] * 1000 - e['ended_at'] + e['started_at']) < 1):
            raise ValueError('Invalid time bounds')
        events.append(e)
    return events


def run(source, output, segments=24, epochs=35):
    output = Path(output)
    if output.exists():
        raise ValueError('Use a new output directory')
    raw = Path(source).read_bytes()
    payload = json.loads(raw)
    events = validate_events(payload)
    dates = partition(events)
    boundaries = [dt.datetime.fromisoformat(d[0]+'T00:00:00+09:00').timestamp()*1000 for d in dates]
    # Destination lookup is learned only on train, never inferred from a test label.
    training_events = [e for e in events if e['known_at'] < boundaries[1]]
    topology = collections.defaultdict(set)
    for e in training_events:
        topology[(e['route'], e['direction'], e['from_sequence'], e['from_stop'])].add(e['to_stop'])
    valid = [e for e in training_events if len(topology[(e['route'], e['direction'], e['from_sequence'], e['from_stop'])]) == 1]
    selected = {s for s, n in collections.Counter(e['segment'] for e in valid).most_common(segments) if n >= 10}
    if not selected:
        raise ValueError('No stable observed training segments')
    report = {'version': 2, 'candidate_only': True, 'source_sha256': hashlib.sha256(raw).hexdigest(),
              'generated_at': dt.datetime.now().astimezone().isoformat(), 'split_dates': dates,
              'selected_segments': len(selected), 'source_audit': payload['audit'],
              'limitations': LIMITATIONS, 'tasks': {}}
    models, examples, predictions = {}, {}, []
    for task in ['imputation', 'eta']:
        rows = make_rows(events, selected, task)
        train = [r for r in rows if r['date'] in dates[0] and r['known_at'] < boundaries[1]]
        val = [r for r in rows if r['date'] in dates[1] and r['known_at'] < boundaries[2]]
        test = [r for r in rows if r['date'] in dates[2]]
        if min(len(train), len(val), len(test)) < 60:
            raise ValueError(f'{task}: insufficient chronological examples')
        mid = val[len(val)//2]['at']
        tune = [r for r in val if r['known_at'] < mid]
        calibration = [r for r in val if r['at'] >= mid]
        if min(len(tune), len(calibration)) < 30:
            raise ValueError('Not enough independent calibration rows')
        # Bounded CPU/memory; preserve temporal ordering in the retained training set.
        train = train[::max(1, math.ceil(len(train)/15000))]
        params, mean, scale, curve, epoch = fit(train, tune, epochs, seed=31)
        model = {'version': 2, 'candidate_only': True, 'task': task, 'target': payload['target'],
                 'features': FEATURES, 'mean': mean.tolist(), 'scale': scale.tolist(),
                 'params': [p.tolist() for p in params], 'residual_scale': 60,
                 'residual_limit': 120, 'prediction_min': 15, 'prediction_max': 1800}
        calpred = infer(calibration, model)
        radius = float(np.percentile(np.abs(calpred - [r['actual'] for r in calibration]), 90))
        calmetrics = evaluate(calibration, calpred)
        approved = (calmetrics['mlp']['mae'] < calmetrics['baseline']['mae'] * .95
                    and calmetrics['mlp']['p90'] <= calmetrics['baseline']['p90'])
        model['validation_radius_seconds'] = radius
        model['baseline_radius_seconds'] = float(np.percentile(np.abs(
            np.array([r['baseline'] for r in calibration])-[r['actual'] for r in calibration]), 90))
        model['validation_gate_passed'] = bool(approved)
        model['model_id'] = hashlib.sha256(json.dumps(model, sort_keys=True).encode()).hexdigest()[:16]
        p = infer(test, model)
        scores = evaluate(test, p)
        scores['empirical_interval_coverage'] = float(np.mean(np.abs(p-[r['actual'] for r in test]) <= radius))
        report['tasks'][task] = {'counts': {'train': len(train), 'tune': len(tune), 'calibration': len(calibration), 'test': len(test)},
                                 'best_epoch': epoch, 'curve': curve, 'calibration': calmetrics, 'test': scores,
                                 'validation_gate_passed': bool(approved), 'operational_enabled': False}
        if task == 'imputation':
            report['tasks'][task]['masked_blocks'] = {}
            for gap in [1, 10, 40]:
                masked = [r for r in make_rows(events, selected, task, gap) if r['date'] in dates[2]]
                report['tasks'][task]['masked_blocks'][str(gap)] = evaluate(masked, infer(masked, model)) if masked else {'count': 0}
        examples[task] = []
        for i in np.linspace(0, len(test)-1, min(100, len(test)), dtype=int):
            r = test[i]
            record = {'task': task, 'predicted_at': local_time(r['at']).isoformat(),
                      'segment': r['segment'], 'features': r['features'], 'baseline': r['baseline'],
                      'actual': r['actual'], 'prediction': float(p[i]), 'provenance': 'estimated',
                      'model_id': model['model_id'], 'lower': max(0, float(p[i])-radius),
                      'upper': float(p[i])+radius, 'observed_sample_increment': 0,
                      'selected_source': 'mlp' if approved else 'statistical_baseline',
                      'selected_prediction': float(p[i]) if approved else r['baseline'],
                      'training_eligible': False, 'candidate_only': True,
                      'label_width_seconds': r['label_width_seconds']}
            examples[task].append(record)
            predictions.append(record)
        models[task] = model
    output.mkdir(parents=True)
    for name, value in [('models.json', models), ('report.json', report), ('examples.json', examples), ('estimated-candidates.json', predictions)]:
        (output/name).write_text(json.dumps(value, ensure_ascii=False, allow_nan=False), encoding='utf8')
    for file in (Path(__file__).parent/'phase11-dual-demo-ui').iterdir():
        shutil.copyfile(file, output/file.name)
    print(json.dumps({k: v['test'] for k, v in report['tasks'].items()}))
    return report


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('input'); p.add_argument('output')
    p.add_argument('--segments', type=int, default=24); p.add_argument('--epochs', type=int, default=35)
    a = p.parse_args()
    if not 1 <= a.segments <= 64 or not 1 <= a.epochs <= 100:
        p.error('segments 1..64, epochs 1..100')
    run(a.input, a.output, a.segments, a.epochs)
