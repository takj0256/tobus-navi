import {estimate} from './inference.js';
try {
  const read=async f=>{const r=await fetch(f);if(!r.ok)throw Error(`${f}: ${r.status}`);return r.json();};
  const [models,report,examples]=await Promise.all(['models.json','report.json','examples.json'].map(read));
  let index=0;
  const task=document.querySelector('#task');
  function render(){
    const name=task.value,m=models[name],r=report.tasks[name],e=examples[name][index%examples[name].length];
    const metric=r.test;
    document.querySelector('#metrics').innerHTML=`<table><tr><th>テスト指標</th><th>統計基準</th><th>NN候補</th></tr>${['mae','p90','within_30','within_60'].map(k=>`<tr><td>${k}</td><td>${metric.baseline[k].toFixed(3)}</td><td>${metric.mlp[k].toFixed(3)}</td></tr>`).join('')}</table><p>評価件数 ${metric.mlp.count} ／ 検証採用基準 ${r.validation_gate_passed?'達成（本番は無効）':'未達・基準方式を維持'}</p>`;
    const p=estimate(m,e.features);
    document.querySelector('#when').textContent=e.predicted_at;
    document.querySelector('#prediction').textContent=`${p.source==='mlp'?'NNを選択':'統計基準へ戻す'} ${p.prediction.toFixed(1)} 秒`;
    document.querySelector('#detail').textContent=`NN候補 ${p.candidate.toFixed(1)}秒 ／ 基準 ${e.baseline.toFixed(1)}秒 ／ 観測正解 ${e.actual.toFixed(1)}秒 ／ 選択値の参考幅 ${p.lower.toFixed(1)}〜${p.upper.toFixed(1)}秒。estimated・実測件数への加算0。`;
  }
  document.querySelector('#limits').textContent=report.limitations.join(' ');
  task.onchange=()=>{index=0;render();};document.querySelector('#next').onclick=()=>{index++;render();};render();
}catch(e){document.querySelector('#error').textContent=`読み込み失敗: ${e.message}`;}
