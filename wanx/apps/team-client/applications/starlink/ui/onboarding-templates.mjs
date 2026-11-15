import {samples} from './onboarding-state.mjs';

// Both entry points fill the same editable warehouse inputs; they do not
// create a warehouse or submit a user's answer.
export const dialogueTemplates=samples.map(sample=>({
  label:sample.name,
  description:sample.material_types,
  name:sample.warehouse_name,
  purpose:`主要资料：${sample.material_types}。用途：${sample.purpose}。`,
}));
