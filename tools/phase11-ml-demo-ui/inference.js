export function infer(model, features) {
  if (model?.version !== 1 || !model.candidate_only || features.length !== model.features.length || !features.every(Number.isFinite)) {
    throw new Error('Invalid demo input');
  }
  let values = features.map((x, i) => Math.max(-8, Math.min(8, (x - model.mean[i]) / model.scale[i])));
  for (let layer = 0; layer < 3; layer++) {
    const weights = model.params[layer * 2], bias = model.params[layer * 2 + 1];
    values = bias.map((b, j) => {
      const value = values.reduce((sum, x, i) => sum + x * weights[i][j], b);
      return layer < 2 ? Math.max(0, value) : value;
    });
  }
  const residual = Math.max(-model.residual_limit, Math.min(model.residual_limit, values[0] * model.residual_scale));
  const prediction = Math.max(model.prediction_min, Math.min(model.prediction_max, features[0] + residual));
  if (!Number.isFinite(prediction)) throw new Error('Non-finite prediction');
  return prediction;
}
