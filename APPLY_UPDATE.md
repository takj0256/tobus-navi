# UbuntuでPhase 7を既存リポジトリへ適用

## 1. ZIPを展開

```bash
cd ~/Downloads
rm -rf tobus-navi-pwa-phase7
unzip tobus-navi-pwa-phase7.zip
```

## 2. Gitリポジトリへ移動

```bash
cd ~/tobus-navi
REPO="$(git rev-parse --show-toplevel)"
printf '更新先: %s\n' "$REPO"
```

`/` または空欄ならコピーしないでください。

## 3. 安全確認付きで上書き

```bash
SOURCE="$HOME/Downloads/tobus-navi-pwa-phase7"

if [[ -z "$REPO" || "$REPO" == "/" || ! -d "$REPO/.git" ]]; then
  echo "危険または不正な更新先のため中止: $REPO" >&2
  exit 1
fi

rsync -av --no-group "$SOURCE/" "$REPO/"
```

## 4. データを確認

Phase 6の正式データをそのまま利用できます。

```bash
cd "$REPO"
python3 tools/validate_dataset.py data/transit-index.json
```

GTFSを更新したい場合だけ再生成します。

```bash
./tools/update_gtfs.sh ~/Downloads/ToeiBus-GTFS.zip
```

## 5. テスト

```bash
npm run check:js
npm run test:js
python3 -m py_compile tools/*.py tests/*.py
python3 -m unittest discover -s tests -p "test_*.py" -v
python3 tools/validate_dataset.py data/transit-index.json
```

## 6. ローカル確認

```bash
python3 tools/serve.py
```

```text
http://127.0.0.1:8000
```

確認項目：

- 同じのりばを使用する複数系統が「こののりばの接近情報」にまとまる
- 接近中のバスが系統をまたいで到着順に並ぶ
- 各接近カードに系統番号と行き先が表示される
- 「停留所上の現在位置」に乗車停留所と手前の停留所が表示される
- バス記号をタップすると、その車両のこの先の推定到着が開く
- 発車予定と本日の時刻表が複数系統に対応する

## 7. GitHubへ反映

```bash
git status
git add .
git commit -m "Integrate routes by platform and add stop-position tracking"
git push
```
