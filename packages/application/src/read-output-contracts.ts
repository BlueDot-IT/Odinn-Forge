import type { JsonObject } from "./contracts.ts";
import { normalizeReadContractJsonObjectV1, normalizeReadContractJsonValueV1, omitReadContractObjectListFieldsV1, parseReadContractJsonObjectV1 } from "./read-contract-json.ts";
import { ApplicationContractValidationError } from "./validation/errors.ts";

export type ExperimentalFeatureV1 = "capabilities" | "capsules" | "counterfactual";
export type CoreAdvancedFeatureV1 = "proof" | "sentinel" | "rewind" | "darwin";

export interface ExperimentalFlagsV1 {
  readonly capabilities: boolean;
  readonly capsules: boolean;
  readonly counterfactual: boolean;
}

export interface CapabilityMigrationEntryV1 {
  readonly legacyCapability: string;
  readonly disposition: "scoped";
  readonly capabilities: readonly string[];
  readonly tools: readonly string[];
  readonly automaticWidening: false;
}

export interface CapabilityMigrationReportV1 {
  readonly registryVersion: 1;
  readonly required: boolean;
  readonly legacyCapabilities: readonly string[];
  readonly entries: readonly CapabilityMigrationEntryV1[];
  readonly automaticWidening: false;
}

export interface NetworkSecuritySurfaceV1 {
  readonly enabled: boolean;
  readonly allowPrivateNetwork: boolean;
  readonly allowedDomains: readonly string[];
  readonly blockedDomains: readonly string[];
}

export interface BrowserSecuritySurfaceV1 extends NetworkSecuritySurfaceV1 {
  readonly requireApproval: boolean;
  readonly allowDownloads: boolean;
  readonly allowUploads: boolean;
}

export interface WorkspaceSecuritySurfaceV1 {
  readonly deniedPatterns: readonly string[];
  readonly ignoreFiles: readonly string[];
}

export interface RuntimeSecuritySummaryV1 {
  readonly web: NetworkSecuritySurfaceV1;
  readonly browser: BrowserSecuritySurfaceV1;
  readonly workspace: WorkspaceSecuritySurfaceV1;
}

export interface CapabilityGrantV1 {
  readonly capability: string;
  readonly tool: string;
}

export interface PolicyInvariantV1 {
  readonly id: string;
  readonly type: "command.deny-pattern" | "tool.requires-approval" | "filesystem.allowed-roots";
  readonly values: readonly string[];
  readonly enforcement: "log" | "warn" | "pause" | "block" | "rollback" | "terminate";
}

export interface RuntimePolicySummaryV1 {
  readonly id?: string;
  readonly deniedTools: readonly string[];
  readonly capabilityRegistryVersion: 1;
  readonly allowedCapabilities: readonly string[];
  readonly scopedCapabilities: readonly CapabilityGrantV1[];
  readonly capabilityMigration: CapabilityMigrationReportV1;
  readonly maxInputBytes: number;
  readonly security: RuntimeSecuritySummaryV1;
  readonly invariants: readonly PolicyInvariantV1[];
}

export interface ToolSummaryV1 {
  readonly name: string;
  readonly capability?: string;
  readonly capabilities: readonly string[];
  readonly description: string;
}

export interface ModelSummaryV1 {
  readonly id: string;
  readonly provider: string;
  readonly model: string;
  readonly type: string;
  readonly transport: string;
}

export interface ProviderStatusSummaryV1 {
  readonly name: string;
  readonly displayName: string;
  readonly supportTier: "first-class" | "compatible" | "experimental" | "custom";
  readonly locallyTested: boolean;
  readonly genericCompatibilityMode: boolean;
  readonly modelAvailability: "local" | "provider-dependent";
  readonly type: string;
  readonly baseUrl?: string;
  readonly authMode: "api-key" | "oauth" | "device" | "cli";
  /** Environment-variable name only; never the credential value. */
  readonly apiKeyEnv: string;
  readonly models: readonly string[];
  readonly configured: boolean;
}

export interface CliChannelSummaryV1 {
  readonly name: string;
  readonly type: string;
  readonly enabled: boolean;
  readonly credentialConfigured: boolean;
  readonly credentialPresent: boolean;
  /** Environment-variable name only; never the credential value. */
  readonly tokenEnv: string;
  readonly allowlistEntries: number;
  readonly requireMention: boolean;
  readonly historyLimit: number;
  readonly dmPolicy?: string;
  readonly groupPolicy?: string;
  readonly allowBots?: boolean;
  readonly nativeCommands: boolean;
  readonly nativeCommandName: string;
  readonly defaultModel: string;
}

export interface CapabilityRegistryEntryV1 {
  readonly id: string;
  readonly description: string;
}

export interface PluginModuleSummaryV1 {
  readonly id: string;
  readonly displayName: string;
  readonly configKey: string;
  readonly enabled: boolean;
}

export interface RuntimeSurfacesSummaryV1 {
  readonly durableWorkflows: { readonly enabled: boolean };
  readonly eventIngress: { readonly enabled: boolean };
  readonly projectContext: { readonly enabled: boolean };
}

export interface SelfImprovementSummaryV1 {
  readonly enabled: boolean;
  readonly mode: "disabled" | "propose" | "auto";
  readonly intervalMs: number;
  readonly maxChangesPerCycle: number;
  readonly rollbackOnFailure: boolean;
  readonly automatic: boolean;
  readonly advisor: {
    readonly source: "configured-provider" | "waiting-for-provider";
    readonly model: string;
  };
}

export interface ApprovalEffectSummaryV1 {
  readonly version: 1;
  readonly tool: string;
  readonly summary: string;
  readonly capability: string;
  readonly inputDigest: string;
  readonly reversible: "reversible" | "irreversible" | "uncertain";
  readonly idempotency: "idempotent" | "non-idempotent" | "unknown";
  readonly effectClass?: string;
  readonly isolation?: string;
  readonly command?: "[redacted]";
  readonly cwd?: string;
  readonly argsCount?: number;
  readonly commandDigest?: string;
  readonly recovery?: string;
  readonly target?: string;
  readonly tabId?: string;
  readonly expectedUrl?: string;
  readonly selector?: string;
  readonly mutation?: string;
  readonly server?: string;
  readonly mcpTool?: string;
  readonly argsDigest?: string;
  readonly payloadDigest?: string;
  readonly skillId?: string;
  readonly skillVersion?: string;
  readonly action?: string;
  readonly inputKeys?: readonly string[];
}

export interface PendingApprovalSummaryV1 {
  readonly type?: string;
  readonly id?: string;
  readonly status?: "pending" | "claimed";
  readonly createdAt?: string;
  readonly expiresAt?: number;
  readonly approvedAt?: string;
  readonly runId?: string;
  readonly accountId?: string;
  readonly tool: string;
  readonly summary?: string;
  readonly effect?: ApprovalEffectSummaryV1;
  readonly recovery?: string;
  readonly expectedUrl?: string;
  readonly snapshotId?: string;
}

interface StatusSnapshotBaseV1 {
  readonly ok: true;
  readonly state: string;
  readonly workspaceRoot: string;
  readonly tools: readonly string[];
  readonly toolDetails: readonly ToolSummaryV1[];
  readonly allowedTools: readonly string[];
  readonly allowedCapabilities: readonly string[];
  readonly capabilityRegistryVersion: 1;
  readonly capabilityMigration: CapabilityMigrationReportV1;
  readonly defaultModel: string;
  readonly models: readonly ModelSummaryV1[];
  readonly providers: readonly ProviderStatusSummaryV1[];
  readonly security: RuntimeSecuritySummaryV1;
}

export interface CliStatusSnapshotV1 extends StatusSnapshotBaseV1 {
  readonly auditLog: string;
  readonly policy: RuntimePolicySummaryV1;
  readonly experimental: {
    readonly flags: ExperimentalFlagsV1;
    readonly warning: string;
  };
  readonly channels: readonly CliChannelSummaryV1[];
}

export interface GatewayStatusSnapshotV1 extends StatusSnapshotBaseV1 {
  /** Product version retained under its historical compatibility key. */
  readonly version: string;
  readonly capabilityRegistry: readonly CapabilityRegistryEntryV1[];
  readonly coreAdvanced: readonly CoreAdvancedFeatureV1[];
  readonly pluginModules: readonly PluginModuleSummaryV1[];
  readonly experimental: ExperimentalFlagsV1;
  readonly runtimeSurfaces: RuntimeSurfacesSummaryV1;
  readonly selfImprovement: SelfImprovementSummaryV1;
  readonly pendingApprovals: readonly PendingApprovalSummaryV1[];
}

/** Versioned status read model. The V1 suffix versions the wire shape. */
export type StatusSnapshotV1 = CliStatusSnapshotV1 | GatewayStatusSnapshotV1;

export interface PlatformSummaryV1 {
  readonly os: string;
  readonly arch: string;
  readonly node: string;
}

export interface ProviderDiagnosticSummaryV1 {
  readonly name: string;
  readonly displayName: string;
  readonly supportTier: "first-class" | "compatible" | "experimental" | "custom";
  readonly locallyTested: boolean;
  readonly genericCompatibilityMode: boolean;
  readonly type: string;
  readonly authMode: "api-key" | "oauth" | "device" | "cli";
  readonly configured: boolean;
  readonly models: readonly string[];
}

export interface ChannelCapabilitiesSummaryV1 {
  readonly chatTypes: readonly ("direct" | "group" | "channel" | "thread")[];
  readonly reactions?: boolean;
  readonly replies?: boolean;
  readonly typing?: boolean;
  readonly threads?: boolean;
  readonly media?: boolean;
  readonly edits?: boolean;
  readonly deletes?: boolean;
  readonly components?: boolean;
  readonly nativeCommands?: boolean;
  readonly streaming?: boolean;
}

export interface GatewayChannelDiagnosticV1 {
  readonly name: string;
  readonly type: string;
  readonly enabled: boolean;
  readonly running: boolean;
  readonly state: "stopped" | "starting" | "connected" | "degraded" | "failed";
  readonly credentialConfigured: boolean;
  readonly credentialPresent: boolean;
  readonly allowlistEntries: number;
  readonly capabilities: ChannelCapabilitiesSummaryV1;
  readonly error: string;
  readonly connectedAt?: string;
  readonly lastEventAt?: string;
  readonly reconnectAttempts?: number;
  readonly latencyMs?: number;
}

export type ChannelDiagnosticV1 = CliChannelSummaryV1 | GatewayChannelDiagnosticV1;

export interface AuditDiagnosticV1 {
  readonly valid: boolean;
  readonly events: number;
  readonly unsigned: number;
  readonly failureCount: number;
}

export interface ApprovalTotalsV1 {
  readonly pending: number;
  readonly ids: readonly string[];
}

export interface BrowserRecoveryDiagnosticV1 {
  readonly status: string;
  readonly pending: boolean;
  readonly id?: string;
}

export interface BrowserEngineDiagnosticV1 {
  readonly available: boolean;
  readonly configured: boolean;
  readonly source: "configured-unverified" | "platform" | "unavailable";
}

export interface JobTotalsV1 {
  readonly total: number;
  readonly queued: number;
  readonly running: number;
  readonly failed: number;
  readonly needsReview: number;
  readonly completed: number;
}

export interface SandboxRiskSummaryV1 {
  readonly elevated: boolean;
  readonly broadFilesystemGrants: number;
  readonly writableFilesystemGrants: number;
  readonly networkMode: "denied" | "brokered-public" | "allowlisted" | "unrestricted";
  readonly privateNetworkAccess: boolean;
  readonly loopbackAccess: boolean;
  readonly shellEnabled: boolean;
  readonly inheritedEnvironmentVariables: number;
  readonly secretReferences: number;
  readonly deviceGrants: number;
  readonly hostExecution: {
    readonly mode: "deny" | "prompt";
    readonly scope: "restricted" | "all";
  };
  readonly enginePathsConfigured: {
    readonly podman: boolean;
    readonly docker: boolean;
  };
  readonly risks: readonly string[];
}

export interface SandboxBackendDiagnosticV1 {
  readonly backend: "podman" | "docker";
  readonly available: boolean;
  readonly compatible: boolean;
  readonly rootless: boolean | "unknown";
  readonly containerOs: string;
  readonly controls: string;
  readonly resourceControls: {
    readonly memory: boolean;
    readonly memorySwap: boolean;
    readonly cpuPeriod: boolean;
    readonly cpuQuota: boolean;
    readonly pids: boolean;
    readonly seccomp: boolean;
    readonly evidence: string;
  };
}

export interface SandboxDiagnosticV1 {
  readonly configured: SandboxRiskSummaryV1;
  readonly recovery: { readonly pending: number | null; readonly quarantined: boolean };
  readonly extensionLane: {
    readonly status: "disabled" | "refused" | "eligible";
    readonly code?: string;
    readonly backend?: "podman" | "docker";
    readonly rootless?: boolean | "unknown";
    readonly controls?: string;
  };
  readonly activation: string;
  readonly backends: readonly SandboxBackendDiagnosticV1[];
}

export interface ProcessRecoveryDiagnosticV1 {
  readonly pending: number | null;
  readonly needsReview: number | null;
  readonly quarantined: boolean;
}

export interface DiagnosticStateSummaryV1 {
  readonly ownerOnly: boolean;
  readonly runtimeStateOutsideSourceCheckout: boolean;
  readonly secretsExcludedFromDiagnostics: true;
}

/** Versioned, explicitly redacted diagnostics read model. */
export interface DiagnosticsReportV1 {
  readonly ok: boolean;
  readonly command: "doctor" | "diagnostics";
  readonly version: string;
  readonly commit: string;
  readonly platform: PlatformSummaryV1;
  readonly providerMode: readonly ProviderDiagnosticSummaryV1[];
  readonly coreAdvanced: readonly CoreAdvancedFeatureV1[];
  readonly experimental: ExperimentalFlagsV1;
  readonly channels: readonly ChannelDiagnosticV1[];
  readonly audit: AuditDiagnosticV1;
  readonly approvals: ApprovalTotalsV1;
  readonly browserEngine?: BrowserEngineDiagnosticV1;
  readonly browserRecovery: BrowserRecoveryDiagnosticV1;
  readonly jobs: JobTotalsV1;
  readonly sandbox: SandboxDiagnosticV1;
  readonly processRecovery: ProcessRecoveryDiagnosticV1;
  readonly state: DiagnosticStateSummaryV1;
}

export interface SessionSummaryV1 {
  readonly id: string;
  readonly title: string;
  readonly status: "open" | "closed";
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastEventAt: string;
  readonly messageCount: number;
  readonly tags: readonly string[];
  readonly actor: string;
  readonly source: string;
  readonly projectId: string;
  readonly lastMessageRole?: string;
}

/** Versioned session-list read model. */
export interface SessionPageV1 {
  readonly sessions: readonly SessionSummaryV1[];
  readonly nextCursor?: string;
  readonly hasMore?: true;
}

const providerStatusPath = /^status snapshot\.providers\[\d+\]$/u;
const providerDiagnosticPath = /^diagnostics report\.providerMode\[\d+\]$/u;
const cliChannelPath = /^(?:status snapshot|diagnostics report)\.channels\[\d+\]$/u;
const gatewayChannelPath = /^(?:gateway channel diagnostics|diagnostics report\.channels)\[\d+\]$/u;

/**
 * Admit sensitive-looking compatibility fields only at their owning schema
 * location and only with the value type that proves they are projections, not
 * credential material. Plugin details and approval input never match these
 * exact paths.
 */
function allowKnownReadContractSensitiveField({
  path,
  key,
  value,
}: {
  path: string;
  key: string;
  value: unknown;
}): boolean {
  if (key === "authMode" && (providerStatusPath.test(path) || providerDiagnosticPath.test(path))) {
    return typeof value === "string" && ["api-key", "oauth", "device", "cli"].includes(value);
  }
  if (key === "apiKeyEnv" && providerStatusPath.test(path)) {
    return isEnvironmentReferenceValue(value);
  }
  if ((key === "credentialConfigured" || key === "credentialPresent")
    && (cliChannelPath.test(path) || gatewayChannelPath.test(path))) {
    return typeof value === "boolean";
  }
  if (key === "tokenEnv" && cliChannelPath.test(path)) {
    return isEnvironmentReferenceValue(value);
  }
  if (key === "secretReferences" && path === "diagnostics report.sandbox.configured") {
    return Number.isSafeInteger(value) && Number(value) >= 0;
  }
  return key === "secretsExcludedFromDiagnostics"
    && path === "diagnostics report.state"
    && value === true;
}

export function parseStatusSnapshotV1(source: string): StatusSnapshotV1 {
  return assertStatusSnapshotV1(parseReadContractJsonObjectV1(source, "status snapshot", {
    allowSensitiveField: allowKnownReadContractSensitiveField,
  }));
}

export function validateStatusSnapshotV1(input: unknown): StatusSnapshotV1 {
  return assertStatusSnapshotV1(normalizeReadContractJsonObjectV1(input, "status snapshot", {
    allowSensitiveField: allowKnownReadContractSensitiveField,
  }));
}

export function validatePendingApprovalSummariesV1(input: unknown): readonly PendingApprovalSummaryV1[] {
  const projected = omitReadContractObjectListFieldsV1(input, "pending approval summaries", ["input", "actor"]);
  const normalized = normalizeReadContractJsonValueV1(projected, "pending approval summaries");
  if (!Array.isArray(normalized)) fail("pending approval summaries must be an array", "pending approval summaries");
  normalized.forEach((item, index) => validatePendingApproval(openObject(item, `pending approval summaries[${index}]`), `pending approval summaries[${index}]`));
  return normalized as unknown as readonly PendingApprovalSummaryV1[];
}

export function validateGatewayChannelDiagnosticsV1(input: unknown): readonly GatewayChannelDiagnosticV1[] {
  const projected = omitReadContractObjectListFieldsV1(input, "gateway channel diagnostics", ["details"]);
  const normalized = normalizeReadContractJsonValueV1(projected, "gateway channel diagnostics", {
    allowSensitiveField: allowKnownReadContractSensitiveField,
  });
  if (!Array.isArray(normalized)) fail("gateway channel diagnostics must be an array", "gateway channel diagnostics");
  normalized.forEach((item, index) => validateGatewayChannel(openObject(item, `gateway channel diagnostics[${index}]`), `gateway channel diagnostics[${index}]`));
  return normalized as unknown as readonly GatewayChannelDiagnosticV1[];
}

export function validateRuntimeSecuritySummaryV1(input: unknown): RuntimeSecuritySummaryV1 {
  const normalized = normalizeReadContractJsonObjectV1(input, "runtime security summary");
  validateSecurity(normalized, "runtime security summary");
  return normalized as unknown as RuntimeSecuritySummaryV1;
}

export function parseDiagnosticsReportV1(source: string): DiagnosticsReportV1 {
  return assertDiagnosticsReportV1(parseReadContractJsonObjectV1(source, "diagnostics report", {
    allowSensitiveField: allowKnownReadContractSensitiveField,
  }));
}

export function validateDiagnosticsReportV1(input: unknown): DiagnosticsReportV1 {
  return assertDiagnosticsReportV1(normalizeReadContractJsonObjectV1(input, "diagnostics report", {
    allowSensitiveField: allowKnownReadContractSensitiveField,
  }));
}

export function parseSessionPageV1(source: string): SessionPageV1 {
  return assertSessionPageV1(parseReadContractJsonObjectV1(source, "session page"));
}

export function validateSessionPageV1(input: unknown): SessionPageV1 {
  return assertSessionPageV1(normalizeReadContractJsonObjectV1(input, "session page"));
}

function assertStatusSnapshotV1(input: JsonObject): StatusSnapshotV1 {
  const gateway = Object.hasOwn(input, "version");
  object(input, "status snapshot", gateway
    ? ["ok", "version", "state", "workspaceRoot", "tools", "toolDetails", "capabilityRegistryVersion", "capabilityRegistry", "capabilityMigration", "allowedCapabilities", "allowedTools", "defaultModel", "models", "providers", "coreAdvanced", "pluginModules", "experimental", "runtimeSurfaces", "security", "selfImprovement", "pendingApprovals"]
    : ["ok", "state", "workspaceRoot", "auditLog", "tools", "toolDetails", "allowedTools", "allowedCapabilities", "capabilityRegistryVersion", "capabilityMigration", "policy", "security", "experimental", "defaultModel", "models", "providers", "channels"]);
  literal(input.ok, "status snapshot.ok", true);
  text(input.state, "status snapshot.state");
  text(input.workspaceRoot, "status snapshot.workspaceRoot");
  stringList(input.tools, "status snapshot.tools");
  objectList(input.toolDetails, "status snapshot.toolDetails", validateToolSummary);
  stringList(input.allowedTools, "status snapshot.allowedTools");
  stringList(input.allowedCapabilities, "status snapshot.allowedCapabilities");
  literal(input.capabilityRegistryVersion, "status snapshot.capabilityRegistryVersion", 1);
  validateCapabilityMigration(input.capabilityMigration, "status snapshot.capabilityMigration");
  text(input.defaultModel, "status snapshot.defaultModel", true);
  objectList(input.models, "status snapshot.models", validateModelSummary);
  objectList(input.providers, "status snapshot.providers", validateProviderStatus);
  validateSecurity(input.security, "status snapshot.security");
  if (gateway) {
    text(input.version, "status snapshot.version");
    objectList(input.capabilityRegistry, "status snapshot.capabilityRegistry", (value, path) => {
      object(value, path, ["id", "description"]); text(value.id, `${path}.id`); text(value.description, `${path}.description`);
    });
    enumList(input.coreAdvanced, "status snapshot.coreAdvanced", ["proof", "sentinel", "rewind", "darwin"]);
    objectList(input.pluginModules, "status snapshot.pluginModules", (value, path) => {
      object(value, path, ["id", "displayName", "configKey", "enabled"]);
      text(value.id, `${path}.id`); text(value.displayName, `${path}.displayName`); text(value.configKey, `${path}.configKey`); bool(value.enabled, `${path}.enabled`);
    });
    validateExperimentalFlags(input.experimental, "status snapshot.experimental");
    validateRuntimeSurfaces(input.runtimeSurfaces, "status snapshot.runtimeSurfaces");
    validateSelfImprovement(input.selfImprovement, "status snapshot.selfImprovement");
    objectList(input.pendingApprovals, "status snapshot.pendingApprovals", validatePendingApproval);
  } else {
    text(input.auditLog, "status snapshot.auditLog");
    validatePolicy(input.policy, "status snapshot.policy");
    const experimental = object(input.experimental, "status snapshot.experimental", ["flags", "warning"]);
    validateExperimentalFlags(experimental.flags, "status snapshot.experimental.flags");
    text(experimental.warning, "status snapshot.experimental.warning");
    objectList(input.channels, "status snapshot.channels", validateCliChannel);
  }
  return input as unknown as StatusSnapshotV1;
}

function assertDiagnosticsReportV1(input: JsonObject): DiagnosticsReportV1 {
  object(
    input,
    "diagnostics report",
    ["ok", "command", "version", "commit", "platform", "providerMode", "coreAdvanced", "experimental", "channels", "audit", "approvals", "browserEngine", "browserRecovery", "jobs", "sandbox", "processRecovery", "state"],
    ["ok", "command", "version", "commit", "platform", "providerMode", "coreAdvanced", "experimental", "channels", "audit", "approvals", "browserRecovery", "jobs", "sandbox", "processRecovery", "state"]
  );
  bool(input.ok, "diagnostics report.ok");
  oneOf(input.command, "diagnostics report.command", ["doctor", "diagnostics"]);
  text(input.version, "diagnostics report.version");
  text(input.commit, "diagnostics report.commit");
  const platform = object(input.platform, "diagnostics report.platform", ["os", "arch", "node"]);
  text(platform.os, "diagnostics report.platform.os"); text(platform.arch, "diagnostics report.platform.arch"); text(platform.node, "diagnostics report.platform.node");
  objectList(input.providerMode, "diagnostics report.providerMode", validateProviderDiagnostic);
  enumList(input.coreAdvanced, "diagnostics report.coreAdvanced", ["proof", "sentinel", "rewind", "darwin"]);
  validateExperimentalFlags(input.experimental, "diagnostics report.experimental");
  objectList(input.channels, "diagnostics report.channels", (value, path) => {
    if (Object.hasOwn(value, "running")) validateGatewayChannel(value, path); else validateCliChannel(value, path);
  });
  const audit = object(input.audit, "diagnostics report.audit", ["valid", "events", "unsigned", "failureCount"]);
  bool(audit.valid, "diagnostics report.audit.valid"); count(audit.events, "diagnostics report.audit.events"); count(audit.unsigned, "diagnostics report.audit.unsigned"); count(audit.failureCount, "diagnostics report.audit.failureCount");
  const approvals = object(input.approvals, "diagnostics report.approvals", ["pending", "ids"]);
  count(approvals.pending, "diagnostics report.approvals.pending"); stringList(approvals.ids, "diagnostics report.approvals.ids");
  if (input.browserEngine !== undefined) {
    const browserEngine = object(input.browserEngine, "diagnostics report.browserEngine", ["available", "configured", "source"]);
    bool(browserEngine.available, "diagnostics report.browserEngine.available");
    bool(browserEngine.configured, "diagnostics report.browserEngine.configured");
    oneOf(browserEngine.source, "diagnostics report.browserEngine.source", ["configured-unverified", "platform", "unavailable"]);
    const coherent = (browserEngine.source === "configured-unverified" && browserEngine.available === false && browserEngine.configured === true)
      || (browserEngine.source === "platform" && browserEngine.available === true && browserEngine.configured === false)
      || (browserEngine.source === "unavailable" && browserEngine.available === false && browserEngine.configured === false);
    if (!coherent) throw new ApplicationContractValidationError("diagnostics report.browserEngine fields are inconsistent");
  }
  const browser = object(input.browserRecovery, "diagnostics report.browserRecovery", ["status", "pending", "id"], ["status", "pending"]);
  text(browser.status, "diagnostics report.browserRecovery.status"); bool(browser.pending, "diagnostics report.browserRecovery.pending"); optionalText(browser.id, "diagnostics report.browserRecovery.id");
  validateJobTotals(input.jobs, "diagnostics report.jobs");
  validateSandbox(input.sandbox, "diagnostics report.sandbox");
  const processRecovery = object(input.processRecovery, "diagnostics report.processRecovery", ["pending", "needsReview", "quarantined"]);
  nullableCount(processRecovery.pending, "diagnostics report.processRecovery.pending"); nullableCount(processRecovery.needsReview, "diagnostics report.processRecovery.needsReview"); bool(processRecovery.quarantined, "diagnostics report.processRecovery.quarantined");
  const state = object(input.state, "diagnostics report.state", ["ownerOnly", "runtimeStateOutsideSourceCheckout", "secretsExcludedFromDiagnostics"]);
  bool(state.ownerOnly, "diagnostics report.state.ownerOnly"); bool(state.runtimeStateOutsideSourceCheckout, "diagnostics report.state.runtimeStateOutsideSourceCheckout"); literal(state.secretsExcludedFromDiagnostics, "diagnostics report.state.secretsExcludedFromDiagnostics", true);
  return input as unknown as DiagnosticsReportV1;
}

function assertSessionPageV1(input: JsonObject): SessionPageV1 {
  object(input, "session page", ["sessions", "nextCursor", "hasMore"], ["sessions"]);
  objectList(input.sessions, "session page.sessions", (value, path) => {
    object(value, path, ["id", "title", "status", "createdAt", "updatedAt", "lastEventAt", "messageCount", "tags", "actor", "source", "projectId", "lastMessageRole"], ["id", "title", "status", "createdAt", "updatedAt", "lastEventAt", "messageCount", "tags", "actor", "source", "projectId"]);
    text(value.id, `${path}.id`); text(value.title, `${path}.title`, true); oneOf(value.status, `${path}.status`, ["open", "closed"]);
    timestamp(value.createdAt, `${path}.createdAt`); timestamp(value.updatedAt, `${path}.updatedAt`); timestamp(value.lastEventAt, `${path}.lastEventAt`);
    count(value.messageCount, `${path}.messageCount`); stringList(value.tags, `${path}.tags`); text(value.actor, `${path}.actor`); text(value.source, `${path}.source`); text(value.projectId, `${path}.projectId`); optionalText(value.lastMessageRole, `${path}.lastMessageRole`, true);
  });
  optionalText(input.nextCursor, "session page.nextCursor");
  if (input.hasMore !== undefined) literal(input.hasMore, "session page.hasMore", true);
  if ((input.nextCursor === undefined) !== (input.hasMore === undefined)) fail("session page cursor and hasMore must appear together", "session page");
  return input as unknown as SessionPageV1;
}

function validateToolSummary(input: Record<string, unknown>, path: string): void {
  object(input, path, ["name", "capability", "capabilities", "description"], ["name", "capabilities", "description"]);
  text(input.name, `${path}.name`); optionalText(input.capability, `${path}.capability`); stringList(input.capabilities, `${path}.capabilities`); text(input.description, `${path}.description`, true);
}

function validateModelSummary(input: Record<string, unknown>, path: string): void {
  object(input, path, ["id", "provider", "model", "type", "transport"]);
  text(input.id, `${path}.id`); text(input.provider, `${path}.provider`); text(input.model, `${path}.model`); text(input.type, `${path}.type`); text(input.transport, `${path}.transport`);
}

function validateProviderStatus(input: Record<string, unknown>, path: string): void {
  object(input, path, ["name", "displayName", "supportTier", "locallyTested", "genericCompatibilityMode", "modelAvailability", "type", "baseUrl", "authMode", "apiKeyEnv", "models", "configured"], ["name", "displayName", "supportTier", "locallyTested", "genericCompatibilityMode", "modelAvailability", "type", "authMode", "apiKeyEnv", "models", "configured"]);
  text(input.name, `${path}.name`); text(input.displayName, `${path}.displayName`); oneOf(input.supportTier, `${path}.supportTier`, ["first-class", "compatible", "experimental", "custom"]);
  bool(input.locallyTested, `${path}.locallyTested`); bool(input.genericCompatibilityMode, `${path}.genericCompatibilityMode`); oneOf(input.modelAvailability, `${path}.modelAvailability`, ["local", "provider-dependent"]);
  text(input.type, `${path}.type`); oneOf(input.authMode, `${path}.authMode`, ["api-key", "oauth", "device", "cli"]); optionalText(input.baseUrl, `${path}.baseUrl`, input.authMode === "cli"); environmentReference(input.apiKeyEnv, `${path}.apiKeyEnv`); stringList(input.models, `${path}.models`); bool(input.configured, `${path}.configured`);
}

function validateProviderDiagnostic(input: Record<string, unknown>, path: string): void {
  object(input, path, ["name", "displayName", "supportTier", "locallyTested", "genericCompatibilityMode", "type", "authMode", "configured", "models"]);
  text(input.name, `${path}.name`); text(input.displayName, `${path}.displayName`); oneOf(input.supportTier, `${path}.supportTier`, ["first-class", "compatible", "experimental", "custom"]);
  bool(input.locallyTested, `${path}.locallyTested`); bool(input.genericCompatibilityMode, `${path}.genericCompatibilityMode`); text(input.type, `${path}.type`); oneOf(input.authMode, `${path}.authMode`, ["api-key", "oauth", "device", "cli"]); bool(input.configured, `${path}.configured`); stringList(input.models, `${path}.models`);
}

function validateExperimentalFlags(input: unknown, path: string): void {
  const value = object(input, path, ["capabilities", "capsules", "counterfactual"]);
  bool(value.capabilities, `${path}.capabilities`); bool(value.capsules, `${path}.capsules`); bool(value.counterfactual, `${path}.counterfactual`);
}

function validateCapabilityMigration(input: unknown, path: string): void {
  const value = object(input, path, ["registryVersion", "required", "legacyCapabilities", "entries", "automaticWidening"]);
  literal(value.registryVersion, `${path}.registryVersion`, 1); bool(value.required, `${path}.required`); stringList(value.legacyCapabilities, `${path}.legacyCapabilities`); literal(value.automaticWidening, `${path}.automaticWidening`, false);
  objectList(value.entries, `${path}.entries`, (entry, entryPath) => {
    object(entry, entryPath, ["legacyCapability", "disposition", "capabilities", "tools", "automaticWidening"]);
    text(entry.legacyCapability, `${entryPath}.legacyCapability`); literal(entry.disposition, `${entryPath}.disposition`, "scoped"); stringList(entry.capabilities, `${entryPath}.capabilities`); stringList(entry.tools, `${entryPath}.tools`); literal(entry.automaticWidening, `${entryPath}.automaticWidening`, false);
  });
}

function validateSecurity(input: unknown, path: string): void {
  const value = object(input, path, ["web", "browser", "workspace"]);
  const web = object(value.web, `${path}.web`, ["enabled", "allowPrivateNetwork", "allowedDomains", "blockedDomains"]);
  bool(web.enabled, `${path}.web.enabled`); bool(web.allowPrivateNetwork, `${path}.web.allowPrivateNetwork`); stringList(web.allowedDomains, `${path}.web.allowedDomains`); stringList(web.blockedDomains, `${path}.web.blockedDomains`);
  const browser = object(value.browser, `${path}.browser`, ["enabled", "allowPrivateNetwork", "allowedDomains", "blockedDomains", "requireApproval", "allowDownloads", "allowUploads"]);
  bool(browser.enabled, `${path}.browser.enabled`); bool(browser.allowPrivateNetwork, `${path}.browser.allowPrivateNetwork`); stringList(browser.allowedDomains, `${path}.browser.allowedDomains`); stringList(browser.blockedDomains, `${path}.browser.blockedDomains`); bool(browser.requireApproval, `${path}.browser.requireApproval`); bool(browser.allowDownloads, `${path}.browser.allowDownloads`); bool(browser.allowUploads, `${path}.browser.allowUploads`);
  const workspace = object(value.workspace, `${path}.workspace`, ["deniedPatterns", "ignoreFiles"]);
  stringList(workspace.deniedPatterns, `${path}.workspace.deniedPatterns`); stringList(workspace.ignoreFiles, `${path}.workspace.ignoreFiles`);
}

function validatePolicy(input: unknown, path: string): void {
  const value = object(input, path, ["id", "deniedTools", "capabilityRegistryVersion", "allowedCapabilities", "scopedCapabilities", "capabilityMigration", "maxInputBytes", "security", "invariants"], ["deniedTools", "capabilityRegistryVersion", "allowedCapabilities", "scopedCapabilities", "capabilityMigration", "maxInputBytes", "security", "invariants"]);
  optionalText(value.id, `${path}.id`); stringList(value.deniedTools, `${path}.deniedTools`); literal(value.capabilityRegistryVersion, `${path}.capabilityRegistryVersion`, 1); stringList(value.allowedCapabilities, `${path}.allowedCapabilities`);
  objectList(value.scopedCapabilities, `${path}.scopedCapabilities`, (grant, grantPath) => { object(grant, grantPath, ["capability", "tool"]); text(grant.capability, `${grantPath}.capability`); text(grant.tool, `${grantPath}.tool`); });
  validateCapabilityMigration(value.capabilityMigration, `${path}.capabilityMigration`); count(value.maxInputBytes, `${path}.maxInputBytes`); validateSecurity(value.security, `${path}.security`);
  objectList(value.invariants, `${path}.invariants`, (invariant, invariantPath) => {
    object(invariant, invariantPath, ["id", "type", "values", "enforcement"]); text(invariant.id, `${invariantPath}.id`); oneOf(invariant.type, `${invariantPath}.type`, ["command.deny-pattern", "tool.requires-approval", "filesystem.allowed-roots"]); stringList(invariant.values, `${invariantPath}.values`); oneOf(invariant.enforcement, `${invariantPath}.enforcement`, ["log", "warn", "pause", "block", "rollback", "terminate"]);
  });
}

function validateCliChannel(input: Record<string, unknown>, path: string): void {
  object(input, path, ["name", "type", "enabled", "credentialConfigured", "credentialPresent", "tokenEnv", "allowlistEntries", "requireMention", "historyLimit", "dmPolicy", "groupPolicy", "allowBots", "nativeCommands", "nativeCommandName", "defaultModel"], ["name", "type", "enabled", "credentialConfigured", "credentialPresent", "tokenEnv", "allowlistEntries", "requireMention", "historyLimit", "nativeCommands", "nativeCommandName", "defaultModel"]);
  text(input.name, `${path}.name`); text(input.type, `${path}.type`); bool(input.enabled, `${path}.enabled`); bool(input.credentialConfigured, `${path}.credentialConfigured`); bool(input.credentialPresent, `${path}.credentialPresent`); environmentReference(input.tokenEnv, `${path}.tokenEnv`); count(input.allowlistEntries, `${path}.allowlistEntries`); bool(input.requireMention, `${path}.requireMention`); count(input.historyLimit, `${path}.historyLimit`); optionalText(input.dmPolicy, `${path}.dmPolicy`); optionalText(input.groupPolicy, `${path}.groupPolicy`); optionalBool(input.allowBots, `${path}.allowBots`); bool(input.nativeCommands, `${path}.nativeCommands`); text(input.nativeCommandName, `${path}.nativeCommandName`); text(input.defaultModel, `${path}.defaultModel`, true);
}

function validateRuntimeSurfaces(input: unknown, path: string): void {
  const value = object(input, path, ["durableWorkflows", "eventIngress", "projectContext"]);
  for (const name of ["durableWorkflows", "eventIngress", "projectContext"] as const) {
    const surface = object(value[name], `${path}.${name}`, ["enabled"]); bool(surface.enabled, `${path}.${name}.enabled`);
  }
}

function validateSelfImprovement(input: unknown, path: string): void {
  const value = object(input, path, ["enabled", "mode", "intervalMs", "maxChangesPerCycle", "rollbackOnFailure", "automatic", "advisor"]);
  bool(value.enabled, `${path}.enabled`); oneOf(value.mode, `${path}.mode`, ["disabled", "propose", "auto"]); count(value.intervalMs, `${path}.intervalMs`); count(value.maxChangesPerCycle, `${path}.maxChangesPerCycle`); bool(value.rollbackOnFailure, `${path}.rollbackOnFailure`); bool(value.automatic, `${path}.automatic`);
  const advisor = object(value.advisor, `${path}.advisor`, ["source", "model"]); oneOf(advisor.source, `${path}.advisor.source`, ["configured-provider", "waiting-for-provider"]); text(advisor.model, `${path}.advisor.model`, true);
}

function validatePendingApproval(input: Record<string, unknown>, path: string): void {
  object(input, path, ["type", "id", "status", "createdAt", "expiresAt", "approvedAt", "runId", "accountId", "tool", "summary", "effect", "recovery", "expectedUrl", "snapshotId"], ["tool"]);
  optionalText(input.type, `${path}.type`); optionalText(input.id, `${path}.id`); if (input.status !== undefined) oneOf(input.status, `${path}.status`, ["pending", "claimed"]); optionalTimestamp(input.createdAt, `${path}.createdAt`); if (input.expiresAt !== undefined) count(input.expiresAt, `${path}.expiresAt`); optionalTimestamp(input.approvedAt, `${path}.approvedAt`); optionalText(input.runId, `${path}.runId`, true); optionalText(input.accountId, `${path}.accountId`, true); text(input.tool, `${path}.tool`); optionalText(input.summary, `${path}.summary`); optionalText(input.recovery, `${path}.recovery`); optionalText(input.expectedUrl, `${path}.expectedUrl`); optionalText(input.snapshotId, `${path}.snapshotId`);
  if (input.effect !== undefined) validateApprovalEffect(input.effect, `${path}.effect`);
}

function validateApprovalEffect(input: unknown, path: string): void {
  const value = object(input, path, ["version", "tool", "summary", "capability", "inputDigest", "reversible", "idempotency", "effectClass", "isolation", "command", "cwd", "argsCount", "commandDigest", "recovery", "target", "tabId", "expectedUrl", "selector", "mutation", "server", "mcpTool", "argsDigest", "payloadDigest", "skillId", "skillVersion", "action", "inputKeys"], ["version", "tool", "summary", "capability", "inputDigest", "reversible", "idempotency"]);
  literal(value.version, `${path}.version`, 1); text(value.tool, `${path}.tool`); text(value.summary, `${path}.summary`); text(value.capability, `${path}.capability`, true); text(value.inputDigest, `${path}.inputDigest`); oneOf(value.reversible, `${path}.reversible`, ["reversible", "irreversible", "uncertain"]); oneOf(value.idempotency, `${path}.idempotency`, ["idempotent", "non-idempotent", "unknown"]);
  for (const key of ["effectClass", "isolation", "cwd", "commandDigest", "recovery", "target", "tabId", "expectedUrl", "selector", "mutation", "server", "mcpTool", "argsDigest", "payloadDigest", "skillId", "skillVersion", "action"] as const) optionalText(value[key], `${path}.${key}`, true);
  if (value.command !== undefined) literal(value.command, `${path}.command`, "[redacted]");
  if (value.argsCount !== undefined) count(value.argsCount, `${path}.argsCount`);
  if (value.inputKeys !== undefined) stringList(value.inputKeys, `${path}.inputKeys`);
}

function validateGatewayChannel(input: Record<string, unknown>, path: string): void {
  object(input, path, ["name", "type", "enabled", "running", "state", "credentialConfigured", "credentialPresent", "allowlistEntries", "capabilities", "error", "connectedAt", "lastEventAt", "reconnectAttempts", "latencyMs"], ["name", "type", "enabled", "running", "state", "credentialConfigured", "credentialPresent", "allowlistEntries", "capabilities", "error"]);
  text(input.name, `${path}.name`); text(input.type, `${path}.type`); bool(input.enabled, `${path}.enabled`); bool(input.running, `${path}.running`); oneOf(input.state, `${path}.state`, ["stopped", "starting", "connected", "degraded", "failed"]); bool(input.credentialConfigured, `${path}.credentialConfigured`); bool(input.credentialPresent, `${path}.credentialPresent`); count(input.allowlistEntries, `${path}.allowlistEntries`); text(input.error, `${path}.error`, true); optionalTimestamp(input.connectedAt, `${path}.connectedAt`); optionalTimestamp(input.lastEventAt, `${path}.lastEventAt`); if (input.reconnectAttempts !== undefined) count(input.reconnectAttempts, `${path}.reconnectAttempts`); if (input.latencyMs !== undefined) count(input.latencyMs, `${path}.latencyMs`);
  const capabilities = object(input.capabilities, `${path}.capabilities`, ["chatTypes", "reactions", "replies", "typing", "threads", "media", "edits", "deletes", "components", "nativeCommands", "streaming"], ["chatTypes"]);
  enumList(capabilities.chatTypes, `${path}.capabilities.chatTypes`, ["direct", "group", "channel", "thread"]);
  for (const key of ["reactions", "replies", "typing", "threads", "media", "edits", "deletes", "components", "nativeCommands", "streaming"] as const) optionalBool(capabilities[key], `${path}.capabilities.${key}`);
}

function validateJobTotals(input: unknown, path: string): void {
  const value = object(input, path, ["total", "queued", "running", "failed", "needsReview", "completed"]);
  for (const key of ["total", "queued", "running", "failed", "needsReview", "completed"] as const) count(value[key], `${path}.${key}`);
}

function validateSandbox(input: unknown, path: string): void {
  const value = object(input, path, ["configured", "recovery", "extensionLane", "activation", "backends"]);
  const configured = object(value.configured, `${path}.configured`, ["elevated", "broadFilesystemGrants", "writableFilesystemGrants", "networkMode", "privateNetworkAccess", "loopbackAccess", "shellEnabled", "inheritedEnvironmentVariables", "secretReferences", "deviceGrants", "hostExecution", "enginePathsConfigured", "risks"]);
  bool(configured.elevated, `${path}.configured.elevated`); count(configured.broadFilesystemGrants, `${path}.configured.broadFilesystemGrants`); count(configured.writableFilesystemGrants, `${path}.configured.writableFilesystemGrants`); oneOf(configured.networkMode, `${path}.configured.networkMode`, ["denied", "brokered-public", "allowlisted", "unrestricted"]); bool(configured.privateNetworkAccess, `${path}.configured.privateNetworkAccess`); bool(configured.loopbackAccess, `${path}.configured.loopbackAccess`); bool(configured.shellEnabled, `${path}.configured.shellEnabled`); count(configured.inheritedEnvironmentVariables, `${path}.configured.inheritedEnvironmentVariables`); count(configured.secretReferences, `${path}.configured.secretReferences`); count(configured.deviceGrants, `${path}.configured.deviceGrants`); stringList(configured.risks, `${path}.configured.risks`);
  const host = object(configured.hostExecution, `${path}.configured.hostExecution`, ["mode", "scope"]); oneOf(host.mode, `${path}.configured.hostExecution.mode`, ["deny", "prompt"]); oneOf(host.scope, `${path}.configured.hostExecution.scope`, ["restricted", "all"]);
  const engines = object(configured.enginePathsConfigured, `${path}.configured.enginePathsConfigured`, ["podman", "docker"]); bool(engines.podman, `${path}.configured.enginePathsConfigured.podman`); bool(engines.docker, `${path}.configured.enginePathsConfigured.docker`);
  const recovery = object(value.recovery, `${path}.recovery`, ["pending", "quarantined"]); nullableCount(recovery.pending, `${path}.recovery.pending`); bool(recovery.quarantined, `${path}.recovery.quarantined`);
  const lane = object(value.extensionLane, `${path}.extensionLane`, ["status", "code", "backend", "rootless", "controls"], ["status"]); oneOf(lane.status, `${path}.extensionLane.status`, ["disabled", "refused", "eligible"]); optionalText(lane.code, `${path}.extensionLane.code`); if (lane.backend !== undefined) oneOf(lane.backend, `${path}.extensionLane.backend`, ["podman", "docker"]); if (lane.rootless !== undefined && lane.rootless !== "unknown") bool(lane.rootless, `${path}.extensionLane.rootless`); optionalText(lane.controls, `${path}.extensionLane.controls`);
  text(value.activation, `${path}.activation`);
  objectList(value.backends, `${path}.backends`, (backend, backendPath) => {
    object(backend, backendPath, ["backend", "available", "compatible", "rootless", "containerOs", "controls", "resourceControls"]); oneOf(backend.backend, `${backendPath}.backend`, ["podman", "docker"]); bool(backend.available, `${backendPath}.available`); bool(backend.compatible, `${backendPath}.compatible`); if (backend.rootless !== "unknown") bool(backend.rootless, `${backendPath}.rootless`); text(backend.containerOs, `${backendPath}.containerOs`); text(backend.controls, `${backendPath}.controls`);
    const resources = object(backend.resourceControls, `${backendPath}.resourceControls`, ["memory", "memorySwap", "cpuPeriod", "cpuQuota", "pids", "seccomp", "evidence"]); for (const key of ["memory", "memorySwap", "cpuPeriod", "cpuQuota", "pids", "seccomp"] as const) bool(resources[key], `${backendPath}.resourceControls.${key}`); text(resources.evidence, `${backendPath}.resourceControls.evidence`);
  });
}

function object(input: unknown, path: string, allowed: readonly string[], required: readonly string[] = allowed): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail(`${path} must be an object`, path);
  const value = input as Record<string, unknown>;
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) fail(`${path} contains unknown field: ${unknown}`, `${path}.${unknown}`, "UNKNOWN_APPLICATION_FIELD");
  const missing = required.find((key) => !Object.hasOwn(value, key));
  if (missing) fail(`${path} is missing required field: ${missing}`, `${path}.${missing}`);
  return value;
}

function objectList(input: unknown, path: string, validate: (value: Record<string, unknown>, path: string) => void): void {
  if (!Array.isArray(input)) fail(`${path} must be an array`, path);
  input.forEach((item, index) => validate(openObject(item, `${path}[${index}]`), `${path}[${index}]`));
}

function openObject(input: unknown, path: string): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail(`${path} must be an object`, path);
  return object(input, path, Object.keys(input), []);
}

function stringList(input: unknown, path: string): void {
  if (!Array.isArray(input)) fail(`${path} must be an array`, path);
  input.forEach((item, index) => text(item, `${path}[${index}]`, true));
}

function enumList(input: unknown, path: string, values: readonly string[]): void {
  if (!Array.isArray(input)) fail(`${path} must be an array`, path);
  input.forEach((item, index) => oneOf(item, `${path}[${index}]`, values));
}

function text(input: unknown, path: string, allowEmpty = false): void {
  if (typeof input !== "string" || (!allowEmpty && input.length === 0)) fail(`${path} must be ${allowEmpty ? "a" : "a non-empty"} string`, path);
}

function optionalText(input: unknown, path: string, allowEmpty = false): void {
  if (input !== undefined) text(input, path, allowEmpty);
}

function optionalTimestamp(input: unknown, path: string): void {
  if (input === undefined) return;
  timestamp(input, path);
}

function timestamp(input: unknown, path: string): void {
  text(input, path);
  const value = input as string;
  const parsed = Date.parse(value);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
    || !Number.isFinite(parsed)
    || new Date(parsed).toISOString() !== value) {
    fail(`${path} must be a canonical UTC timestamp`, path);
  }
}

function environmentReference(input: unknown, path: string): void {
  text(input, path, true);
  if (!isEnvironmentReferenceValue(input)) {
    fail(`${path} must be an empty value or a credential environment-variable name`, path);
  }
}

function isEnvironmentReferenceValue(input: unknown): boolean {
  return input === ""
    || (typeof input === "string"
      && /^[A-Z][A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|CLIENT_ID|CLIENT_SECRET|APP_ID|TENANT_ID)$/u.test(input));
}

function bool(input: unknown, path: string): void {
  if (typeof input !== "boolean") fail(`${path} must be a boolean`, path);
}

function optionalBool(input: unknown, path: string): void {
  if (input !== undefined) bool(input, path);
}

function count(input: unknown, path: string): void {
  if (!Number.isSafeInteger(input) || Number(input) < 0) fail(`${path} must be a non-negative safe integer`, path);
}

function nullableCount(input: unknown, path: string): void {
  if (input !== null) count(input, path);
}

function oneOf(input: unknown, path: string, values: readonly string[]): void {
  if (typeof input !== "string" || !values.includes(input)) fail(`${path} has an unsupported value`, path);
}

function literal(input: unknown, path: string, expected: string | number | boolean): void {
  if (input !== expected) fail(`${path} must be ${JSON.stringify(expected)}`, path);
}

function fail(message: string, path: string, code = "INVALID_APPLICATION_READ_CONTRACT"): never {
  throw new ApplicationContractValidationError(message, code, path);
}
