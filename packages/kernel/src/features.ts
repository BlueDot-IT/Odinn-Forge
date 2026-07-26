export const EXPERIMENTAL_FEATURES = Object.freeze([
  "capsules",
  "capabilities",
  "counterfactual"
] as const);

export const CORE_ADVANCED_FEATURES = Object.freeze([
  "proof",
  "sentinel",
  "rewind",
  "darwin"
] as const);

export const ADVANCED_FEATURE_BRANDS = Object.freeze({
  proof: Object.freeze({
    name: "Runemark",
    descriptor: "Run verification",
    legacyName: "Proof"
  }),
  sentinel: Object.freeze({
    name: "Gatewatch",
    descriptor: "Policy safety",
    legacyName: "Sentinel"
  }),
  rewind: Object.freeze({
    name: "Norn Restore",
    descriptor: "Restore points",
    legacyName: "Rewind"
  }),
  darwin: Object.freeze({
    name: "Raven Route",
    descriptor: "Model routing",
    legacyName: "Darwin"
  }),
  capabilities: Object.freeze({
    name: "Rune Key",
    descriptor: "Scoped temporary access",
    legacyName: "Capability Tokens"
  }),
  capsules: Object.freeze({
    name: "Saga Archive",
    descriptor: "Portable run bundles",
    legacyName: "Capsules"
  }),
  counterfactual: Object.freeze({
    name: "Worldtree Paths",
    descriptor: "Scenario comparison",
    legacyName: "Counterfactual"
  })
} as const);

export type AdvancedFeature = keyof typeof ADVANCED_FEATURE_BRANDS;
export type ExperimentalFeature = (typeof EXPERIMENTAL_FEATURES)[number];
export type ExperimentalFlags = Record<ExperimentalFeature, boolean>;

export function advancedFeatureLabel(feature: AdvancedFeature) {
  const brand = ADVANCED_FEATURE_BRANDS[feature];
  return `${brand.name} — ${brand.descriptor}`;
}

export function normalizeExperimentalFlags(value: unknown = {}): ExperimentalFlags {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value as Partial<Record<ExperimentalFeature, unknown>> : {};
  return Object.fromEntries(EXPERIMENTAL_FEATURES.map((name) => [name, source[name] === true])) as ExperimentalFlags;
}

export function experimentalFeatureWarning(flags: Partial<Record<ExperimentalFeature, boolean>> = {}) {
  const enabled = EXPERIMENTAL_FEATURES.filter((name) => flags[name] === true);
  const labels = enabled.map((name) => `${ADVANCED_FEATURE_BRANDS[name].name} (${name})`);
  return labels.length ? `optional plugin modules enabled: ${labels.join(", ")}` : "optional plugin modules disabled";
}
