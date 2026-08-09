import { constants, type Stats } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { withStateMutationLock } from "./state-mutation.ts";

type SkillManifest = {
  sdkVersion: string;
  id: string;
  version: string;
  name: string;
  description: string;
  instructions: string;
  requestedTools: string[];
  requestedCapabilities: string[];
  requestedSecrets: string[];
  network: { default: "deny"; allow: string[] };
  tests: unknown[];
};

type SkillRecord = SkillManifest & {
  status: "disabled" | "enabled" | "quarantined";
  trusted: boolean;
  installedAt: string;
  updatedAt?: string;
  packagePath: string;
  fileIntegrity: Record<string, string>;
  integrity: string;
  previousVersion?: string;
};

type RegistryState = { schemaVersion: 1; packages: SkillRecord[] };

export type SkillTransitionPreconditions = {
  version?: string;
  integrity?: string;
};

type DisclosureIndexEntry = SkillDisclosureMetadata & { integrity: string };
type DisclosureIndex = {
  schemaVersion: 1;
  entries: DisclosureIndexEntry[];
  integrity: string;
};

export type EnabledSkillContent = {
  id: string;
  version: string;
  name: string;
  description: string;
  requestedTools: string[];
  requestedCapabilities: string[];
  integrity: string;
  content: string;
};

export type SkillDisclosureMetadata = Omit<EnabledSkillContent, "integrity" | "content">;

const SKILL_ID = /^[a-z0-9][a-z0-9-]{1,63}$/u;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const DISCLOSURE_INDEX_MAX_BYTES = 256 * 1024;
const DISCLOSURE_INDEX_MAX_ENTRIES = 1_024;
const DISCLOSURE_DESCRIPTION_MAX_BYTES = 2_048;
const DISCLOSURE_LIST_MAX_ENTRIES = 64;
const DISCLOSURE_LIST_ITEM_MAX_BYTES = 128;
export const MAX_BOUNDED_UTF8_BYTES = 8 * 1024 * 1024;
const MANAGED_PACKAGE_FILE_MAX_BYTES = MAX_BOUNDED_UTF8_BYTES;

export function validateSkillPackage(input: any) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("skill package manifest must be an object");
  const manifest: SkillManifest = {
    sdkVersion: String(input.sdkVersion || "0.1"),
    id: String(input.id || input.name || "").trim(),
    version: String(input.version || "1.0.0").trim(),
    name: String(input.name || input.id || "").trim().slice(0, 120),
    description: String(input.description || "").trim(),
    instructions: String(input.instructions || "").trim(),
    requestedTools: stringList(input.requestedTools ?? input.tools),
    requestedCapabilities: stringList(input.requestedCapabilities ?? input.capabilities),
    requestedSecrets: stringList(input.requestedSecrets ?? input.secrets),
    network: {
      default: "deny",
      allow: stringList(input.network?.allow)
    },
    tests: Array.isArray(input.tests) ? input.tests : []
  };
  if (manifest.sdkVersion !== "0.1") throw new Error("skill sdkVersion must be 0.1");
  if (!SKILL_ID.test(manifest.id)) throw new Error("skill id must be 2-64 lowercase letters, digits, or hyphens");
  if (!SEMVER.test(manifest.version)) throw new Error("skill version must be semantic");
  if (manifest.name.length < 2) throw new Error("skill name is required");
  if (manifest.description.length < 12) throw new Error("skill description must explain when the skill applies");
  if (manifest.instructions.length < 40) throw new Error("skill instructions must contain an actionable workflow");
  for (const domain of manifest.network.allow) {
    if (!/^(?:\*\.)?[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/iu.test(domain) || domain.includes("..")) throw new Error(`invalid skill network domain: ${domain}`);
  }
  const skillContent = renderSkillMarkdown(manifest);
  const fileIntegrity = { "SKILL.md": digest(skillContent) };
  const integrity = digest(stableJson({ manifest, fileIntegrity }));
  if (input.integrity && input.integrity !== integrity) throw new Error("skill package integrity mismatch");
  return {
    manifest,
    skillContent,
    fileIntegrity,
    integrity,
    validation: { valid: true, checkedAt: new Date().toISOString() }
  };
}

export class SkillPackageStore {
  readonly stateDir: string;
  readonly root: string;
  readonly registryPath: string;
  readonly disclosureIndexPath: string;
  readonly disclosureDirtyPath: string;
  private writeChain: Promise<unknown> = Promise.resolve();

  constructor(stateDir: string) {
    this.stateDir = resolve(stateDir);
    this.root = join(this.stateDir, "skills");
    this.registryPath = join(this.root, "registry.json");
    this.disclosureIndexPath = join(this.root, "disclosure-index.json");
    this.disclosureDirtyPath = join(this.root, ".disclosure-index-dirty");
  }

  async list() {
    const pending = this.writeChain.then(() => withStateMutationLock(this.root, async () => {
      const state = await this.read();
      let changed = false;
      const packages = [];
      for (const record of state.packages) {
        const verification = await this.verifyRecord(record);
        if (!verification.valid && record.status !== "quarantined") {
          record.status = "quarantined";
          record.trusted = false;
          record.updatedAt = new Date().toISOString();
          changed = true;
        }
        packages.push({ ...record, verification });
      }
      if (changed) await this.writeStateAndDisclosure(state);
      return packages;
    }));
    this.writeChain = pending.catch(() => undefined);
    return pending;
  }

  /**
   * Read the registry and verify its records without repairing or persisting
   * anything. Control-plane inspection must not turn a GET into a quarantine
   * mutation; callers that want recovery must invoke an explicit lifecycle
   * operation.
   */
  async inspect() {
    const pending = this.writeChain.then(() => withStateMutationLock(this.root, async () => {
      const state = await this.read();
      return Promise.all(state.packages.map(async (record) => ({
        ...record,
        verification: await this.verifyRecord(record)
      })));
    }));
    this.writeChain = pending.catch(() => undefined);
    return pending;
  }

  async install(input: any) {
    const validated = validateSkillPackage(input);
    return this.mutate(async (state) => {
      const current = state.packages.find((entry) => entry.id === validated.manifest.id);
      const destination = this.safePackagePath(validated.manifest.id, validated.manifest.version);
      const staging = join(this.root, ".staging", randomUUID());
      await mkdir(staging, { recursive: true, mode: 0o700 });
      try {
        await writeFile(join(staging, "SKILL.md"), validated.skillContent, { mode: 0o600 });
        await writeFile(join(staging, "skill.json"), `${JSON.stringify(skillMetadata(validated), null, 2)}\n`, { mode: 0o600 });
        await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
        try { await rename(staging, destination); }
        catch (error: any) {
          if (error?.code !== "EEXIST" && error?.code !== "ENOTEMPTY") throw error;
          const existing = await this.verifyRecord({ ...validated.manifest, packagePath: destination, fileIntegrity: validated.fileIntegrity, integrity: validated.integrity } as unknown as SkillRecord);
          if (!existing.valid) throw new Error(`skill ${validated.manifest.id}@${validated.manifest.version} already exists with different content`);
        }
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
      const record: SkillRecord = {
        ...validated.manifest,
        status: "disabled",
        trusted: false,
        installedAt: new Date().toISOString(),
        packagePath: destination,
        fileIntegrity: validated.fileIntegrity,
        integrity: validated.integrity,
        ...(current ? { previousVersion: current.version } : {})
      };
      const index = state.packages.findIndex((entry) => entry.id === record.id);
      if (index >= 0) state.packages[index] = record;
      else state.packages.push(record);
      return { ...record, verification: { valid: true, failures: [] } };
    });
  }

  async transition(id: string, action: string, expected: SkillTransitionPreconditions = {}) {
    return this.mutate(async (state) => {
      const record = state.packages.find((entry) => entry.id === id);
      if (!record) throw new Error("skill package not found");
      if (!["enable", "disable", "quarantine"].includes(action)) throw new Error("unsupported skill lifecycle action");
      if (expected.version !== undefined && record.version !== expected.version) {
        const error = new Error("skill package version precondition failed") as Error & { code?: string };
        error.code = "SKILL_STALE_VERSION";
        throw error;
      }
      if (expected.integrity !== undefined && record.integrity !== expected.integrity) {
        const error = new Error("skill package integrity precondition failed") as Error & { code?: string };
        error.code = "SKILL_STALE_INTEGRITY";
        throw error;
      }
      const verification = await this.verifyRecord(record);
      if (action === "enable" && !verification.valid) {
        record.status = "quarantined";
        record.trusted = false;
        record.updatedAt = new Date().toISOString();
        await this.writeStateAndDisclosure(state);
        throw new Error("skill package failed integrity verification and was quarantined");
      }
      record.status = action === "enable" ? "enabled" : action === "disable" ? "disabled" : "quarantined";
      record.trusted = action === "enable";
      record.updatedAt = new Date().toISOString();
      return { ...record, verification };
    });
  }

  async verify(id: string) {
    const record = (await this.read()).packages.find((entry) => entry.id === id);
    if (!record) throw new Error("skill package not found");
    return this.verifyRecord(record);
  }

  async listDisclosureMetadata(maxEntries: number): Promise<SkillDisclosureMetadata[]> {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new Error("skill disclosure entry limit must be a positive safe integer");
    const pending = this.writeChain.then(() => withStateMutationLock(this.root, async () => {
      const index = await this.readDisclosureIndex();
      const entries: SkillDisclosureMetadata[] = [];
      for (const record of index.entries) {
        entries.push({
          id: record.id,
          version: record.version,
          name: record.name,
          description: record.description,
          requestedTools: [...record.requestedTools],
          requestedCapabilities: [...record.requestedCapabilities]
        });
        if (entries.length > maxEntries) break;
      }
      return entries;
    }));
    this.writeChain = pending.catch(() => undefined);
    return pending;
  }

  async migrateDisclosureIndex() {
    const pending = this.writeChain.then(() => withStateMutationLock(this.root, async () => {
      const state = await this.read();
      const serialized = this.serializeDisclosureIndex(state);
      await this.writeDisclosureIndex(serialized);
      return { migrated: true, entries: JSON.parse(serialized).entries.length as number };
    }));
    this.writeChain = pending.catch(() => undefined);
    return pending;
  }

  async recoverDisclosureIndex() {
    const pending = this.writeChain.then(() => withStateMutationLock(this.root, async () => {
      const state = await this.read();
      const changedAt = new Date().toISOString();
      const actions: Array<{
        id: string;
        action: "disable" | "quarantine";
        reason: "incompatible-metadata" | "invalid-integrity" | "entry-limit" | "byte-limit";
      }> = [];
      const candidates: Array<{ record: SkillRecord; entry: DisclosureIndexEntry }> = [];
      for (const record of state.packages) {
        if (record.status !== "enabled" || !record.trusted) continue;
        let validated: ReturnType<typeof validateSkillPackage>;
        try {
          validated = validateSkillPackage(record);
          if (validated.integrity !== record.integrity) throw new Error("integrity mismatch");
        } catch {
          reduceDisclosureLifecycle(record, "quarantined", changedAt);
          actions.push({ id: record.id, action: "quarantine", reason: "invalid-integrity" });
          continue;
        }
        try {
          candidates.push({
            record,
            entry: { ...disclosureMetadata(validated.manifest), integrity: record.integrity }
          });
        } catch (error) {
          if (!(error instanceof DisclosureMetadataLimitError)) throw error;
          reduceDisclosureLifecycle(record, "disabled", changedAt);
          actions.push({ id: record.id, action: "disable", reason: "incompatible-metadata" });
        }
      }
      candidates.sort((left, right) => left.entry.id < right.entry.id ? -1 : left.entry.id > right.entry.id ? 1 : 0);
      const countBounded = candidates.slice(0, DISCLOSURE_INDEX_MAX_ENTRIES);
      for (const candidate of candidates.slice(DISCLOSURE_INDEX_MAX_ENTRIES)) {
        reduceDisclosureLifecycle(candidate.record, "disabled", changedAt);
        actions.push({ id: candidate.entry.id, action: "disable", reason: "entry-limit" });
      }
      const retainedCount = largestDisclosurePrefixWithinByteLimit(countBounded.map((candidate) => candidate.entry));
      for (const candidate of countBounded.slice(retainedCount)) {
        reduceDisclosureLifecycle(candidate.record, "disabled", changedAt);
        actions.push({ id: candidate.entry.id, action: "disable", reason: "byte-limit" });
      }
      await this.writeStateAndDisclosure(state);
      actions.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
      return {
        recovered: true,
        retainedEnabled: countBounded.slice(0, retainedCount).map((candidate) => candidate.entry.id),
        actions
      };
    }));
    this.writeChain = pending.catch(() => undefined);
    return pending;
  }

  async readEnabledContent(id: string, maxContentBytes: number): Promise<EnabledSkillContent> {
    if (!SKILL_ID.test(id)) throw new Error("skill id must be exact and contain only 2-64 lowercase letters, digits, or hyphens");
    if (!Number.isSafeInteger(maxContentBytes) || maxContentBytes < 1) throw new Error("skill content byte limit must be a positive safe integer");
    const pending = this.writeChain.then(() => withStateMutationLock(this.root, async () => {
      const state = await this.read();
      const record = state.packages.find((entry) => entry.id === id);
      if (!record) throw new Error("skill package not found");
      if (record.status !== "enabled" || !record.trusted) throw new Error(`skill package is not enabled and trusted: ${id}`);
      const verification = await this.verifyRecordForHydration(record, maxContentBytes);
      if (!verification.valid || verification.content === undefined || !verification.canonical) {
        if (verification.limitFailure) throw new Error(verification.limitFailure);
        record.status = "quarantined";
        record.trusted = false;
        record.updatedAt = new Date().toISOString();
        await this.writeStateAndDisclosure(state);
        throw new Error(`skill package failed integrity verification and was quarantined: ${verification.failures.join("; ")}`);
      }
      const canonical = disclosureMetadata(verification.canonical);
      return {
        ...canonical,
        integrity: record.integrity,
        content: verification.content
      };
    }));
    this.writeChain = pending.catch(() => undefined);
    return pending;
  }

  private async verifyRecord(record: SkillRecord) {
    const failures: string[] = [];
    try {
      const expectedPath = this.safePackagePath(record.id, record.version);
      if (resolve(record.packagePath) !== expectedPath) failures.push("package path escaped managed storage");
      await assertManagedPackageDirectory(this.root, record.id, expectedPath);
      const content = await readUtf8Bounded(
        join(expectedPath, "SKILL.md"),
        MANAGED_PACKAGE_FILE_MAX_BYTES,
        "SKILL.md"
      );
      if (digest(content) !== record.fileIntegrity?.["SKILL.md"]) failures.push("SKILL.md digest mismatch");
      const validated = validateSkillPackage(record);
      if (validated.integrity !== record.integrity) failures.push("manifest digest mismatch");
      const metadata = JSON.parse(await readUtf8Bounded(
        join(expectedPath, "skill.json"),
        MANAGED_PACKAGE_FILE_MAX_BYTES,
        "skill.json"
      ));
      if (stableJson(metadata) !== stableJson(skillMetadata(validated))) failures.push("skill.json metadata mismatch");
    } catch (error: any) {
      failures.push(error?.code === "ENOENT" ? "managed package file is missing" : error.message);
    }
    return { valid: failures.length === 0, failures, checkedAt: new Date().toISOString() };
  }

  private async verifyRecordForHydration(record: SkillRecord, maxContentBytes: number) {
    const failures: string[] = [];
    let content: string | undefined;
    let limitFailure: string | undefined;
    let canonical: SkillManifest | undefined;
    try {
      const expectedPath = this.safePackagePath(record.id, record.version);
      if (resolve(record.packagePath) !== expectedPath) failures.push("package path escaped managed storage");
      await assertManagedPackageDirectory(this.root, record.id, expectedPath);
      content = await readUtf8Bounded(join(expectedPath, "SKILL.md"), maxContentBytes, "SKILL.md");
      if (digest(content) !== record.fileIntegrity?.["SKILL.md"]) failures.push("SKILL.md digest mismatch");
      const validated = validateSkillPackage(record);
      if (validated.integrity !== record.integrity) failures.push("manifest digest mismatch");
      canonical = validated.manifest;
      disclosureMetadata(canonical);
      const metadataText = await readUtf8Bounded(join(expectedPath, "skill.json"), 1024 * 1024, "skill.json");
      const metadata = JSON.parse(metadataText);
      if (stableJson(metadata) !== stableJson(skillMetadata(validated))) failures.push("skill.json metadata mismatch");
    } catch (error: any) {
      if (error instanceof ManagedFileLimitError || error instanceof DisclosureMetadataLimitError) limitFailure = error.message;
      failures.push(error?.code === "ENOENT" ? "managed package file is missing" : error.message);
    }
    return { valid: failures.length === 0, failures, content, canonical, limitFailure };
  }

  private async read(): Promise<RegistryState> {
    try {
      const value = JSON.parse(await readFile(this.registryPath, "utf8"));
      if (value?.schemaVersion !== 1) throw new Error(`unsupported skill registry schema: ${String(value?.schemaVersion)}`);
      if (!Array.isArray(value.packages)) throw new Error("skill registry packages must be an array");
      return value;
    } catch (error: any) {
      if (error?.code === "ENOENT") return { schemaVersion: 1, packages: [] };
      throw error;
    }
  }

  private async write(state: RegistryState) {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const temporary = `${this.registryPath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.registryPath);
    await chmod(this.registryPath, 0o600);
  }

  private async readDisclosureIndex(): Promise<DisclosureIndex> {
    try {
      await lstat(this.disclosureDirtyPath);
      throw new Error("skill disclosure index is dirty; run explicit disclosure index migration");
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
    let serialized: string;
    try {
      serialized = await readUtf8Bounded(
        this.disclosureIndexPath,
        DISCLOSURE_INDEX_MAX_BYTES,
        "skill disclosure index"
      );
    } catch (error: any) {
      if (error?.code === "ENOENT") {
        throw new Error("skill disclosure index is missing; run explicit disclosure index migration");
      }
      throw error;
    }
    const value = JSON.parse(serialized);
    if (value?.schemaVersion !== 1 || !Array.isArray(value.entries)) throw new Error("invalid skill disclosure index schema");
    if (value.entries.length > DISCLOSURE_INDEX_MAX_ENTRIES) throw new Error("skill disclosure index entry limit exceeded");
    const entries = value.entries.map((entry: any) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("invalid skill disclosure index entry");
      const metadata = disclosureMetadata(entry);
      if (!/^[a-f0-9]{64}$/u.test(entry.integrity)) throw new Error("invalid skill disclosure package integrity");
      return { ...metadata, integrity: entry.integrity };
    });
    const expectedIntegrity = digest(stableJson({ schemaVersion: 1, entries }));
    if (value.integrity !== expectedIntegrity) throw new Error("skill disclosure index integrity mismatch");
    return { schemaVersion: 1, entries, integrity: expectedIntegrity };
  }

  private serializeDisclosureIndex(state: RegistryState) {
    const entries = state.packages
      .filter((record) => record.status === "enabled" && record.trusted)
      .map((record) => {
        const validated = validateSkillPackage(record);
        if (validated.integrity !== record.integrity) throw new Error(`cannot index skill with invalid manifest integrity: ${record.id}`);
        return { ...disclosureMetadata(validated.manifest), integrity: record.integrity };
      })
      .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
    if (entries.length > DISCLOSURE_INDEX_MAX_ENTRIES) {
      throw new Error(`skill disclosure index exceeds ${DISCLOSURE_INDEX_MAX_ENTRIES} entries`);
    }
    const serialized = renderDisclosureIndex(entries);
    if (Buffer.byteLength(serialized, "utf8") > DISCLOSURE_INDEX_MAX_BYTES) {
      throw new Error(`skill disclosure index exceeds ${DISCLOSURE_INDEX_MAX_BYTES} UTF-8 bytes`);
    }
    return serialized;
  }

  private async writeDisclosureIndex(serialized: string) {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await writeFile(this.disclosureDirtyPath, "dirty\n", { mode: 0o600 });
    const temporary = `${this.disclosureIndexPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, serialized, { mode: 0o600 });
      await rename(temporary, this.disclosureIndexPath);
      await chmod(this.disclosureIndexPath, 0o600);
      await rm(this.disclosureDirtyPath);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private async writeStateAndDisclosure(state: RegistryState) {
    const serialized = this.serializeDisclosureIndex(state);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await writeFile(this.disclosureDirtyPath, "dirty\n", { mode: 0o600 });
    await this.write(state);
    const temporary = `${this.disclosureIndexPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, serialized, { mode: 0o600 });
      await rename(temporary, this.disclosureIndexPath);
      await chmod(this.disclosureIndexPath, 0o600);
    } finally {
      await rm(temporary, { force: true });
    }
    await rm(this.disclosureDirtyPath);
  }

  private async mutate<T>(operation: (state: RegistryState) => Promise<T>) {
    const pending = this.writeChain.then(() => withStateMutationLock(this.root, async () => {
      const state = await this.read();
      const result = await operation(state);
      await this.writeStateAndDisclosure(state);
      return result;
    }));
    this.writeChain = pending.catch(() => undefined);
    return pending;
  }

  private safePackagePath(id: string, version: string) {
    const packagesRoot = resolve(join(this.root, "packages"));
    const target = resolve(packagesRoot, id, version);
    if (!target.startsWith(`${packagesRoot}${sep}`)) throw new Error("skill package path escaped managed storage");
    return target;
  }
}

function renderSkillMarkdown(manifest: SkillManifest) {
  return `---\nname: ${JSON.stringify(manifest.id)}\ndescription: ${JSON.stringify(manifest.description)}\n---\n\n# ${manifest.name}\n\n${manifest.instructions.trim()}\n`;
}

function skillMetadata(validated: ReturnType<typeof validateSkillPackage>) {
  return { ...validated.manifest, fileIntegrity: validated.fileIntegrity, integrity: validated.integrity };
}

function stringList(value: any) {
  return Array.isArray(value) ? Array.from(new Set(value.map((entry) => String(entry).trim()).filter(Boolean))) : [];
}

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export type BoundedUtf8Read = { content: string; bytesRead: number; truncated: boolean };

export type FileIdentity = { path: string; dev: number; ino: number; kind: "directory" | "symbolic-link" };
export type FileContentIdentity = { dev: number; ino: number };

export async function captureAncestorIdentities(root: string, target: string, label: string): Promise<FileIdentity[]> {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(`${resolvedRoot}${sep}`)) {
    throw new Error(`${label} escaped its confinement root`);
  }
  const identities: FileIdentity[] = [];
  let cursor = resolvedRoot;
  const ancestors = resolvedTarget.slice(resolvedRoot.length + 1).split(sep).slice(0, -1);
  for (const component of ancestors) {
    const metadata = await lstat(cursor);
    if (!metadata.isSymbolicLink() && !metadata.isDirectory()) throw new Error(`${label} confinement ancestor changed`);
    identities.push({ path: cursor, dev: metadata.dev, ino: metadata.ino, kind: metadata.isSymbolicLink() ? "symbolic-link" : "directory" });
    cursor = resolve(cursor, component);
  }
  const metadata = await lstat(cursor);
  if (!metadata.isSymbolicLink() && !metadata.isDirectory()) throw new Error(`${label} confinement ancestor changed`);
  identities.push({ path: cursor, dev: metadata.dev, ino: metadata.ino, kind: metadata.isSymbolicLink() ? "symbolic-link" : "directory" });
  return identities;
}

async function assertAncestorIdentities(identities: FileIdentity[], label: string) {
  for (const expected of identities) {
    const actual = await lstat(expected.path);
    const kind = actual.isSymbolicLink() ? "symbolic-link" : actual.isDirectory() ? "directory" : undefined;
    if (kind !== expected.kind || actual.dev !== expected.dev || actual.ino !== expected.ino) {
      throw new Error(`${label} confinement ancestor changed`);
    }
  }
}

type OpenedFileHandle = { fd: number; stat: () => Promise<Stats> };

async function canonicalHandlePath(handle: OpenedFileHandle, label: string) {
  if (process.platform !== "linux") throw new Error(`${label} cannot bind opened handle on ${process.platform}`);
  const descriptorPath = `/proc/self/fd/${handle.fd}`;
  try {
    return await realpath(descriptorPath);
  } catch (error) {
    throw new Error(`${label} cannot bind opened handle on ${process.platform}`, { cause: error });
  }
}

async function assertOpenedHandleBinding(
  handle: OpenedFileHandle,
  target: string,
  root: string,
  expectedFileIdentity: FileContentIdentity | undefined,
  label: string
) {
  const opened = await handle.stat();
  if (!opened.isFile()) throw new Error(`${label} changed during secure open`);
  if (process.platform !== "linux") {
    if (!expectedFileIdentity || expectedFileIdentity.dev === 0 || expectedFileIdentity.ino === 0 || opened.dev === 0 || opened.ino === 0) {
      throw new Error(`${label} cannot bind opened handle on ${process.platform}`);
    }
    if (opened.dev !== expectedFileIdentity.dev || opened.ino !== expectedFileIdentity.ino) {
      throw new Error(`${label} changed during secure open`);
    }
    return opened;
  }
  const canonical = await canonicalHandlePath(handle, label);
  const canonicalRoot = await realpath(root);
  if (canonical !== resolve(target) || canonical !== canonicalRoot && !canonical.startsWith(`${canonicalRoot}${sep}`)) {
    throw new Error(`${label} changed during secure open`);
  }
  return opened;
}

export async function readUtf8Prefix(
  path: string,
  maxBytes: number,
  label: string,
  { rejectTruncated = false, beforeOpen, afterLstatBeforeOpen, afterOpen, confinementRoot, expectedAncestors, expectedFileIdentity }: { rejectTruncated?: boolean; beforeOpen?: () => void | Promise<void>; /** @internal deterministic race-test hook only. */ afterLstatBeforeOpen?: () => void | Promise<void>; /** @internal deterministic race-test hook only. */ afterOpen?: () => void | Promise<void>; confinementRoot?: string; expectedAncestors?: FileIdentity[]; expectedFileIdentity?: FileContentIdentity } = {}
): Promise<BoundedUtf8Read> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BOUNDED_UTF8_BYTES) {
    throw new Error(`${label} byte limit must be a positive safe integer no greater than ${MAX_BOUNDED_UTF8_BYTES}`);
  }
  const ancestors = expectedAncestors ?? (confinementRoot ? await captureAncestorIdentities(confinementRoot, path, label) : undefined);
  await beforeOpen?.();
  const before = await lstat(path);
  if (before.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link`);
  if (expectedFileIdentity && (before.dev !== expectedFileIdentity.dev || before.ino !== expectedFileIdentity.ino)) {
    throw new Error(`${label} changed during admission`);
  }
  if (!before.isFile()) throw new Error(`${label} must be a regular file`);
  if (rejectTruncated && before.size > maxBytes) throw new ManagedFileLimitError(`${label} exceeds ${maxBytes} UTF-8 bytes`);
  await afterLstatBeforeOpen?.();
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
  const handle = await open(path, flags);
  try {
    await afterOpen?.();
    const opened = confinementRoot
      ? await assertOpenedHandleBinding(handle, path, confinementRoot, expectedFileIdentity, label)
      : await handle.stat();
    if (ancestors) await assertAncestorIdentities(ancestors, label);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error(`${label} changed during secure open`);
    }
    const bytes = Buffer.allocUnsafe(maxBytes + 1);
    let rawBytesRead = 0;
    while (rawBytesRead < bytes.length) {
      const result = await handle.read(bytes, rawBytesRead, bytes.length - rawBytesRead, null);
      if (result.bytesRead === 0) break;
      rawBytesRead += result.bytesRead;
    }
    const after = await handle.stat();
    if (ancestors) await assertAncestorIdentities(ancestors, label);
    if (!after.isFile() || after.dev !== opened.dev || after.ino !== opened.ino) {
      throw new Error(`${label} changed during secure read`);
    }
    const truncated = rawBytesRead > maxBytes;
    if (rejectTruncated && truncated) throw new ManagedFileLimitError(`${label} exceeds ${maxBytes} UTF-8 bytes`);
    const retained = bytes.subarray(0, Math.min(rawBytesRead, maxBytes));
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let content: string;
    try {
      content = decoder.decode(retained);
    } catch (error) {
      if (!truncated) throw new Error(`${label} is not valid UTF-8`, { cause: error });
      const boundary = incompleteUtf8Boundary(retained);
      if (boundary === undefined) throw new Error(`${label} is not valid UTF-8`, { cause: error });
      content = decoder.decode(retained.subarray(0, boundary));
    }
    return { content, bytesRead: rawBytesRead, truncated };
  } finally {
    await handle.close();
  }
}

function incompleteUtf8Boundary(bytes: Buffer): number | undefined {
  let start = bytes.length - 1;
  while (start >= 0 && (bytes[start]! & 0xc0) === 0x80) start -= 1;
  if (start < 0) return undefined;
  const lead = bytes[start]!;
  const expected = lead <= 0x7f ? 1 : lead >= 0xc2 && lead <= 0xdf ? 2 : lead >= 0xe0 && lead <= 0xef ? 3 : lead >= 0xf0 && lead <= 0xf4 ? 4 : 0;
  return expected > 0 && bytes.length - start < expected ? start : undefined;
}

async function readUtf8Bounded(path: string, maxBytes: number, label: string) {
  return (await readUtf8Prefix(path, maxBytes, label, { rejectTruncated: true })).content;
}

class ManagedFileLimitError extends Error {}

class DisclosureMetadataLimitError extends Error {}

function disclosureMetadata(manifest: Pick<
  SkillManifest,
  "id" | "version" | "name" | "description" | "requestedTools" | "requestedCapabilities"
>): SkillDisclosureMetadata {
  if (!SKILL_ID.test(manifest.id)) throw new DisclosureMetadataLimitError("skill disclosure id is invalid");
  if (!SEMVER.test(manifest.version)) throw new DisclosureMetadataLimitError("skill disclosure version is invalid");
  if (typeof manifest.name !== "string" || manifest.name.length < 2 || Buffer.byteLength(manifest.name, "utf8") > 120) {
    throw new DisclosureMetadataLimitError("skill disclosure name exceeds 120 UTF-8 bytes");
  }
  if (
    typeof manifest.description !== "string"
    || Buffer.byteLength(manifest.description, "utf8") < 12
    || Buffer.byteLength(manifest.description, "utf8") > DISCLOSURE_DESCRIPTION_MAX_BYTES
  ) {
    throw new DisclosureMetadataLimitError(
      `skill disclosure description must be 12-${DISCLOSURE_DESCRIPTION_MAX_BYTES} UTF-8 bytes`
    );
  }
  return {
    id: manifest.id,
    version: manifest.version,
    name: manifest.name,
    description: manifest.description,
    requestedTools: disclosureList(manifest.requestedTools, "requested tools"),
    requestedCapabilities: disclosureList(manifest.requestedCapabilities, "requested capabilities")
  };
}

function disclosureList(value: unknown, label: string) {
  if (!Array.isArray(value) || value.length > DISCLOSURE_LIST_MAX_ENTRIES) {
    throw new DisclosureMetadataLimitError(`${label} exceed ${DISCLOSURE_LIST_MAX_ENTRIES} entries`);
  }
  return value.map((entry) => {
    if (
      typeof entry !== "string"
      || entry.length === 0
      || Buffer.byteLength(entry, "utf8") > DISCLOSURE_LIST_ITEM_MAX_BYTES
    ) {
      throw new DisclosureMetadataLimitError(`${label} entries must be 1-${DISCLOSURE_LIST_ITEM_MAX_BYTES} UTF-8 bytes`);
    }
    return entry;
  });
}

function renderDisclosureIndex(entries: DisclosureIndexEntry[]) {
  const index: DisclosureIndex = {
    schemaVersion: 1,
    entries,
    integrity: digest(stableJson({ schemaVersion: 1, entries }))
  };
  return `${JSON.stringify(index, null, 2)}\n`;
}

function largestDisclosurePrefixWithinByteLimit(entries: DisclosureIndexEntry[]) {
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const candidate = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(renderDisclosureIndex(entries.slice(0, candidate)), "utf8") <= DISCLOSURE_INDEX_MAX_BYTES) {
      low = candidate;
    } else {
      high = candidate - 1;
    }
  }
  return low;
}

function reduceDisclosureLifecycle(
  record: SkillRecord,
  status: "disabled" | "quarantined",
  changedAt: string
) {
  record.status = status;
  record.trusted = false;
  record.updatedAt = changedAt;
}

async function assertManagedPackageDirectory(root: string, id: string, expectedPath: string) {
  const packagesRoot = resolve(join(root, "packages"));
  const idRoot = resolve(packagesRoot, id);
  for (const [path, label] of [
    [packagesRoot, "managed package root"],
    [idRoot, "managed skill directory"],
    [expectedPath, "managed skill version directory"]
  ] as const) {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${label} must be a real directory`);
    if (await realpath(path) !== path) throw new Error(`${label} escaped through a symbolic link`);
  }
}

function stableJson(value: any): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
