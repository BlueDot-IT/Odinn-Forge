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

export type ExperimentalFeature = (typeof EXPERIMENTAL_FEATURES)[number];
export type ExperimentalFlags = Record<ExperimentalFeature, boolean>;

export function normalizeExperimentalFlags(value: unknown = {}): ExperimentalFlags {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value as Partial<Record<ExperimentalFeature, unknown>> : {};
  return Object.fromEntries(EXPERIMENTAL_FEATURES.map((name) => [name, source[name] === true])) as ExperimentalFlags;
}

export function experimentalFeatureWarning(flags: Partial<Record<ExperimentalFeature, boolean>> = {}) {
  const enabled = EXPERIMENTAL_FEATURES.filter((name) => flags[name] === true);
  return enabled.length ? `optional plugin modules enabled: ${enabled.join(", ")}` : "optional plugin modules disabled";
}
