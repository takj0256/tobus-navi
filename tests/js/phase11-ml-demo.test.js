import test from 'node:test';
import assert from 'node:assert/strict';
import { infer } from '../../tools/phase11-ml-demo-ui/inference.js';

const model = {
  version: 1, candidate_only: true, features: ['base'], mean: [0], scale: [1],
  params: [[[1]], [0], [[1]], [0], [[1]], [0]], residual_scale: 60,
  residual_limit: 120, prediction_min: 15, prediction_max: 1800,
};
test('demo inference normalizes, runs ReLU and bounds residual', () => {
  assert.equal(infer(model, [100]), 220);
  assert.equal(infer(model, [1790]), 1800);
  assert.equal(infer(model, [-1]), 15);
});
test('demo rejects non-finite or incorrectly sized input', () => {
  assert.throws(() => infer(model, [NaN]));
  assert.throws(() => infer(model, []));
  assert.throws(() => infer({ ...model, candidate_only: false }, [1]));
});
