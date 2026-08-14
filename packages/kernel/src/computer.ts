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

export async function captureComputerScreen(provider: ComputerScreenProvider, signal?: AbortSignal): Promise<ComputerScreenResult> {
  if (!provider || typeof provider.capture !== "function") throw new Error("computer screen provider is unavailable");
  const target = normalizeTarget(provider.target, "computer screen provider.target");
  throwIfAborted(signal);
  const frame = await provider.capture({ target, signal });
  throwIfAborted(signal);
  const currentTarget = normalizeTarget(provider.target, "computer screen provider.target");
  if (!sameTarget(currentTarget, target)) throw new Error("computer screen pairing target changed during capture");
  return normalizeFrame(frame, currentTarget);
}
