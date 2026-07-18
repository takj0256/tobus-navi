# 正式GTFSデータの生成先

このディレクトリには配布ZIP時点では正式データを含めません。

```bash
python3 tools/convert_gtfs.py \
  ~/Downloads/ToeiBus-GTFS.zip \
  --output-dir data
```

生成物：

- `transit-index.json`：同名停留所グループ、のりば、系統索引
- `routes/*.json`：系統別の便、停車順、時刻表、運行日
