import test from 'node:test';
import assert from 'node:assert/strict';
import { reserveD1Operation } from '../../tools/process_phase11_raw.mjs';

test('anomaly bursts leave the existing total budget available for weather', () => {
  const budget = { reads: 0, writes: 2871 };
  reserveD1Operation(budget, 'INSERT INTO anomalies VALUES (?)');
  assert.equal(budget.writes, 2872);
  assert.throws(() => reserveD1Operation(budget, 'INSERT INTO anomalies VALUES (?)'), /128 reserved for weather/);
  assert.equal(budget.writes, 2872);
  for (let i = 0; i < 128; i++) reserveD1Operation(budget, ' INSERT INTO weather_current (id) VALUES (1)');
  assert.equal(budget.writes, 3000);
  assert.throws(() => reserveD1Operation(budget, 'INSERT INTO weather_current (id) VALUES (1)'), /budget exhausted/);
  assert.equal(budget.writes, 3000);
});

test('weather writes also count against the unchanged total, including reservations for failures', () => {
  const budget = { reads: 0, writes: 2872 };
  reserveD1Operation(budget, 'insert into weather_current (id) values (1)');
  assert.equal(budget.writes, 2873);
  assert.throws(() => reserveD1Operation(budget, 'INSERT INTO anomalies VALUES (?)'), /budget exhausted/);
  const exhausted = { reads: 0, writes: 3000 };
  assert.throws(() => reserveD1Operation(exhausted, 'INSERT INTO weather_current (id) VALUES (1)'), /budget exhausted/);
  assert.equal(exhausted.writes, 3000); // Never reset or bypass an already exhausted day.
});

test('read cap is independent and only the exact weather table gets the reserved allowance', () => {
  const budget = { reads: 2999, writes: 2872 };
  assert.equal(reserveD1Operation(budget, ' SELECT * FROM corrections'), 'reads');
  assert.throws(() => reserveD1Operation(budget, 'SELECT * FROM corrections'), /reads daily/);
  assert.throws(() => reserveD1Operation(budget, 'INSERT INTO weather_current_backup VALUES (1)'), /128 reserved/);
  assert.equal(budget.writes, 2872);
});
