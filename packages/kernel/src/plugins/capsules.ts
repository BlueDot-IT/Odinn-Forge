import { CapsuleManager } from "../differentiated-runtime.ts";
import type { RuntimePlugin } from "./types.ts";

export const capsulesPlugin: RuntimePlugin<CapsuleManager> = {
  id: "capsules",
  displayName: "Capsules",
  configKey: "experimental.capsules",
  create: ({ ledger, stateDir, featureFlags }) => new CapsuleManager({ ledger, stateDir, featureFlags })
};
