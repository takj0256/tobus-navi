# Ubuntuで既存リポジトリへ適用する

正式な `data/stops.json` を保持したまま更新します。

```bash
unzip tobus-navi-pwa-phase3.zip
rsync -av \
  tobus-navi-pwa-phase3/ \
  /path/to/tobus-navi/

cd /path/to/tobus-navi
python3 tools/validate_dataset.py data/stops.json
npm run test:js
npm run check:js
python3 -m unittest discover -s tests -p "test_*.py" -v

git status
git add .
git commit -m "Add production search suggestions and recent routes"
git push
```

配布ZIPには `data/stops.json` がないため、既存の正式データは上書きされません。
