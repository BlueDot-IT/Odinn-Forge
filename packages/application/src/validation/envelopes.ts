import {
  APPLICATION_CONTRACT_VERSION,
  MAX_APPLICATION_CONTRACT_BYTES,
  type ApplicationEnvelopeV1,
  type InboundEnvelopeV1,
  type OutboundEnvelopeV1
} from "../contracts.ts";
import { finish } from "./canonical-json.ts";
import { invalid } from "./errors.ts";
import {
  boundedString,
  enumValue,
  exactObject,
  identifier,
  jsonObject,
  jsonValue,
  reference,
  rejectDuplicateJsonObjectKeys,
  timestamp,
  versionAndKind
} from "./json-safety.ts";
import { MAX_ID_BYTES, MAX_REFERENCE_BYTES } from "./limits.ts";
import { validateChannelDeliveryReceiptV1 } from "./receipts.ts";

export function parseApplicationEnvelopeV1(source: string): ApplicationEnvelopeV1 {
  if (typeof source !== "string") throw invalid("application envelope source must be a JSON string");
  if (Buffer.byteLength(source, "utf8") > MAX_APPLICATION_CONTRACT_BYTES) {
    throw invalid(`application envelope exceeds ${MAX_APPLICATION_CONTRACT_BYTES} bytes`, "APPLICATION_CONTRACT_TOO_LARGE");
  }
  rejectDuplicateJsonObjectKeys(source);
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch (error) {
    throw invalid(`application envelope is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return validateApplicationEnvelopeV1(parsed);
}

export function validateApplicationEnvelopeV1(input: unknown): ApplicationEnvelopeV1 {
  const header = exactObject(input, "application envelope", ["kind"], { allowAdditional: true });
  switch (header.kind) {
    case "inbound": return validateInboundEnvelopeV1(input);
    case "outbound": return validateOutboundEnvelopeV1(input);
    case "channel-delivery-receipt": return validateChannelDeliveryReceiptV1(input);
    default: throw invalid("application envelope kind is not wire-admissible", "UNSUPPORTED_APPLICATION_ENVELOPE_KIND", "kind");
  }
}

export function validateInboundEnvelopeV1(input: unknown): InboundEnvelopeV1 {
  const value = exactObject(input, "inbound envelope", [
    "version", "kind", "envelopeId", "source", "sourceEventId", "receivedAt", "correlationId", "causationId",
    "identityClaims", "scopeClaims", "payload", "redactedMetadata"
  ]);
  versionAndKind(value, "inbound");
  const sourceValue = exactObject(value.source, "source", ["kind", "adapterId", "accountReference"]);
  const source = {
    kind: enumValue(sourceValue.kind, "source.kind", ["cli", "http", "channel", "job", "workflow", "event", "agent", "mcp"]),
    adapterId: identifier(sourceValue.adapterId, "source.adapterId"),
    ...(sourceValue.accountReference === undefined ? {} : { accountReference: reference(sourceValue.accountReference, "source.accountReference") })
  } as const;
  if (source.kind !== "cli" && value.sourceEventId === undefined) {
    throw invalid("sourceEventId is required for retryable or externally delivered ingress", "SOURCE_EVENT_ID_REQUIRED", "sourceEventId");
  }
  const identityValue = exactObject(value.identityClaims, "identityClaims", ["claimedSubject", "claimedTenant", "claimedProject"]);
  const scopeValue = exactObject(value.scopeClaims, "scopeClaims", ["claimedConversation", "claimedSession", "claimedThread"]);
  const envelope: InboundEnvelopeV1 = {
    version: APPLICATION_CONTRACT_VERSION,
    kind: "inbound",
    envelopeId: identifier(value.envelopeId, "envelopeId"),
    source,
    ...(value.sourceEventId === undefined ? {} : { sourceEventId: identifier(value.sourceEventId, "sourceEventId") }),
    receivedAt: timestamp(value.receivedAt, "receivedAt"),
    correlationId: identifier(value.correlationId, "correlationId"),
    ...(value.causationId === undefined ? {} : { causationId: identifier(value.causationId, "causationId") }),
    identityClaims: {
      ...(identityValue.claimedSubject === undefined ? {} : { claimedSubject: boundedString(identityValue.claimedSubject, "identityClaims.claimedSubject", MAX_ID_BYTES) }),
      ...(identityValue.claimedTenant === undefined ? {} : { claimedTenant: boundedString(identityValue.claimedTenant, "identityClaims.claimedTenant", MAX_ID_BYTES) }),
      ...(identityValue.claimedProject === undefined ? {} : { claimedProject: boundedString(identityValue.claimedProject, "identityClaims.claimedProject", MAX_ID_BYTES) })
    },
    scopeClaims: {
      ...(scopeValue.claimedConversation === undefined ? {} : { claimedConversation: boundedString(scopeValue.claimedConversation, "scopeClaims.claimedConversation", MAX_REFERENCE_BYTES) }),
      ...(scopeValue.claimedSession === undefined ? {} : { claimedSession: boundedString(scopeValue.claimedSession, "scopeClaims.claimedSession", MAX_REFERENCE_BYTES) }),
      ...(scopeValue.claimedThread === undefined ? {} : { claimedThread: boundedString(scopeValue.claimedThread, "scopeClaims.claimedThread", MAX_REFERENCE_BYTES) })
    },
    payload: jsonValue(value.payload, "payload"),
    ...(value.redactedMetadata === undefined ? {} : { redactedMetadata: jsonObject(value.redactedMetadata, "redactedMetadata", true) })
  };
  return finish(envelope);
}

export function validateOutboundEnvelopeV1(input: unknown): OutboundEnvelopeV1 {
  const value = exactObject(input, "outbound envelope", [
    "version", "kind", "envelopeId", "correlationId", "causationId", "destination", "payload", "replyToReference", "redactedMetadata"
  ]);
  versionAndKind(value, "outbound");
  const destination = exactObject(value.destination, "destination", ["transport", "accountReference", "conversationReference", "threadReference"]);
  return finish({
    version: APPLICATION_CONTRACT_VERSION,
    kind: "outbound",
    envelopeId: identifier(value.envelopeId, "envelopeId"),
    correlationId: identifier(value.correlationId, "correlationId"),
    ...(value.causationId === undefined ? {} : { causationId: identifier(value.causationId, "causationId") }),
    destination: {
      transport: identifier(destination.transport, "destination.transport"),
      ...(destination.accountReference === undefined ? {} : { accountReference: reference(destination.accountReference, "destination.accountReference") }),
      conversationReference: reference(destination.conversationReference, "destination.conversationReference"),
      ...(destination.threadReference === undefined ? {} : { threadReference: reference(destination.threadReference, "destination.threadReference") })
    },
    payload: jsonValue(value.payload, "payload"),
    ...(value.replyToReference === undefined ? {} : { replyToReference: reference(value.replyToReference, "replyToReference") }),
    ...(value.redactedMetadata === undefined ? {} : { redactedMetadata: jsonObject(value.redactedMetadata, "redactedMetadata", true) })
  } satisfies OutboundEnvelopeV1);
}
