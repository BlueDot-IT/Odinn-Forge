import { CapabilityBroker } from "../differentiated-runtime.ts";
import type { RuntimePlugin } from "./types.ts";

export const capabilityTokensPlugin: RuntimePlugin<CapabilityBroker> = {
  id: "capabilities",
  displayName: "Capability Tokens",
  configKey: "experimental.capabilities",
  create: ({ ledger, stateDir, featureFlags }) => new CapabilityBroker({ ledger, stateDir, featureFlags })
};
