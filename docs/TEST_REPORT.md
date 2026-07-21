# Phase 9 テスト結果

実施日：2026-07-20

## JavaScript

```bash
npm run check:js
npm run test:js
```

結果：

- 構文確認：成功
- 単体テスト：46件成功、失敗0件

追加した主な回帰テスト：

- GPSが `current_stop_sequence` より先の場合、後続の実区間へ補正
- 石島停車中から猿江一丁目までを7分として累積
- 石島、扇橋一丁目、猿江一丁目の到着時刻が順に増加
- 配信遅延が1区間を超えた場合に次区間へ進行
- 緯度経度を停留所間線分へ投影した進行率

## Python

```bash
python3 -m py_compile tools/*.py tests/*.py
python3 -m unittest discover -s tests -p "test_*.py" -v
```

結果：

- 構文確認：成功
- 単体テスト：14件成功、失敗0件

## ローカル配信

```bash
python3 tools/serve.py
curl http://127.0.0.1:8000/
```

結果：成功

## 未確認

- 実際の都バスGTFS-RTを用いたAndroid実地比較
- 大きく曲がる道路区間でのGPS区間判定
- トンネルや高架下などGPS精度が低い場所
