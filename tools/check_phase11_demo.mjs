import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { infer } from './phase11-ml-demo-ui/inference.js';

const root = process.argv[2];
if (!root) throw Error('Usage: node tools/check_phase11_demo.mjs OUTPUT_DIR');
const model = JSON.parse(await fs.readFile(path.join(root, 'model.json'), 'utf8'));
const examples = JSON.parse(await fs.readFile(path.join(root, 'examples.json'), 'utf8'));
assert.ok(examples.length > 0);
let maxError = 0;
for (const sample of examples) {
  const error = Math.abs(infer(model, sample.features) - sample.prediction);
  maxError = Math.max(maxError, error);
  assert.ok(error < 1e-6, `Python/JS mismatch: ${error}`);
}
console.log(JSON.stringify({ checked: examples.length, max_error_seconds: maxError }));
