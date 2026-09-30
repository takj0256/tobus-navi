import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {infer,estimate} from './phase11-dual-demo-ui/inference.js';
const root=process.argv[2];
const models=JSON.parse(await fs.readFile(path.join(root,'models.json')));
const examples=JSON.parse(await fs.readFile(path.join(root,'examples.json')));
let count=0,maxError=0;
for(const [task,rows] of Object.entries(examples))for(const row of rows){
 const value=infer(models[task],row.features),result=estimate(models[task],row.features);
 maxError=Math.max(maxError,Math.abs(value-row.prediction));count++;
 assert.ok(Math.abs(value-row.prediction)<1e-8);
 assert.ok(Math.abs(result.prediction-row.selected_prediction)<1e-8);
 assert.equal(result.source,row.selected_source);assert.equal(result.training_eligible,false);
 assert.equal(result.observed_sample_increment,0);
}
console.log(JSON.stringify({count,maxError}));
