export function infer(model, features) {
  if (model?.version !== 2 || !model.candidate_only || features.length !== model.features.length || !features.every(Number.isFinite)) throw Error('Invalid candidate input');
  let values = features.map((x,i)=>Math.max(-8,Math.min(8,(x-model.mean[i])/model.scale[i])));
  for(let layer=0;layer<3;layer++){
    const w=model.params[layer*2],b=model.params[layer*2+1];
    values=b.map((bias,j)=>{const v=values.reduce((s,x,i)=>s+x*w[i][j],bias);return layer<2?Math.max(0,v):v;});
  }
  const delta=Math.max(-model.residual_limit,Math.min(model.residual_limit,values[0]*model.residual_scale));
  const result=Math.max(model.prediction_min,Math.min(model.prediction_max,features[0]+delta));
  if(!Number.isFinite(result))throw Error('Non-finite prediction');
  return result;
}

export function estimate(model, features) {
  const candidate=infer(model,features),useModel=model.validation_gate_passed===true;
  const prediction=useModel?candidate:features[0];
  const radius=useModel?model.validation_radius_seconds:model.baseline_radius_seconds;
  if(!Number.isFinite(radius)||radius<0)throw Error('Invalid uncertainty radius');
  return {candidate,prediction,source:useModel?'mlp':'statistical_baseline',
    lower:Math.max(0,prediction-radius),upper:prediction+radius,provenance:'estimated',
    observed_sample_increment:0,training_eligible:false,candidate_only:true};
}
