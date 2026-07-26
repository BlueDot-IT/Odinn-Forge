import { CounterfactualManager } from "../differentiated-runtime.ts";
import type { RuntimePlugin } from "./types.ts";

export const counterfactualPlugin: RuntimePlugin<CounterfactualManager> = {
  id: "counterfactual",
  displayName: "Counterfactual",
  configKey: "experimental.counterfactual",
  create: ({ ledger, stateDir, featureFlags }) => new CounterfactualManager({ ledger, stateDir, featureFlags })
};
