import { infer } from './inference.js';
const el = id => document.getElementById(id);
const seconds = n => `${n.toFixed(2)}秒`;
const percent = n => `${(n * 100).toFixed(1)}%`;
try {
  const [report, model, examples] = await Promise.all(['report', 'model', 'examples'].map(async name => {
    const response = await fetch(`./${name}.json`);
    if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
    return response.json();
  }));
  if (!examples.length) throw new Error('テスト観測がありません');
  const { baseline: base, mlp: nn } = report.metrics.test;
  const improvement = base.mae - nn.mae;
  el('period').textContent = `${report.split_dates.test[0]} ～ ${report.split_dates.test.at(-1)} / ${nn.count.toLocaleString()}件 / 頻出${report.audit.selected_segments}区間`;
  el('base-mae').textContent = seconds(base.mae);
  el('nn-mae').textContent = seconds(nn.mae);
  el('change').textContent = `${seconds(Math.abs(improvement))} ${improvement > 0 ? '減' : '増'}`;
  el('verdict').textContent = improvement > 0 ? 'この代理目的のテストでは平均誤差が減りました。本番到着予測の改善は未検証です。' : 'このテストでは基準値を上回れませんでした。デモとして保持し、本番には採用しません。';
  for (const [name, m] of [['過去28日中央値', base], ['小型MLP補正', nn]]) {
    const tr = document.createElement('tr');
    for (const text of [name, seconds(m.p90), percent(m.within_15), percent(m.within_30), percent(m.within_60)]) {
      const td = document.createElement('td'); td.textContent = text; tr.append(td);
    }
    el('metrics').append(tr);
  }
  el('baseline').textContent = report.baseline;
  examples.forEach((sample, i) => {
    const option = document.createElement('option'); option.value = i;
    option.textContent = `${i + 1}. ${sample.predicted_at} / ${sample.segment}`;
    el('example').append(option);
  });
  function render() {
    const sample = examples[Number(el('example').value)];
    const prediction = infer(model, sample.features);
    if (Math.abs(prediction - sample.prediction) > 1e-6) throw new Error('Python学習結果とブラウザ推論が不一致');
    el('segment').textContent = sample.segment;
    el('sample-base').textContent = seconds(sample.baseline);
    el('sample-nn').textContent = seconds(prediction);
    el('sample-actual').textContent = seconds(sample.actual);
    el('sample-error').textContent = `補正 ${prediction - sample.baseline >= 0 ? '+' : ''}${seconds(prediction - sample.baseline)} / 絶対誤差：基準 ${seconds(Math.abs(sample.baseline - sample.actual))} → NN ${seconds(Math.abs(prediction - sample.actual))}`;
    el('sample-info').textContent = `予測起点（再構成） ${sample.predicted_at} / 切替観測 ${sample.observed_at}`;
  }
  el('example').addEventListener('change', render);
  el('next').addEventListener('click', () => { el('example').value = (Number(el('example').value) + 1) % examples.length; render(); });
  el('model-info').textContent = `MLP ${report.architecture.join(' → ')} / ${report.parameters.toLocaleString()}パラメータ / 検証で選んだepoch ${report.best_epoch} / seed ${report.seed}`;
  el('split-info').textContent = Object.entries(report.split_dates).map(([key, days]) => `${key}: ${days[0]} ～ ${days.at(-1)} (${report.metrics[key].mlp.count.toLocaleString()}件)`).join(' / ');
  el('evaluation').textContent = report.evaluation;
  for (const text of report.limitations) { const li = document.createElement('li'); li.textContent = text; el('limitations').append(li); }
  render(); el('content').hidden = false;
} catch (error) {
  el('error').textContent = `デモを読み込めません：${error.message}\nHTTPサーバー経由で開いてください。`;
}
