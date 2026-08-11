import test from "node:test";
import assert from "node:assert/strict";
import {
  applyWeeklyProfile,
  buildCorrectionRatio,
  buildWeatherAdjustmentProfile,
  buildWeeklyProfile,
  confirmPhase11Anomaly,
  detectPhase11Anomaly,
  effectiveCorrectionRatio,
  effectiveWeatherRatio,
  fetchPhase11Estimates,
  phase11DayType,
  phase11SegmentKey,
  phase11TimeBin,
  propagateDownstreamCorrections,
} from "../../js/phase11.js";

test("区間キー、東京時間帯、曜日区分を生成する", () => {
  const at = Date.parse("2026-08-03T23:07:00Z"); // 火曜08:07 JST
  assert.equal(phase11SegmentKey("r1", 0, "a", "b"), "r1|0|a>b");
  assert.equal(phase11TimeBin(at), "08:00");
  assert.equal(phase11DayType(at), "weekday");
  assert.equal(phase11DayType(at, new Set(["2026-08-04"])), "holiday");
});

test("異常値を除外して週間プロファイルを生成する", () => {
  const now = Date.parse("2026-08-04T00:00:00Z");
  const samples = [170, 180, 185, 190, 200, 900].map((seconds, index) => ({
    seconds, timestampMs: now - index * 86_400_000, anomalous: seconds === 900,
  }));
  const profile = buildWeeklyProfile(samples, 150, now);
  assert.equal(profile.sample_count, 5);
  assert.equal(profile.median_seconds, 185);
  assert.ok(profile.confidence > 0.5);
});

test("直近7日に3件あれば古い28日サンプルを通常値へ混ぜない", () => {
  const now = Date.parse("2026-08-04T00:00:00Z");
  const samples = [100, 110, 120].map((seconds, index) => ({
    seconds, timestampMs: now - index * 86_400_000,
  }));
  samples.push({ seconds: 600, timestampMs: now - 14 * 86_400_000 });
  const profile = buildWeeklyProfile(samples, 120, now);
  assert.equal(profile.sample_count, 3);
  assert.equal(profile.median_seconds, 110);
});

test("信頼度0.3未満の週間値は時刻表へ混ぜない", () => {
  assert.deepEqual(applyWeeklyProfile(120, { median_seconds: 240, confidence: 0.29 }), {
    seconds: 120, profileWeight: 0, source: "schedule",
  });
  const used = applyWeeklyProfile(120, { median_seconds: 180, confidence: 0.8 });
  assert.equal(used.source, "weekly-profile");
  assert.ok(used.seconds > 120 && used.seconds < 180);
});

test("120秒超過を候補、300秒超過を重大異常にする", () => {
  const candidate = detectPhase11Anomaly(250, 120, { p75_seconds: 160, mad_seconds: 30 });
  assert.equal(candidate.candidate, true);
  assert.equal(candidate.critical, false);
  const critical = detectPhase11Anomaly(500, 120, null);
  assert.equal(critical.critical, true);
});

test("MAD境界だけの小さな差は異常候補にしない", () => {
  const mild = detectPhase11Anomaly(102, 93, { p75_seconds: 95, mad_seconds: 2 });
  assert.equal(mild.candidate, false);
  const delayed = detectPhase11Anomaly(160, 100, { p75_seconds: 120, mad_seconds: 10 });
  assert.equal(delayed.candidate, true);
  assert.ok(delayed.reasons.includes("dispersion"));
});

test("異常確定は既存キャッシュまたは複数車両を使い新規照会を要求しない", () => {
  const candidate = { candidate: true, critical: false };
  const nowMs = Date.now();
  const cached = confirmPhase11Anomaly(candidate, [], {
    traffic_ratio: 1.6, expires_at_ms: nowMs + 60_000,
  }, { nowMs });
  assert.equal(cached.reason, "existing-traffic-cache");
  const multiple = confirmPhase11Anomaly(candidate, [
    { candidate: true, vehicleId: "a", timestampMs: nowMs, sameOrAdjacentSegment: true },
    { candidate: true, vehicleId: "b", timestampMs: nowMs, sameOrAdjacentSegment: true },
  ], null, { nowMs });
  assert.equal(multiple.reason, "multiple-vehicles");
});

test("補正は後続2区間まで減衰し3区間目で完全に切れる", () => {
  assert.equal(effectiveCorrectionRatio(1.6, 0, 0), 1.6);
  assert.ok(Math.abs(effectiveCorrectionRatio(1.6, 0, 1) - 1.4) < 1e-9);
  assert.ok(Math.abs(effectiveCorrectionRatio(1.6, 0, 2) - 1.2) < 1e-9);
  assert.equal(effectiveCorrectionRatio(1.6, 0, 3), 1);
  assert.ok(buildCorrectionRatio({ traffic_ratio: 1.5, confidence: 1 }, 1.2) > 1.2);
});

test("天候倍率は十分なサンプルと信頼度がある場合だけ遅延方向へ適用する", () => {
  const now = Date.parse("2026-08-11T00:00:00Z");
  const samples = Array.from({ length: 40 }, (_, index) => ({
    ratio: 1.2 + (index % 3 - 1) * 0.02,
    timestampMs: now - index * 60_000,
  }));
  const profile = buildWeatherAdjustmentProfile(samples, now, { minimumSamples: 20, targetSamples: 40 });
  assert.ok(profile.adjustment_ratio > 1.15);
  assert.ok(profile.confidence > 0.9);
  assert.equal(effectiveWeatherRatio({ ...profile, active: true }), profile.adjustment_ratio);
  assert.equal(effectiveWeatherRatio({ ...profile, active: true, sample_count: 19 }), 1);
  assert.equal(effectiveWeatherRatio({ ...profile, active: true, confidence: 0.59 }), 1);
});

test("有効補正を同じ経路の後続2区間だけへ伝播する", () => {
  const segments = [0, 1, 2, 3].map((sequence) => ({
    segment_key: `s${sequence}`,
    route_id: "r", direction_id: 0, shape_id: "shape", sequence,
  }));
  const propagated = propagateDownstreamCorrections(new Map([[
    "s0", { segment_key: "s0", correction: { active: true, correction_ratio: 1.6 } },
  ]]), segments);
  assert.equal(propagated.get("s1").correction.downstream_segment_count, 1);
  assert.equal(propagated.get("s2").correction.downstream_segment_count, 2);
  assert.equal(propagated.has("s3"), false);
});

test("Phase 11バッチAPI応答をMapに変換する", async () => {
  const map = await fetchPhase11Estimates("https://worker.example", [{ segment_key: "r|0|a>b" }], {
    fetchImpl: async (_url, request) => {
      assert.equal(request.method, "POST");
      return new Response(JSON.stringify({ estimates: [{ segment_key: "r|0|a>b", profile: { confidence: 0.8 } }] }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    },
  });
  assert.equal(map.get("r|0|a>b").profile.confidence, 0.8);
});
