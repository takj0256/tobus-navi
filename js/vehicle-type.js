const FUEL_CELL_GENERATIONS = new Set(["B", "C", "D", "E", "F", "G", "H", "K", "L", "M"]);
const EV_IDS = new Set(["M100", "M101"]);

export function normalizeVehicleId(value) {
  const match = String(value || "").toUpperCase().match(/([A-Z]\d{3})/);
  return match?.[1] || "";
}

export function classifyVehicleType(value) {
  const id = normalizeVehicleId(value);
  if (EV_IDS.has(id)) {
    return { key: "ev", label: "EV（電気）", icon: "⚡", marker: "⚡", vehicleId: id };
  }
  const generation = id.slice(0, 1);
  const number = Number(id.slice(1));
  if (FUEL_CELL_GENERATIONS.has(generation) && number >= 101 && number <= 194) {
    return { key: "fuel-cell", label: "水素FC", icon: "H₂", marker: "H₂", vehicleId: id };
  }
  if (generation === "X" && number >= 290 && number <= 297) {
    return { key: "hybrid", label: "ハイブリッド", icon: "♻", marker: "♻", vehicleId: id };
  }
  return { key: "standard", label: "通常車等", icon: "🚌", marker: "🚌", vehicleId: id };
}
