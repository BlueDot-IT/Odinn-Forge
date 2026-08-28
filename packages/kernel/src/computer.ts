const MAX_IDENTIFIER_BYTES = 128;
const MAX_IMAGE_BASE64_BYTES = 8_000_000;
const MAX_SCREEN_WIDTH = 8_192;
const MAX_SCREEN_HEIGHT = 8_192;
const MAX_SCREEN_PIXELS = 33_554_432;

export type ComputerScreenTarget = Readonly<{
  nodeId: string;
  displayId: string;
  pairingGeneration: string;
}>;

export type ComputerScreenCaptureRequest = Readonly<{
  target: ComputerScreenTarget;
  signal?: AbortSignal;
}>;

export interface ComputerScreenProvider {
  readonly target: ComputerScreenTarget;
  capture(request: ComputerScreenCaptureRequest): Promise<unknown>;
  close?(): Promise<void> | void;
}

export type ComputerActionInput = Readonly<{
  frameId: string;
  action: "click" | "type" | "key" | "move" | "scroll" | "wait";
  x?: number;
  y?: number;
  button?: "left" | "middle" | "right";
  text?: string;
  sensitive?: boolean;
  key?: string;
  deltaX?: number;
  deltaY?: number;
  durationMs?: number;
}>;

export type ComputerAction =
  | Readonly<{ action: "click"; x: number; y: number; button: "left" | "middle" | "right" }>
  | Readonly<{ action: "type"; text: string; sensitive: boolean }>
  | Readonly<{ action: "key"; key: string }>
  | Readonly<{ action: "move"; x: number; y: number }>
  | Readonly<{ action: "scroll"; deltaX: number; deltaY: number }>
  | Readonly<{ action: "wait"; durationMs: number }>;

export type ComputerActRequest = Readonly<{
  target: ComputerScreenTarget;
  frameId: string;
  action: ComputerAction;
  signal?: AbortSignal;
}>;

export type ComputerRecoveryResolution = "confirmed-applied" | "confirmed-not-applied";

export interface ComputerControlProvider extends ComputerScreenProvider {
  act(request: ComputerActRequest): Promise<unknown>;
  recoveryStatus?(): Promise<unknown> | unknown;
  resolveRecovery?(request: Readonly<{ recoveryId: string; outcome: ComputerRecoveryResolution; signal?: AbortSignal }>): Promise<unknown>;
}

export type ComputerScreenResult = Readonly<{
  type: "computer.screen";
  frameId: string;
  target: Readonly<{ nodeId: string; displayId: string }>;
  capturedAt: string;
  width: number;
  height: number;
  mimeType: "image/png" | "image/jpeg";
  imageBase64: string;
}>;

export type ComputerActResult =
  | Readonly<{
    type: "computer.act";
    status: "completed";
    action: ComputerAction["action"];
    beforeFrameId: string;
    afterFrame: ComputerScreenResult;
  }>
  | Readonly<{
    type: "computer.act";
    status: "needs-review";
    action: ComputerAction["action"];
    beforeFrameId: string;
    recoveryId: string;
    reason: "cancelled-after-dispatch" | "timeout" | "transport-lost" | "provider-uncertain";
  }>;

export type ComputerRecoveryStatus = Readonly<{
  type: "computer.recovery.status";
  unresolved: boolean;
  recoveryId?: string;
  frameId?: string;
  action?: ComputerAction["action"];
  reason?: "cancelled-after-dispatch" | "timeout" | "transport-lost" | "provider-uncertain";
}>;

type RecordValue = Record<string, unknown>;

function plainObject(value: unknown, label: string): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as RecordValue;
}

function boundedIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > MAX_IDENTIFIER_BYTES || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${label} must be a bounded identifier`);
  }
  return value;
}

function boundedInteger(value: unknown, minimum: number, maximum: number, label: string): number {
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return Number(value);
}

function assertOnlyKeys(source: RecordValue, allowed: readonly string[], label: string): void {
  const allow = new Set(allowed);
  const unknown = Object.keys(source).filter((key) => !allow.has(key));
  if (unknown.length) throw new Error(`${label} contains unsupported fields: ${unknown.sort().join(", ")}`);
}

const COMPUTER_KEY = /^(?:(?:Alt|Command|Control|Option|Shift)\+){0,4}(?:[A-Za-z0-9]|Enter|Tab|Escape|Space|Backspace|Delete|Home|End|PageUp|PageDown|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|F(?:[1-9]|1[0-2]))$/u;

export function normalizeComputerActionInput(value: unknown): Readonly<{ frameId: string; action: ComputerAction }> {
  const source = plainObject(value, "computer action input");
  const frameId = boundedIdentifier(source.frameId, "computer action input.frameId");
  const action = source.action;
  if (action === "click") {
    assertOnlyKeys(source, ["frameId", "action", "x", "y", "button"], "computer action input");
    const button = source.button ?? "left";
    if (button !== "left" && button !== "middle" && button !== "right") throw new Error("computer action input.button is unsupported");
    return Object.freeze({ frameId, action: Object.freeze({ action, x: boundedInteger(source.x, 0, MAX_SCREEN_WIDTH - 1, "computer action input.x"), y: boundedInteger(source.y, 0, MAX_SCREEN_HEIGHT - 1, "computer action input.y"), button }) });
  }
  if (action === "move") {
    assertOnlyKeys(source, ["frameId", "action", "x", "y"], "computer action input");
    return Object.freeze({ frameId, action: Object.freeze({ action, x: boundedInteger(source.x, 0, MAX_SCREEN_WIDTH - 1, "computer action input.x"), y: boundedInteger(source.y, 0, MAX_SCREEN_HEIGHT - 1, "computer action input.y") }) });
  }
  if (action === "type") {
    assertOnlyKeys(source, ["frameId", "action", "text", "sensitive"], "computer action input");
    if (typeof source.text !== "string" || source.text.length === 0 || Buffer.byteLength(source.text, "utf8") > 4_096 || source.text.includes("\0")) {
      throw new Error("computer action input.text must be non-empty bounded text");
    }
    if (source.sensitive !== undefined && typeof source.sensitive !== "boolean") throw new Error("computer action input.sensitive must be boolean");
    return Object.freeze({ frameId, action: Object.freeze({ action, text: source.text, sensitive: source.sensitive === true }) });
  }
  if (action === "key") {
    assertOnlyKeys(source, ["frameId", "action", "key"], "computer action input");
    if (typeof source.key !== "string" || !COMPUTER_KEY.test(source.key)) throw new Error("computer action input.key is unsupported");
    return Object.freeze({ frameId, action: Object.freeze({ action, key: source.key }) });
  }
  if (action === "scroll") {
    assertOnlyKeys(source, ["frameId", "action", "deltaX", "deltaY"], "computer action input");
    const deltaX = boundedInteger(source.deltaX ?? 0, -8_192, 8_192, "computer action input.deltaX");
    const deltaY = boundedInteger(source.deltaY ?? 0, -8_192, 8_192, "computer action input.deltaY");
    if (deltaX === 0 && deltaY === 0) throw new Error("computer action input scroll delta must not be zero");
    return Object.freeze({ frameId, action: Object.freeze({ action, deltaX, deltaY }) });
  }
  if (action === "wait") {
    assertOnlyKeys(source, ["frameId", "action", "durationMs"], "computer action input");
    return Object.freeze({ frameId, action: Object.freeze({ action, durationMs: boundedInteger(source.durationMs, 50, 5_000, "computer action input.durationMs") }) });
  }
  throw new Error("computer action input.action is unsupported");
}

function normalizeTarget(value: unknown, label: string): ComputerScreenTarget {
  const source = plainObject(value, label);
  return Object.freeze({
    nodeId: boundedIdentifier(source.nodeId, `${label}.nodeId`),
    displayId: boundedIdentifier(source.displayId, `${label}.displayId`),
    pairingGeneration: boundedIdentifier(source.pairingGeneration, `${label}.pairingGeneration`)
  });
}

function sameTarget(left: ComputerScreenTarget, right: ComputerScreenTarget): boolean {
  return left.nodeId === right.nodeId && left.displayId === right.displayId && left.pairingGeneration === right.pairingGeneration;
}

function executionTarget(provider: ComputerScreenProvider, resource: unknown, label: string): ComputerScreenTarget {
  return resource === undefined
    ? normalizeTarget(provider.target, `${label} provider.target`)
    : normalizeTarget(resource, `${label} trusted execution resource`);
}

function assertProviderTarget(provider: ComputerScreenProvider, expected: ComputerScreenTarget, label: string): void {
  const current = normalizeTarget(provider.target, `${label} provider.target`);
  if (!sameTarget(current, expected)) throw new Error(`${label} pairing target changed before provider dispatch`);
}

function assertExecutionField(resource: unknown, field: string, expected: string, label: string): void {
  if (resource === undefined) return;
  const source = plainObject(resource, `${label} trusted execution resource`);
  if (boundedIdentifier(source[field], `${label} trusted execution resource.${field}`) !== expected) {
    throw new Error(`${label} trusted execution resource does not match the approved ${field}`);
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("computer screen capture aborted");
}

function normalizeImage(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_IMAGE_BASE64_BYTES || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) {
    throw new Error("computer screen image must be bounded base64 data");
  }
  const decodedBytes = Buffer.byteLength(value, "base64");
  if (decodedBytes === 0 || decodedBytes > MAX_IMAGE_BASE64_BYTES) throw new Error("computer screen image exceeds the bounded byte limit");
  return value;
}

function assertImageHeader(value: string, mimeType: "image/png" | "image/jpeg", width: number, height: number): void {
  const bytes = Buffer.from(value, "base64");
  if (mimeType === "image/png") {
    const validSignature = bytes.length >= 24
      && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      && bytes.subarray(12, 16).toString("ascii") === "IHDR";
    if (!validSignature || bytes.readUInt32BE(16) !== width || bytes.readUInt32BE(20) !== height) {
      throw new Error("computer screen PNG header does not match its declared dimensions");
    }
    return;
  }
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error("computer screen JPEG header is invalid");
  for (let offset = 2; offset + 9 < bytes.length;) {
    if (bytes[offset] !== 0xff) throw new Error("computer screen JPEG markers are invalid");
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) break;
    const marker = bytes[offset]!;
    offset += 1;
    if (marker === 0xd9 || marker === 0xda) break;
    if (offset + 2 > bytes.length) break;
    const segmentLength = bytes.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) throw new Error("computer screen JPEG segment is invalid");
    const isStartOfFrame = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isStartOfFrame) {
      if (segmentLength < 7 || bytes.readUInt16BE(offset + 3) !== height || bytes.readUInt16BE(offset + 5) !== width) {
        throw new Error("computer screen JPEG header does not match its declared dimensions");
      }
      return;
    }
    offset += segmentLength;
  }
  throw new Error("computer screen JPEG dimensions are unavailable");
}

function normalizeFrame(value: unknown, target: ComputerScreenTarget): ComputerScreenResult {
  const source = plainObject(value, "computer screen capture");
  const returnedTarget = normalizeTarget(source.target, "computer screen capture.target");
  if (returnedTarget.nodeId !== target.nodeId || returnedTarget.displayId !== target.displayId || returnedTarget.pairingGeneration !== target.pairingGeneration) {
    throw new Error("computer screen capture target does not match the paired host target");
  }
  const frameId = boundedIdentifier(source.frameId, "computer screen capture.frameId");
  const capturedAt = boundedIdentifier(source.capturedAt, "computer screen capture.capturedAt");
  if (!Number.isInteger(Date.parse(capturedAt))) throw new Error("computer screen capture.capturedAt must be a valid timestamp");
  const width = typeof source.width === "number" ? source.width : Number.NaN;
  const height = typeof source.height === "number" ? source.height : Number.NaN;
  if (!Number.isInteger(width) || width < 1 || width > MAX_SCREEN_WIDTH || !Number.isInteger(height) || height < 1 || height > MAX_SCREEN_HEIGHT || width * height > MAX_SCREEN_PIXELS) {
    throw new Error("computer screen dimensions exceed the bounded display limit");
  }
  const mimeType = source.mimeType;
  if (mimeType !== "image/png" && mimeType !== "image/jpeg") throw new Error("computer screen image type is unsupported");
  const imageBase64 = normalizeImage(source.imageBase64);
  assertImageHeader(imageBase64, mimeType, width, height);
  return Object.freeze({
    type: "computer.screen",
    frameId,
    target: Object.freeze({ nodeId: target.nodeId, displayId: target.displayId }),
    capturedAt,
    width,
    height,
    mimeType,
    imageBase64
  });
}

export async function captureComputerScreen(provider: ComputerScreenProvider, signal?: AbortSignal, trustedExecutionResource?: unknown): Promise<ComputerScreenResult> {
  if (!provider || typeof provider.capture !== "function") throw new Error("computer screen provider is unavailable");
  const target = executionTarget(provider, trustedExecutionResource, "computer screen");
  throwIfAborted(signal);
  if (trustedExecutionResource !== undefined) assertProviderTarget(provider, target, "computer screen");
  const frame = await provider.capture({ target, signal });
  throwIfAborted(signal);
  const currentTarget = normalizeTarget(provider.target, "computer screen provider.target");
  if (!sameTarget(currentTarget, target)) throw new Error("computer screen pairing target changed during capture");
  return normalizeFrame(frame, currentTarget);
}

function normalizeActResult(value: unknown, target: ComputerScreenTarget, input: Readonly<{ frameId: string; action: ComputerAction }>): ComputerActResult {
  const source = plainObject(value, "computer action result");
  const returnedTarget = normalizeTarget(source.target, "computer action result.target");
  if (!sameTarget(returnedTarget, target)) throw new Error("computer action result target does not match the paired host target");
  if (source.beforeFrameId !== input.frameId) throw new Error("computer action result does not match the approved frame");
  if (source.status === "completed") {
    const afterFrame = normalizeFrame(source.afterFrame, target);
    return Object.freeze({ type: "computer.act", status: "completed", action: input.action.action, beforeFrameId: input.frameId, afterFrame });
  }
  if (source.status === "needs-review") {
    const reason = source.reason;
    if (reason !== "cancelled-after-dispatch" && reason !== "timeout" && reason !== "transport-lost" && reason !== "provider-uncertain") {
      throw new Error("computer action uncertainty reason is unsupported");
    }
    return Object.freeze({
      type: "computer.act",
      status: "needs-review",
      action: input.action.action,
      beforeFrameId: input.frameId,
      recoveryId: boundedIdentifier(source.recoveryId, "computer action result.recoveryId"),
      reason
    });
  }
  throw new Error("computer action result status is unsupported");
}

export async function performComputerAction(provider: ComputerControlProvider, value: unknown, signal?: AbortSignal, trustedExecutionResource?: unknown): Promise<ComputerActResult> {
  if (!provider || typeof provider.act !== "function") throw new Error("computer control provider is unavailable");
  const target = executionTarget(provider, trustedExecutionResource, "computer control");
  const input = normalizeComputerActionInput(value);
  assertExecutionField(trustedExecutionResource, "frameId", input.frameId, "computer control");
  throwIfAborted(signal);
  if (trustedExecutionResource !== undefined) assertProviderTarget(provider, target, "computer control");
  const result = await provider.act({ target, frameId: input.frameId, action: input.action, signal });
  const currentTarget = normalizeTarget(provider.target, "computer control provider.target");
  if (!sameTarget(currentTarget, target)) throw new Error("computer control pairing target changed during action");
  return normalizeActResult(result, currentTarget, input);
}

export async function inspectComputerRecovery(provider: ComputerControlProvider, trustedExecutionResource?: unknown): Promise<ComputerRecoveryStatus> {
  if (typeof provider.recoveryStatus !== "function") return Object.freeze({ type: "computer.recovery.status", unresolved: false });
  const target = executionTarget(provider, trustedExecutionResource, "computer recovery status");
  if (trustedExecutionResource !== undefined) assertProviderTarget(provider, target, "computer recovery status");
  const source = plainObject(await provider.recoveryStatus(), "computer recovery status");
  const currentTarget = normalizeTarget(provider.target, "computer recovery status provider.target");
  if (!sameTarget(currentTarget, target)) throw new Error("computer recovery status pairing target changed during provider dispatch");
  if (typeof source.unresolved !== "boolean") throw new Error("computer recovery status.unresolved must be boolean");
  if (!source.unresolved) return Object.freeze({ type: "computer.recovery.status", unresolved: false });
  const action = source.action;
  if (action !== "click" && action !== "type" && action !== "key" && action !== "move" && action !== "scroll" && action !== "wait") {
    throw new Error("computer recovery status.action is unsupported");
  }
  const reason = source.reason;
  if (reason !== "cancelled-after-dispatch" && reason !== "timeout" && reason !== "transport-lost" && reason !== "provider-uncertain") {
    throw new Error("computer recovery status.reason is unsupported");
  }
  return Object.freeze({
    type: "computer.recovery.status",
    unresolved: true,
    recoveryId: boundedIdentifier(source.recoveryId, "computer recovery status.recoveryId"),
    frameId: boundedIdentifier(source.frameId, "computer recovery status.frameId"),
    action,
    reason
  });
}

export async function resolveComputerRecovery(provider: ComputerControlProvider, value: unknown, signal?: AbortSignal, trustedExecutionResource?: unknown): Promise<Readonly<{ type: "computer.recovery.resolve"; status: "resolved"; recoveryId: string; outcome: ComputerRecoveryResolution }>> {
  if (typeof provider.resolveRecovery !== "function") throw new Error("computer recovery resolution is unavailable");
  const source = plainObject(value, "computer recovery resolution");
  assertOnlyKeys(source, ["recoveryId", "outcome"], "computer recovery resolution");
  const recoveryId = boundedIdentifier(source.recoveryId, "computer recovery resolution.recoveryId");
  const outcome = source.outcome;
  if (outcome !== "confirmed-applied" && outcome !== "confirmed-not-applied") throw new Error("computer recovery resolution.outcome is unsupported");
  const target = executionTarget(provider, trustedExecutionResource, "computer recovery resolution");
  assertExecutionField(trustedExecutionResource, "recoveryId", recoveryId, "computer recovery resolution");
  assertExecutionField(trustedExecutionResource, "outcome", outcome, "computer recovery resolution");
  throwIfAborted(signal);
  if (trustedExecutionResource !== undefined) assertProviderTarget(provider, target, "computer recovery resolution");
  await provider.resolveRecovery({ recoveryId, outcome, signal });
  const currentTarget = normalizeTarget(provider.target, "computer recovery resolution provider.target");
  if (!sameTarget(currentTarget, target)) throw new Error("computer recovery resolution pairing target changed during provider dispatch");
  return Object.freeze({ type: "computer.recovery.resolve", status: "resolved", recoveryId, outcome });
}
