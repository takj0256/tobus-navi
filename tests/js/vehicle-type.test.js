import test from "node:test";
import assert from "node:assert/strict";
import { classifyVehicleType, normalizeVehicleId } from "../../js/vehicle-type.js";

test("bureau vehicle number is extracted from realtime labels", () => {
  assert.equal(normalizeVehicleId("N-M100"), "M100");
  assert.equal(normalizeVehicleId("N-M100（北）"), "M100");
  assert.equal(normalizeVehicleId("K181"), "K181");
  assert.equal(normalizeVehicleId("unknown"), "");
});

test("zero-emission and known hybrid vehicles are classified", () => {
  assert.equal(classifyVehicleType("M100").key, "ev");
  assert.equal(classifyVehicleType("K181").key, "fuel-cell");
  assert.equal(classifyVehicleType("M194").key, "fuel-cell");
  assert.equal(classifyVehicleType("X294").key, "hybrid");
  assert.equal(classifyVehicleType("V326").key, "standard");
});
