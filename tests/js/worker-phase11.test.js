import test from "node:test";
import assert from "node:assert/strict";
import worker, {
  collectSegmentEvents,
  buildCompactDailyGroups,
  chunkUniqueKeys,
  classifyTemperature,
  classifyWeather,
  compactOneCompletedHour,
  compactOneCompletedTokyoDay,
  fetchCurrentWeather,
  isSameVehicleConsecutive,
  mergeCompactDailyGroups,
  runScheduledCollection,
} from "../../worker/worker.js";

function vehicle(stopId, sequence, timestamp, overrides = {}) {
  return {
    entityId: "entity-1",
    trip: { tripId: "trip-1", routeId: "route-1", directionId: 0 },
    stopId,
    currentStopSequence: sequence,
    timestamp,
    position: { latitude: 35 + sequence / 100, longitude: 139 + sequence / 100 },
    vehicle: { id: "vehicle-1" },
    ...overrides,
  };
}

test("Worker収集処理が連続停留所から1件の区間イベントを作る", () => {
  const state = { vehicles: {}, candidates: [] };
  assert.equal(collectSegmentEvents({ vehicles: [vehicle("a", 1, 1000)] }, state, 1_000_000).length, 0);
  const events = collectSegmentEvents({ vehicles: [vehicle("b", 2, 1120)] }, state, 1_120_000);
  assert.equal(events.length, 1);
  assert.equal(events[0].segment_key, "route-1|0|a>b");
  assert.equal(events[0].seconds, 120);
  assert.ok(Number.isFinite(events[0].latitude));
});

test("便変更、停留所飛ばし、極端な所要時間を学習しない", () => {
  const state = { vehicles: {}, candidates: [] };
  collectSegmentEvents({ vehicles: [vehicle("a", 1, 1000)] }, state);
  assert.equal(collectSegmentEvents({ vehicles: [vehicle("c", 3, 1120)] }, state).length, 0);
  assert.equal(collectSegmentEvents({ vehicles: [vehicle("d", 4, 1130, { trip: { tripId: "other", routeId: "route-1", directionId: 0 } })] }, state).length, 0);
});

test("同一車両でも停留所が連続するときだけ連続異常として扱う", () => {
  const event = { vehicle_id: "v1", from_stop_id: "b" };
  assert.equal(isSameVehicleConsecutive({ vehicleId: "v1", toStopId: "b" }, event), true);
  assert.equal(isSameVehicleConsecutive({ vehicleId: "v1", toStopId: "x" }, event), false);
  assert.equal(isSameVehicleConsecutive({ vehicleId: "v2", toStopId: "b" }, event), false);
});

test("D1検索キーは重複を除いてSQL変数上限以下へ分割する", () => {
  const keys = [...Array.from({ length: 160 }, (_, index) => `s${index}`), "s0", "s1"];
  const chunks = chunkUniqueKeys(keys);
  assert.deepEqual(chunks.map((chunk) => chunk.length), [75, 75, 10]);
  assert.equal(new Set(chunks.flat()).size, 160);
});

test("推定APIはR2 currentの曜日・15分シャードをD1より優先する", async () => {
  const at = "2026-09-08T23:07:00Z";
  const generation = "2026-09-11T03-52-33.348Z";
  const profile = { segment_key: "r|0|a>b", confidence: 0.8, median_seconds: 120 };
  const bucket = memoryBucket(new Map([
    ["profiles-v1/current.json", {
      version: 1, format: "phase11-profile-shards", generation, generated_at: "2026-09-11T03:52:33.348Z",
      shards: [{ day_type: "weekday", time_bin: "08:00", path: "profiles/weekday/0800.json" }],
      weather: { path: "weather-profiles.json" },
    }],
    [`profiles-v1/generations/${generation}/profiles/weekday/0800.json`, {
      version: 1, generated_at: "2026-09-11T03:52:33.348Z", profiles: [profile],
    }],
    [`profiles-v1/generations/${generation}/weather-profiles.json`, {
      version: 1, generated_at: "2026-09-11T03:52:33.348Z",
      weather_profiles: [{
        route_id: "r", direction_id: 0, weather_class: "dry", temperature_band: "mild",
        adjustment_ratio: 1.1, confidence: 0.8,
      }],
    }],
  ]));
  const db = {
    prepare(sql) {
      return {
        bind() { return this; },
        async all() { return { results: [] }; },
        async first() {
          return sql.includes("weather_current") ? {
            observed_at: at, weather_class: "dry", temperature_band: "mild",
            temperature_c: 24, precipitation_mm: 0, weather_code: 1,
          } : null;
        },
      };
    },
  };
  const response = await worker.fetch(new Request("https://worker.example/api/v1/estimates", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ at, segments: [{ segment_key: profile.segment_key, route_id: "r", direction_id: 0 }] }),
  }), { EVENT_BUCKET: bucket, DB: db }, {});
  const body = await response.json();
  assert.equal(body.sources.profiles, "r2-json");
  assert.equal(body.sources.weather_profiles, "r2-json");
  assert.equal(body.profile_generation, generation);
  assert.equal(body.estimates[0].profile.confidence, 0.8);
  assert.equal(body.estimates[0].weather.adjustment_ratio, 1.1);
});

test("R2 currentが読めない場合は推定APIがD1へフォールバックする", async () => {
  const profile = { segment_key: "r|0|a>b", confidence: 0.7, median_seconds: 130 };
  const db = {
    prepare(sql) {
      return {
        bind() { return this; },
        async all() {
          if (sql.includes("FROM profiles")) return { results: [profile] };
          return { results: [] };
        },
        async first() { return null; },
      };
    },
  };
  const response = await worker.fetch(new Request("https://worker.example/api/v1/estimates", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ at: "2026-09-08T23:07:00Z", segments: [{ segment_key: profile.segment_key }] }),
  }), { EVENT_BUCKET: memoryBucket(new Map()), DB: db }, {});
  const body = await response.json();
  assert.equal(body.sources.profiles, "d1");
  assert.equal(body.estimates[0].profile.median_seconds, 130);
});

test("降水・降雪と気温を学習用カテゴリへ分類する", () => {
  assert.equal(classifyWeather({ precipitation_mm: 0, weather_code: 1 }), "dry");
  assert.equal(classifyWeather({ precipitation_mm: 1, weather_code: 61 }), "rain");
  assert.equal(classifyWeather({ precipitation_mm: 6, weather_code: 65 }), "heavy-rain");
  assert.equal(classifyWeather({ snowfall_cm: 0.2, weather_code: 71 }), "snow");
  assert.equal(classifyTemperature(3), "cold");
  assert.equal(classifyTemperature(32), "hot");
});

test("Open-Meteo現在値を正規化する", async () => {
  const now = new Date("2026-08-11T03:00:00Z");
  const weather = await fetchCurrentWeather({}, now, async (url) => {
    assert.match(url, /api\.open-meteo\.com/);
    return new Response(JSON.stringify({
      latitude: 35.7, longitude: 139.7,
      current: {
        time: "2026-08-11T03:00", temperature_2m: 31,
        apparent_temperature: 35, precipitation: 1.2, rain: 1.2,
        showers: 0, snowfall: 0, weather_code: 61, wind_speed_10m: 12,
      },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  assert.equal(weather.weather_class, "rain");
  assert.equal(weather.temperature_band, "hot");
  assert.equal(weather.temperature_c, 31);
});

test("完了した東京日付を1日ずつ日次R2オブジェクトへ圧縮する", async () => {
  const bucket = memoryBucket(new Map([
    ["hourly/2026-08-07/14.json", { events: [{ id: "d7" }] }], // 8/7 23:00 JST
    ["hourly/2026-08-07/15.json", { events: [{ id: "d8a" }] }], // 8/8 00:00 JST
    ["hourly/2026-08-08/14.json", { events: [{ id: "d8b" }] }], // 8/8 23:00 JST
    ["hourly/2026-08-08/15.json", { events: [{ id: "d9" }] }], // 8/9 00:00 JST
  ]));
  const result = await compactOneCompletedTokyoDay(bucket, new Date("2026-08-08T22:00:00Z"));
  assert.equal(result.dateKey, "2026-08-07");
  assert.equal(result.remainingCompletedDays, 1);
  assert.equal(bucket.values.has("hourly/2026-08-07/14.json"), false);
  assert.equal(bucket.values.get("daily-v2/2026-08-07.json").version, 2);
  assert.equal(bucket.values.get("daily-v2/2026-08-07.json").groups.length, 0);
  assert.equal(bucket.values.has("hourly/2026-08-07/15.json"), true);
});

test("取りこぼした分イベントを後続Cronで時間別R2へ圧縮する", async () => {
  const bucket = memoryBucket(new Map([
    ["events/2026-08-25/03/01-a.json", { events: [{ event_id: "a" }] }],
    ["events/2026-08-25/03/02-b.json", { events: [{ event_id: "b" }] }],
    ["events/2026-08-25/04/01-c.json", { events: [{ event_id: "c" }] }],
  ]));
  const result = await compactOneCompletedHour(bucket, new Date("2026-08-25T04:30:00Z"));
  assert.equal(result.hourlyKey, "hourly/2026-08-25/03.json");
  assert.equal(bucket.values.get(result.hourlyKey).events.length, 2);
  assert.equal(bucket.values.has("events/2026-08-25/04/01-c.json"), true);
});

test("既存日次オブジェクトへ遅れて圧縮された時間別データを追記する", async () => {
  const existingGroup = {
    segment_key: "r|0|a>b", route_id: "r", direction_id: 0,
    from_stop_id: "a", to_stop_id: "b", day_type: "saturday", time_bin: "08:00",
    samples: [[100, Date.parse("2026-08-07T23:00:00Z")]],
  };
  const bucket = memoryBucket(new Map([
    ["daily-v2/2026-08-08.json", { version: 2, source_keys: ["hourly/2026-08-07/15.json"], groups: [existingGroup] }],
    ["hourly/2026-08-07/16.json", { events: [{
      event_id: "late", segment_key: "r|0|a>b", route_id: "r", direction_id: 0,
      from_stop_id: "a", to_stop_id: "b", seconds: 120,
      timestamp_ms: Date.parse("2026-08-07T23:01:00Z"), anomalous: false,
    }] }],
  ]));
  await compactOneCompletedTokyoDay(bucket, new Date("2026-08-09T00:00:00Z"));
  const daily = bucket.values.get("daily-v2/2026-08-08.json");
  assert.equal(daily.groups[0].samples.length, 2);
  assert.equal(bucket.values.has("hourly/2026-08-07/16.json"), false);
});

test("収集API失敗時もR2保守を実行してから失敗を報告する", async () => {
  const bucket = memoryBucket(new Map([
    ["events/2026-08-25/03/01-a.json", { events: [{ event_id: "a" }] }],
  ]));
  await assert.rejects(
    runScheduledCollection({ EVENT_BUCKET: bucket }, new Date("2026-08-25T04:30:00Z"), async () => new Response("bad", { status: 503 })),
    /ODPT upstream HTTP 503/,
  );
  assert.equal(bucket.values.has("hourly/2026-08-25/03.json"), true);
});

test("日次グループの追記で同一区間と時間枠を統合する", () => {
  const base = { segment_key: "s", day_type: "weekday", time_bin: "08:00", samples: [[1, 1]] };
  const merged = mergeCompactDailyGroups([base], [{ ...base, samples: [[2, 2]] }]);
  assert.deepEqual(merged[0].samples, [[1, 1], [2, 2]]);
});

test("イベントIDが同じ遅延サンプルを日次データへ二重計上しない", () => {
  const base = { segment_key: "s", day_type: "weekday", time_bin: "08:00", samples: [[100, 1, null, null, null, "e1"]] };
  const merged = mergeCompactDailyGroups([base], [{ ...base, samples: [[100, 1, null, null, null, "e1"]] }]);
  assert.equal(merged[0].samples.length, 1);
});

test("日次イベントを区間・曜日・15分枠ごとの軽量サンプルへ変換する", () => {
  const at = Date.parse("2026-08-07T23:07:00Z"); // 土曜08:07 JST
  const common = {
    segment_key: "r|0|a>b", route_id: "r", direction_id: 0,
    from_stop_id: "a", to_stop_id: "b", timestamp_ms: at,
  };
  const groups = buildCompactDailyGroups([
    { ...common, seconds: 100, anomalous: false, weather: {
      weather_class: "rain", temperature_band: "hot", temperature_c: 31,
    } },
    { ...common, seconds: 120, timestamp_ms: at + 60_000, anomalous: false },
    { ...common, seconds: 900, anomalous: true },
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].day_type, "saturday");
  assert.equal(groups[0].time_bin, "08:00");
  assert.deepEqual(groups[0].samples.map((sample) => sample[0]), [100, 120]);
  assert.deepEqual(groups[0].samples[0].slice(2), ["rain", "hot", 31]);
});

function memoryBucket(initial) {
  const values = initial;
  return {
    values,
    async list({ prefix }) {
      return {
        objects: [...values.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({
          key, uploaded: new Date("2026-08-08T00:00:00Z"),
        })),
        truncated: false,
      };
    },
    async head(key) { return values.has(key) ? { key } : null; },
    async get(key) {
      if (!values.has(key)) return null;
      return { async json() { return structuredClone(values.get(key)); } };
    },
    async put(key, body) { values.set(key, JSON.parse(body)); },
    async delete(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) values.delete(key);
    },
  };
}
