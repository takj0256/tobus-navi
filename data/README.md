# 停留所データ

正式版ではデモデータを同梱しません。

ODPTから取得した都バスGTFS-JPを、プロジェクトルートで次のように変換してください。

```bash
python3 tools/convert_gtfs.py ~/Downloads/ToeiBus-GTFS.zip \
  --output data/stops.json \
  --pretty
```

既に正式な `data/stops.json` があるリポジトリへ本更新を適用する場合、そのファイルはそのまま保持してください。
