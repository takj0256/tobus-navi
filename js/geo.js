const EARTH_RADIUS_METERS = 6_371_000;

export function haversineMeters(lat1, lon1, lat2, lon2) {
  const toRadians = (degrees) => degrees * Math.PI / 180;
  const phi1 = toRadians(lat1);
  const phi2 = toRadians(lat2);
  const deltaPhi = toRadians(lat2 - lat1);
  const deltaLambda = toRadians(lon2 - lon1);

  const a = Math.sin(deltaPhi / 2) ** 2
    + Math.cos(phi1) * Math.cos(phi2) * Math.sin(deltaLambda / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_METERS * c;
}

export function projectPointToSegmentMeters(pointLat, pointLon, startLat, startLon, endLat, endLon) {
  const values = [pointLat, pointLon, startLat, startLon, endLat, endLon].map(Number);
  if (!values.every(Number.isFinite)) {
    return { fraction: NaN, distanceMeters: Infinity, segmentLengthMeters: NaN };
  }

  const [pLat, pLon, aLat, aLon, bLat, bLon] = values;
  const toRadians = (degrees) => degrees * Math.PI / 180;
  const referenceLatitude = toRadians((pLat + aLat + bLat) / 3);
  const scaleX = EARTH_RADIUS_METERS * Math.cos(referenceLatitude) * Math.PI / 180;
  const scaleY = EARTH_RADIUS_METERS * Math.PI / 180;

  const ax = aLon * scaleX;
  const ay = aLat * scaleY;
  const bx = bLon * scaleX;
  const by = bLat * scaleY;
  const px = pLon * scaleX;
  const py = pLat * scaleY;
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;

  if (lengthSquared < 1) {
    return {
      fraction: 0,
      distanceMeters: Math.hypot(px - ax, py - ay),
      segmentLengthMeters: Math.sqrt(lengthSquared),
    };
  }

  const rawFraction = ((px - ax) * dx + (py - ay) * dy) / lengthSquared;
  const fraction = Math.min(1, Math.max(0, rawFraction));
  const projectedX = ax + fraction * dx;
  const projectedY = ay + fraction * dy;
  return {
    fraction,
    distanceMeters: Math.hypot(px - projectedX, py - projectedY),
    segmentLengthMeters: Math.sqrt(lengthSquared),
  };
}

export function formatDistance(meters) {
  if (!Number.isFinite(meters)) return "距離不明";
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(1)} km`;
}

export function getCurrentPosition(options = {}) {
  const defaults = {
    enableHighAccuracy: true,
    timeout: 12_000,
    maximumAge: 20_000,
  };

  return new Promise((resolve, reject) => {
    if (!("geolocation" in navigator)) {
      reject(new Error("このブラウザは位置情報に対応していません。"));
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, reject, { ...defaults, ...options });
  });
}

export async function getGeolocationPermissionState() {
  if (typeof navigator === "undefined" || !navigator.permissions?.query) {
    return "unsupported";
  }

  try {
    const permission = await navigator.permissions.query({ name: "geolocation" });
    return permission.state;
  } catch {
    // Safariなど、Permissions APIが存在してもgeolocation照会に未対応の環境がある。
    return "unsupported";
  }
}

export function geolocationErrorMessage(error) {
  if (!error) return "現在地を取得できませんでした。";
  switch (error.code) {
    case 1: return "位置情報の利用が許可されていません。ブラウザの権限設定を確認してください。";
    case 2: return "現在地を特定できませんでした。屋外へ移動するか、停留所名検索を使用してください。";
    case 3: return "位置情報の取得がタイムアウトしました。もう一度お試しください。";
    default: return error.message || "現在地を取得できませんでした。";
  }
}
