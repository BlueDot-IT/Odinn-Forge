import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { chmodSync, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { ComputerActRequest, ComputerControlProvider, ComputerRecoveryResolution, ComputerScreenCaptureRequest, ComputerScreenTarget } from "./computer.ts";

const SCREENSHOT = "/usr/sbin/screencapture";
const IMAGE_TOOL = "/usr/bin/sips";
const SCRIPT_HOST = "/usr/bin/osascript";
const MAX_SCREENSHOT_BYTES = 6_000_000;
const COMMAND_OUTPUT_BYTES = 16_384;
const PAIRING_FILE = "pairing.json";
const RECOVERY_FILE = "control-recovery.json";

type NodeError = Error & { code?: string };

export type MacOSComputerConfig = Readonly<{
  enabled: boolean;
  backend: "macos-local";
  nodeId: string;
  displayId: string;
}>;

export type MacOSComputerDiagnostic = Readonly<{
  status: "disabled" | "invalid" | "unavailable" | "configured";
  enabled: boolean;
  backend: "macos-local";
  reason?: "configuration-invalid" | "platform-unsupported" | "system-tools-unavailable";
  target?: Readonly<{ nodeId: string; displayId: string }>;
  permissions?: string;
  secretsExcluded: true;
}>;

export type ComputerCommandRequest = Readonly<{
  executable: string;
  args: readonly string[];
  input?: string;
  signal?: AbortSignal;
  timeoutMs: number;
}>;

export type ComputerCommandResult = Readonly<{
  stdout: string;
  stderr: string;
}>;

export type ComputerCommandRunner = (request: ComputerCommandRequest) => Promise<ComputerCommandResult>;

export type MacOSComputerDependencies = Readonly<{
  platform?: NodeJS.Platform;
  runner?: ComputerCommandRunner;
  now?: () => string;
  validateExecutable?: (path: string) => void;
}>;

type RecoveryRecord = Readonly<{
  schemaVersion: 1;
  recoveryId: string;
  frameId: string;
  action: "click" | "type" | "key" | "move" | "scroll";
  reason: "cancelled-after-dispatch" | "timeout" | "transport-lost" | "provider-uncertain";
  dispatchedAt: string;
}>;

function boundedId(value: unknown, fallback: string, label: string): string {
  const candidate = value === undefined ? fallback : value;
  if (typeof candidate !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(candidate)) {
    throw new Error(`${label} must be a bounded identifier`);
  }
  return candidate;
}

function macOSDisplayNumber(displayId: string): number {
  if (displayId === "main") return 1;
  const match = /^display-([1-9]|1[0-6])$/u.exec(displayId);
  if (!match) throw new Error("integrations.computer.displayId must be main or display-1 through display-16");
  return Number(match[1]);
}

export function normalizeMacOSComputerConfig(value: unknown): MacOSComputerConfig {
  if (value === undefined || value === null) return Object.freeze({ enabled: false, backend: "macos-local", nodeId: "local-macos", displayId: "main" });
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("integrations.computer must be an object");
  const source = value as Record<string, unknown>;
  const unknown = Object.keys(source).filter((key) => !["enabled", "backend", "nodeId", "displayId"].includes(key));
  if (unknown.length) throw new Error(`integrations.computer contains unsupported fields: ${unknown.sort().join(", ")}`);
  if (source.enabled !== undefined && typeof source.enabled !== "boolean") throw new Error("integrations.computer.enabled must be boolean");
  if (source.backend !== undefined && source.backend !== "macos-local") throw new Error("integrations.computer.backend must be macos-local");
  const displayId = boundedId(source.displayId, "main", "integrations.computer.displayId");
  macOSDisplayNumber(displayId);
  return Object.freeze({
    enabled: source.enabled === true,
    backend: "macos-local",
    nodeId: boundedId(source.nodeId, "local-macos", "integrations.computer.nodeId"),
    displayId
  });
}

function assertTrustedSystemExecutable(path: string): void {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`computer backend refused an unsafe system executable: ${path}`);
  if (metadata.uid !== 0 || (metadata.mode & 0o022) !== 0) throw new Error(`computer backend refused unsafe executable ownership or permissions: ${path}`);
}

function ownerPrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const metadata = lstatSync(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("computer backend state must be a physical directory");
  chmodSync(path, 0o700);
}

function readOwnerFile(path: string): string | undefined {
  try {
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) throw new Error("computer backend state file is unsafe");
    chmodSync(path, 0o600);
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeError).code === "ENOENT") return undefined;
    throw error;
  }
}

function syncDirectory(path: string): void {
  const descriptor = openSync(path, "r");
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}

function writeOwnerJson(path: string, value: unknown): void {
  const directory = dirname(path);
  ownerPrivateDirectory(directory);
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const descriptor = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(descriptor, `${JSON.stringify(value)}\n`);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporary, path);
  chmodSync(path, 0o600);
  syncDirectory(directory);
}

function removeOwnerFile(path: string): void {
  try {
    unlinkSync(path);
    syncDirectory(dirname(path));
  } catch (error) {
    if ((error as NodeError).code !== "ENOENT") throw error;
  }
}

function pairingTarget(directory: string, config: MacOSComputerConfig): ComputerScreenTarget {
  const path = join(directory, PAIRING_FILE);
  const existing = readOwnerFile(path);
  if (existing !== undefined) {
    const parsed = JSON.parse(existing) as Record<string, unknown>;
    if (parsed.schemaVersion === 1 && parsed.nodeId === config.nodeId && parsed.displayId === config.displayId
      && typeof parsed.pairingGeneration === "string" && /^[a-f0-9]{32}$/u.test(parsed.pairingGeneration)) {
      return Object.freeze({ nodeId: config.nodeId, displayId: config.displayId, pairingGeneration: parsed.pairingGeneration });
    }
  }
  const pairingGeneration = randomBytes(16).toString("hex");
  writeOwnerJson(path, { schemaVersion: 1, nodeId: config.nodeId, displayId: config.displayId, pairingGeneration });
  return Object.freeze({ nodeId: config.nodeId, displayId: config.displayId, pairingGeneration });
}

function appendBounded(current: string, chunk: Buffer): string {
  if (Buffer.byteLength(current, "utf8") >= COMMAND_OUTPUT_BYTES) return current;
  return `${current}${chunk.toString("utf8")}`.slice(0, COMMAND_OUTPUT_BYTES);
}

export const runComputerCommand: ComputerCommandRunner = (request) => {
  if (request.signal?.aborted) {
    const error = request.signal.reason instanceof Error ? request.signal.reason : new Error("computer backend command was cancelled");
    error.name = "AbortError";
    return Promise.reject(error);
  }
  return new Promise((resolve, reject) => {
  let settled = false;
  let stdout = "";
  let stderr = "";
  let stdinFailure: NodeError | undefined;
  const child = spawn(request.executable, [...request.args], {
    env: { LANG: "C", PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
    shell: false,
    stdio: ["pipe", "pipe", "pipe"]
  });
  const finish = (error?: Error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    request.signal?.removeEventListener("abort", abort);
    if (error) reject(error);
    else resolve({ stdout, stderr });
  };
  const abort = () => {
    const error = new Error("computer backend command was cancelled");
    error.name = "AbortError";
    child.kill("SIGKILL");
    finish(error);
  };
  const timer = setTimeout(() => {
    const error = new Error("computer backend command timed out") as NodeError;
    error.code = "COMPUTER_COMMAND_TIMEOUT";
    child.kill("SIGKILL");
    finish(error);
  }, request.timeoutMs);
  child.stdout.on("data", (chunk: Buffer) => { stdout = appendBounded(stdout, chunk); });
  child.stderr.on("data", (chunk: Buffer) => { stderr = appendBounded(stderr, chunk); });
  child.stdin.on("error", (error) => { if (request.input) stdinFailure = error; });
  child.once("error", (error) => finish(error));
  child.once("close", (code, signal) => {
    if (settled) return;
    if (code === 0 && !stdinFailure) finish();
    else {
      const error = stdinFailure ?? new Error(`computer backend command failed categorically (${signal ? "signal" : "exit"})`) as NodeError;
      error.code = "COMPUTER_COMMAND_FAILED";
      finish(error);
    }
  });
  request.signal?.addEventListener("abort", abort, { once: true });
  child.stdin.end(request.input ?? "");
  });
};

function parsePngDimensions(bytes: Buffer): { width: number; height: number } {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (bytes.byteLength < 24 || !bytes.subarray(0, 8).equals(signature) || bytes.toString("ascii", 12, 16) !== "IHDR") {
    throw new Error("computer backend produced an invalid PNG frame");
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width < 1 || height < 1 || width > 8_192 || height > 8_192 || width * height > 33_554_432) {
    throw new Error("computer backend produced unsupported frame dimensions");
  }
  return { width, height };
}

function actionScript(action: ComputerActRequest["action"]): string {
  const encoded = JSON.stringify(JSON.stringify(action));
  return `ObjC.import("CoreGraphics");\nconst action = JSON.parse(${encoded});\nconst events = Application("System Events");\nfunction point() { return $.CGPointMake(action.x, action.y); }\nfunction post(type, button) { const event = $.CGEventCreateMouseEvent(null, type, point(), button); $.CGEventPost($.kCGHIDEventTap, event); }\nif (action.action === "click") { const button = action.button === "right" ? $.kCGMouseButtonRight : action.button === "middle" ? $.kCGMouseButtonCenter : $.kCGMouseButtonLeft; const down = action.button === "right" ? $.kCGEventRightMouseDown : action.button === "middle" ? $.kCGEventOtherMouseDown : $.kCGEventLeftMouseDown; const up = action.button === "right" ? $.kCGEventRightMouseUp : action.button === "middle" ? $.kCGEventOtherMouseUp : $.kCGEventLeftMouseUp; post(down, button); post(up, button); }\nelse if (action.action === "move") { $.CGWarpMouseCursorPosition(point()); }\nelse if (action.action === "scroll") { const event = $.CGEventCreateScrollWheelEvent(null, $.kCGScrollEventUnitPixel, 2, action.deltaY, action.deltaX); $.CGEventPost($.kCGHIDEventTap, event); }\nelse if (action.action === "type") { events.keystroke(action.text); }\nelse if (action.action === "key") { const parts = action.key.split("+"); const key = parts.pop(); const modifier = { Alt: "option down", Command: "command down", Control: "control down", Option: "option down", Shift: "shift down" }; const using = parts.map((part) => modifier[part]); const codes = { Enter: 36, Tab: 48, Space: 49, Backspace: 51, Escape: 53, Delete: 117, Home: 115, End: 119, PageUp: 116, PageDown: 121, ArrowLeft: 123, ArrowRight: 124, ArrowDown: 125, ArrowUp: 126, F1: 122, F2: 120, F3: 99, F4: 118, F5: 96, F6: 97, F7: 98, F8: 100, F9: 101, F10: 109, F11: 103, F12: 111 }; if (Object.prototype.hasOwnProperty.call(codes, key)) events.keyCode(codes[key], { using }); else events.keystroke(key, { using }); }\n`;
}

function delay(durationMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason instanceof Error ? signal.reason : new Error("computer wait cancelled"));
    const timer = setTimeout(done, durationMs);
    function done() { signal?.removeEventListener("abort", abort); resolve(); }
    function abort() { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(signal!.reason instanceof Error ? signal!.reason : new Error("computer wait cancelled")); }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function readRecovery(path: string): RecoveryRecord | undefined {
  const raw = readOwnerFile(path);
  if (raw === undefined) return undefined;
  const source = JSON.parse(raw) as Record<string, unknown>;
  if (source.schemaVersion !== 1 || typeof source.recoveryId !== "string" || typeof source.frameId !== "string"
    || !["click", "type", "key", "move", "scroll"].includes(String(source.action))
    || !["cancelled-after-dispatch", "timeout", "transport-lost", "provider-uncertain"].includes(String(source.reason))
    || typeof source.dispatchedAt !== "string") throw new Error("computer recovery state is invalid");
  return source as RecoveryRecord;
}

function uncertaintyReason(error: unknown, signal?: AbortSignal): RecoveryRecord["reason"] {
  if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) return "cancelled-after-dispatch";
  if ((error as NodeError | undefined)?.code === "COMPUTER_COMMAND_TIMEOUT") return "timeout";
  return "provider-uncertain";
}

export function createMacOSComputerControlProvider(
  stateDir: string,
  configInput: unknown,
  dependencies: MacOSComputerDependencies = {}
): ComputerControlProvider {
  const config = normalizeMacOSComputerConfig(configInput);
  if (!config.enabled) throw new Error("macOS computer control is disabled");
  if ((dependencies.platform ?? process.platform) !== "darwin") throw new Error("macOS computer control requires macOS");
  const validateExecutable = dependencies.validateExecutable ?? assertTrustedSystemExecutable;
  for (const path of [SCREENSHOT, IMAGE_TOOL, SCRIPT_HOST]) validateExecutable(path);
  const directory = join(stateDir, "computer");
  ownerPrivateDirectory(directory);
  const target = pairingTarget(directory, config);
  const displayNumber = macOSDisplayNumber(config.displayId);
  const recoveryPath = join(directory, RECOVERY_FILE);
  const runner = dependencies.runner ?? runComputerCommand;
  const now = dependencies.now ?? (() => new Date().toISOString());
  let active = true;
  let lastFrame: Readonly<{ frameId: string; width: number; height: number }> | undefined;

  const ensureActive = () => { if (!active) throw new Error("macOS computer control provider is closed"); };
  const capture = async (request: ComputerScreenCaptureRequest) => {
    ensureActive();
    if (request.target.nodeId !== target.nodeId || request.target.displayId !== target.displayId || request.target.pairingGeneration !== target.pairingGeneration) {
      throw new Error("macOS computer capture target does not match the active pairing");
    }
    const temporary = await mkdtemp(join(tmpdir(), "odinn-computer-frame-"));
    const framePath = join(temporary, "frame.png");
    try {
      await runner({ executable: SCREENSHOT, args: ["-x", "-D", String(displayNumber), "-t", "png", framePath], signal: request.signal, timeoutMs: 10_000 });
      await runner({ executable: IMAGE_TOOL, args: ["-Z", "2048", framePath], signal: request.signal, timeoutMs: 10_000 });
      const size = statSync(framePath).size;
      if (size < 1 || size > MAX_SCREENSHOT_BYTES) throw new Error("computer screenshot exceeds the bounded frame size");
      const bytes = await readFile(framePath);
      const dimensions = parsePngDimensions(bytes);
      const frameId = `frame-${randomUUID()}`;
      lastFrame = { frameId, ...dimensions };
      return { frameId, target, capturedAt: now(), ...dimensions, mimeType: "image/png", imageBase64: bytes.toString("base64") };
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  };

  return {
    get target() { ensureActive(); return target; },
    capture,
    async act(request) {
      ensureActive();
      if (request.target.nodeId !== target.nodeId || request.target.displayId !== target.displayId || request.target.pairingGeneration !== target.pairingGeneration) {
        throw new Error("macOS computer action target does not match the active pairing");
      }
      if (readRecovery(recoveryPath)) throw new Error("computer control has an unresolved action; inspect recovery before another action");
      if (!lastFrame || request.frameId !== lastFrame.frameId) throw new Error("computer action frame is stale or was not captured by this provider instance");
      if ((request.action.action === "click" || request.action.action === "move")
        && (request.action.x >= lastFrame.width || request.action.y >= lastFrame.height)) {
        throw new Error("computer action coordinates are outside the approved frame");
      }
      if (request.action.action === "wait") {
        await delay(request.action.durationMs, request.signal);
        return { status: "completed", target, beforeFrameId: request.frameId, afterFrame: await capture({ target, signal: request.signal }) };
      }
      const recoveryId = `computer-recovery-${randomUUID()}`;
      let recovery: RecoveryRecord = {
        schemaVersion: 1,
        recoveryId,
        frameId: request.frameId,
        action: request.action.action,
        reason: "provider-uncertain",
        dispatchedAt: now()
      };
      writeOwnerJson(recoveryPath, recovery);
      try {
        await runner({ executable: SCRIPT_HOST, args: ["-l", "JavaScript", "-"], input: actionScript(request.action), signal: request.signal, timeoutMs: 10_000 });
        const afterFrame = await capture({ target, signal: request.signal });
        removeOwnerFile(recoveryPath);
        return { status: "completed", target, beforeFrameId: request.frameId, afterFrame };
      } catch (error) {
        recovery = { ...recovery, reason: uncertaintyReason(error, request.signal) };
        writeOwnerJson(recoveryPath, recovery);
        return { status: "needs-review", target, beforeFrameId: request.frameId, recoveryId, reason: recovery.reason };
      }
    },
    recoveryStatus() {
      ensureActive();
      const recovery = readRecovery(recoveryPath);
      return recovery ? { unresolved: true, ...recovery } : { unresolved: false };
    },
    async resolveRecovery(request: Readonly<{ recoveryId: string; outcome: ComputerRecoveryResolution; signal?: AbortSignal }>) {
      ensureActive();
      if (request.signal?.aborted) throw request.signal.reason instanceof Error ? request.signal.reason : new Error("computer recovery resolution cancelled");
      const recovery = readRecovery(recoveryPath);
      if (!recovery || recovery.recoveryId !== request.recoveryId) throw new Error("computer recovery resolution does not match the unresolved action");
      removeOwnerFile(recoveryPath);
      lastFrame = undefined;
      return { status: "resolved", recoveryId: request.recoveryId, outcome: request.outcome };
    },
    close() { active = false; }
  };
}

export function diagnoseMacOSComputerIntegration(configInput: unknown, dependencies: Pick<MacOSComputerDependencies, "platform"> = {}): MacOSComputerDiagnostic {
  let config: MacOSComputerConfig;
  try { config = normalizeMacOSComputerConfig(configInput); }
  catch { return { status: "invalid", enabled: false, backend: "macos-local", reason: "configuration-invalid", secretsExcluded: true }; }
  if (!config.enabled) return { status: "disabled", enabled: false, backend: config.backend, secretsExcluded: true };
  if ((dependencies.platform ?? process.platform) !== "darwin") return { status: "unavailable", enabled: true, backend: config.backend, reason: "platform-unsupported", secretsExcluded: true };
  try {
    for (const path of [SCREENSHOT, IMAGE_TOOL, SCRIPT_HOST]) assertTrustedSystemExecutable(path);
    return { status: "configured", enabled: true, backend: config.backend, target: { nodeId: config.nodeId, displayId: config.displayId }, permissions: "verify Screen Recording and Accessibility in macOS Privacy & Security", secretsExcluded: true };
  } catch {
    return { status: "unavailable", enabled: true, backend: config.backend, reason: "system-tools-unavailable", secretsExcluded: true };
  }
}
