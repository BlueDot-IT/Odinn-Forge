import type { ProviderTransport } from "./providers/types.ts";

export const PROVIDER_CAPABILITY_SCHEMA_VERSION = 1 as const;
export const PROVIDER_CAPABILITY_IDS = Object.freeze([
  "text-generation",
  "streaming",
  "tool-calling",
  "structured-output",
  "image-input",
  "audio-input",
  "embeddings"
] as const);

export type ProviderCapabilityId = typeof PROVIDER_CAPABILITY_IDS[number];
export type ProviderCapabilityStatus = "supported" | "unsupported" | "unknown";
export type ProviderCapabilitySource =
  | "unverified"
  | "operator-configured"
  | "runtime-observed";
export type ProviderCompatibilityStatus = "compatible" | "incompatible" | "unknown";

export type ProviderCapabilityClaim = {
  capability: ProviderCapabilityId;
  status: ProviderCapabilityStatus;
  source: Exclude<ProviderCapabilitySource, "unverified">;
  note?: string;
  observedAt?: string;
};

export type ProviderCapabilityRecord = {
  capability: ProviderCapabilityId;
  transportStatus: Exclude<ProviderCapabilityStatus, "unknown">;
  providerStatus: ProviderCapabilityStatus;
  status: ProviderCapabilityStatus;
  source: ProviderCapabilitySource;
  transportNote: string;
  note?: string;
  observedAt?: string;
};

export type ProviderCapabilityMetadata = {
  schemaVersion: typeof PROVIDER_CAPABILITY_SCHEMA_VERSION;
  providerId: string;
  modelId?: string;
  transport: ProviderTransport;
  capabilities: Readonly<Record<ProviderCapabilityId, ProviderCapabilityRecord>>;
};

export type ProviderCompatibilityAssessment = {
  status: ProviderCompatibilityStatus;
  providerId: string;
  modelId?: string;
  required: readonly ProviderCapabilityId[];
  unsupported: readonly ProviderCapabilityId[];
  unknown: readonly ProviderCapabilityId[];
};

const MAX_IDENTIFIER_BYTES = 128;
const MAX_NOTE_BYTES = 512;
const MAX_CLAIMS = PROVIDER_CAPABILITY_IDS.length;
const MAX_REQUIREMENTS = PROVIDER_CAPABILITY_IDS.length;
const MAX_FUTURE_OBSERVATION_SKEW_MS = 60_000;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u;
const CAPABILITY_IDS = new Set<string>(PROVIDER_CAPABILITY_IDS);
const CLAIM_KEYS = new Set(["capability", "status", "source", "note", "observedAt"]);
const METADATA_KEYS = new Set(["providerId", "modelId", "transport", "claims", "now"]);
const STATUSES = new Set<ProviderCapabilityStatus>(["supported", "unsupported", "unknown"]);
const CLAIM_SOURCES = new Set<ProviderCapabilityClaim["source"]>([
  "operator-configured",
  "runtime-observed"
]);
const TRANSPORTS = new Set<ProviderTransport>([
  "openai-chat-completions",
  "openai-responses",
  "openai-chatgpt-responses",
  "cli-antigravity"
]);

const CHAT_COMPLETIONS_TRANSPORT_RECORDS = {
  "text-generation": record("text-generation", "supported", "The adapter has a tested text request and response contract."),
  streaming: record("streaming", "supported", "The adapter honors caller-requested streaming responses."),
  "tool-calling": record("tool-calling", "supported", "The adapter can carry structured tool calls."),
  "structured-output": record("structured-output", "unsupported", "The current adapter does not expose a structured-output request contract."),
  "image-input": record("image-input", "unsupported", "The current adapter accepts text message content only."),
  "audio-input": record("audio-input", "unsupported", "The current adapter accepts text message content only."),
  embeddings: record("embeddings", "unsupported", "The current adapter exposes chat generation only.")
} satisfies Record<ProviderCapabilityId, ProviderCapabilityRecord>;

const RESPONSES_TRANSPORT_RECORDS = {
  ...CHAT_COMPLETIONS_TRANSPORT_RECORDS,
  streaming: record("streaming", "unsupported", "The Responses adapter currently ignores caller-requested streaming.")
} satisfies Record<ProviderCapabilityId, ProviderCapabilityRecord>;

const CHATGPT_RESPONSES_TRANSPORT_RECORDS = {
  ...CHAT_COMPLETIONS_TRANSPORT_RECORDS,
  streaming: record("streaming", "supported", "The ChatGPT Responses adapter consumes its required streaming response.")
} satisfies Record<ProviderCapabilityId, ProviderCapabilityRecord>;

const CLI_TRANSPORT_RECORDS = {
  "text-generation": record("text-generation", "supported", "The CLI adapter has a tested text request and response contract."),
  streaming: record("streaming", "unsupported", "The CLI adapter returns one bounded final response."),
  "tool-calling": record("tool-calling", "unsupported", "The CLI adapter does not carry structured tool calls."),
  "structured-output": record("structured-output", "unsupported", "The CLI adapter does not expose a structured-output request contract."),
  "image-input": record("image-input", "unsupported", "The CLI adapter accepts a text prompt only."),
  "audio-input": record("audio-input", "unsupported", "The CLI adapter accepts a text prompt only."),
  embeddings: record("embeddings", "unsupported", "The CLI adapter exposes text generation only.")
} satisfies Record<ProviderCapabilityId, ProviderCapabilityRecord>;

function record(
  capability: ProviderCapabilityId,
  transportStatus: Exclude<ProviderCapabilityStatus, "unknown">,
  transportNote: string
): ProviderCapabilityRecord {
  return Object.freeze({
    capability,
    transportStatus,
    providerStatus: "unknown",
    status: transportStatus === "unsupported" ? "unsupported" : "unknown",
    source: "unverified",
    transportNote
  });
}

function strictObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function boundedIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) {
    throw new Error(`${label} must be a non-empty identifier`);
  }
  if (Buffer.byteLength(value, "utf8") > MAX_IDENTIFIER_BYTES) {
    throw new Error(`${label} exceeds ${MAX_IDENTIFIER_BYTES} UTF-8 bytes`);
  }
  return value;
}

function optionalNote(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() !== value || value.length === 0) {
    throw new Error("capability claim note must be a non-empty, trimmed string");
  }
  if (Buffer.byteLength(value, "utf8") > MAX_NOTE_BYTES) {
    throw new Error(`capability claim note exceeds ${MAX_NOTE_BYTES} UTF-8 bytes`);
  }
  return value;
}

function optionalTimestamp(
  value: unknown,
  source: ProviderCapabilityClaim["source"],
  now: number
): string | undefined {
  if (value === undefined) {
    if (source === "runtime-observed") throw new Error("runtime-observed claims require observedAt");
    return undefined;
  }
  if (source !== "runtime-observed") {
    throw new Error("only runtime-observed claims may define observedAt");
  }
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)) {
    throw new Error("capability claim observedAt must be a UTC ISO 8601 timestamp");
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value.replace(/Z$/u, value.includes(".") ? "Z" : ".000Z")) {
    throw new Error("capability claim observedAt must be a valid UTC timestamp");
  }
  if (parsed > now + MAX_FUTURE_OBSERVATION_SKEW_MS) {
    throw new Error(`capability claim observedAt exceeds the ${MAX_FUTURE_OBSERVATION_SKEW_MS} ms future-skew limit`);
  }
  return value;
}

function validateClaim(value: unknown, index: number, now: number): ProviderCapabilityClaim {
  const claim = strictObject(value, `capability claim ${index + 1}`);
  for (const key of Object.keys(claim)) {
    if (!CLAIM_KEYS.has(key)) throw new Error(`capability claim ${index + 1} has unknown field: ${key}`);
  }
  if (typeof claim.capability !== "string" || !CAPABILITY_IDS.has(claim.capability)) {
    throw new Error(`capability claim ${index + 1} has an unknown capability`);
  }
  if (typeof claim.status !== "string" || !STATUSES.has(claim.status as ProviderCapabilityStatus)) {
    throw new Error(`capability claim ${index + 1} has an invalid status`);
  }
  if (typeof claim.source !== "string" || !CLAIM_SOURCES.has(claim.source as ProviderCapabilityClaim["source"])) {
    throw new Error(`capability claim ${index + 1} has an invalid source`);
  }
  const source = claim.source as ProviderCapabilityClaim["source"];
  const note = optionalNote(claim.note);
  const observedAt = optionalTimestamp(claim.observedAt, source, now);
  return {
    capability: claim.capability as ProviderCapabilityId,
    status: claim.status as ProviderCapabilityStatus,
    source,
    ...(note ? { note } : {}),
    ...(observedAt ? { observedAt } : {})
  };
}

function transportRecords(transport: ProviderTransport): Record<ProviderCapabilityId, ProviderCapabilityRecord> {
  if (transport === "cli-antigravity") return CLI_TRANSPORT_RECORDS;
  if (transport === "openai-responses") return RESPONSES_TRANSPORT_RECORDS;
  if (transport === "openai-chatgpt-responses") return CHATGPT_RESPONSES_TRANSPORT_RECORDS;
  return CHAT_COMPLETIONS_TRANSPORT_RECORDS;
}

/**
 * Builds bounded, in-memory metadata only when explicitly called. It performs no
 * discovery, network access, persistence, credential access, or billing fallback.
 */
export function createProviderCapabilityMetadata(input: {
  providerId: string;
  modelId?: string;
  transport: ProviderTransport;
  claims?: readonly ProviderCapabilityClaim[];
  now?: number;
}): ProviderCapabilityMetadata {
  const value = strictObject(input, "provider capability metadata");
  for (const key of Object.keys(value)) {
    if (!METADATA_KEYS.has(key)) throw new Error(`provider capability metadata has unknown field: ${key}`);
  }
  const providerId = boundedIdentifier(value.providerId, "providerId");
  const modelId = value.modelId === undefined ? undefined : boundedIdentifier(value.modelId, "modelId");
  if (typeof value.transport !== "string" || !TRANSPORTS.has(value.transport as ProviderTransport)) {
    throw new Error("provider capability metadata has an unsupported transport");
  }
  const transport = value.transport as ProviderTransport;
  if (value.claims !== undefined && !Array.isArray(value.claims)) {
    throw new Error("provider capability claims must be an array");
  }
  const claims = (value.claims ?? []) as readonly unknown[];
  if (claims.length > MAX_CLAIMS) throw new Error(`provider capability metadata allows at most ${MAX_CLAIMS} claims`);
  if (claims.length && !modelId) throw new Error("provider capability claims require an exact modelId");
  const now = value.now === undefined ? Date.now() : value.now;
  if (typeof now !== "number" || !Number.isSafeInteger(now) || now < 0) {
    throw new Error("provider capability metadata now must be a non-negative safe integer");
  }

  const capabilities = { ...transportRecords(transport) };
  const seen = new Set<ProviderCapabilityId>();
  for (const [index, rawClaim] of claims.entries()) {
    const claim = validateClaim(rawClaim, index, now);
    if (seen.has(claim.capability)) throw new Error(`duplicate capability claim: ${claim.capability}`);
    seen.add(claim.capability);
    const transportRecord = capabilities[claim.capability];
    if (transportRecord.transportStatus === "unsupported" && claim.status === "supported") {
      throw new Error(`capability ${claim.capability} is unsupported by transport ${transport}`);
    }
    capabilities[claim.capability] = Object.freeze({
      capability: claim.capability,
      transportStatus: transportRecord.transportStatus,
      providerStatus: claim.status,
      status: transportRecord.transportStatus === "unsupported" || claim.status === "unsupported"
        ? "unsupported"
        : claim.status,
      source: claim.source,
      transportNote: transportRecord.transportNote,
      ...(claim.note ? { note: claim.note } : {}),
      ...(claim.observedAt ? { observedAt: claim.observedAt } : {})
    });
  }

  return Object.freeze({
    schemaVersion: PROVIDER_CAPABILITY_SCHEMA_VERSION,
    providerId,
    ...(modelId ? { modelId } : {}),
    transport,
    capabilities: Object.freeze(capabilities)
  });
}

/**
 * Unknown support fails closed: it is reported as unknown, never compatible.
 * Callers choose whether to ask for operator input, select another model, or fail.
 */
export function assessProviderCompatibility(
  metadata: ProviderCapabilityMetadata,
  required: readonly ProviderCapabilityId[]
): ProviderCompatibilityAssessment {
  if (!Array.isArray(required)) throw new Error("provider capability requirements must be an array");
  if (required.length > MAX_REQUIREMENTS) {
    throw new Error(`provider compatibility allows at most ${MAX_REQUIREMENTS} requirements`);
  }
  const unique = new Set<ProviderCapabilityId>();
  for (const [index, capability] of required.entries()) {
    if (typeof capability !== "string" || !CAPABILITY_IDS.has(capability)) {
      throw new Error(`provider capability requirement ${index + 1} is unknown`);
    }
    const knownCapability = capability as ProviderCapabilityId;
    if (unique.has(knownCapability)) throw new Error(`duplicate provider capability requirement: ${capability}`);
    unique.add(knownCapability);
  }

  const unsupported = [...unique].filter((capability) => metadata.capabilities[capability].status === "unsupported");
  const unknown = [...unique].filter((capability) => metadata.capabilities[capability].status === "unknown");
  const status: ProviderCompatibilityStatus = unsupported.length
    ? "incompatible"
    : unknown.length
      ? "unknown"
      : "compatible";
  return Object.freeze({
    status,
    providerId: metadata.providerId,
    ...(metadata.modelId ? { modelId: metadata.modelId } : {}),
    required: Object.freeze([...unique]),
    unsupported: Object.freeze(unsupported),
    unknown: Object.freeze(unknown)
  });
}
