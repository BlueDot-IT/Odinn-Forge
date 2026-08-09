import { createHash } from "node:crypto";
import { MemoryCandidateIndex } from "@odinn/store-sqlite/memory-index";
import { queryRecordPage, type QueryRecord, type QueryableRecordStore } from "./record-queries.ts";

const MAX_RESULTS = 32;
const MAX_CONTEXT_BYTES = 48 * 1024;

export type ProjectContextRequest = {
  projectId?: string;
  sessionId?: string;
  query: string;
  limit?: number;
  maxBytes?: number;
  expectedSourceGeneration?: string;
  expectedSourceFingerprint?: string;
};

export type ProjectContextMemory = {
  id: string;
  text: string;
  summary: string;
  subject: string;
  kind: string;
  namespace: string;
  scopeType: string;
  scopeId: string;
  source?: string;
  authority?: string;
  confidence?: number;
  score: number;
  at: string;
};

export type ProjectContextPacket = {
  schemaVersion: 1;
  project?: Record<string, unknown>;
  session?: Record<string, unknown>;
  query: string;
  memories: ProjectContextMemory[];
  source: { kind: "memory-index" | "record-store"; generation?: string; fingerprint?: string };
  contextDigest: string;
  bytes: number;
};

export type ProjectContextOptions = {
  records: QueryableRecordStore;
  memoryIndex?: MemoryCandidateIndex;
  defaultProjectId?: string;
};

function stringValue(value: unknown, label: string, max = 512): string {
  if (typeof value !== "string" || value.length > max) throw new TypeError(`${label} is invalid`);
  return value;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function digest(value: unknown): string { return createHash("sha256").update(canonical(value), "utf8").digest("hex"); }

function scopeList(projectId?: string, sessionId?: string): Array<{ scopeType: string; scopeId: string }> {
  const scopes = [{ scopeType: "global", scopeId: "" }];
  if (projectId) scopes.push({ scopeType: "project", scopeId: projectId });
  if (sessionId) scopes.push({ scopeType: "session", scopeId: sessionId });
  return scopes;
}

function memoryFromRecord(record: QueryRecord, score: number): ProjectContextMemory | undefined {
  if (record.type !== "memory" || record.status !== "active") return undefined;
  const text = typeof record.text === "string" ? record.text : "";
  if (!text) return undefined;
  return {
    id: record.id,
    text,
    summary: typeof record.summary === "string" ? record.summary : text.slice(0, 240),
    subject: typeof record.subject === "string" ? record.subject : record.id,
    kind: typeof record.kind === "string" ? record.kind : "fact",
    namespace: typeof record.namespace === "string" ? record.namespace : "general",
    scopeType: typeof record.scopeType === "string" ? record.scopeType : "global",
    scopeId: typeof record.scopeId === "string" ? record.scopeId : "",
    ...(typeof record.source === "string" ? { source: record.source } : {}),
    ...(typeof record.authority === "string" ? { authority: record.authority } : {}),
    ...(typeof record.confidence === "number" && Number.isFinite(record.confidence) ? { confidence: record.confidence } : {}),
    score,
    at: typeof record.at === "string" ? record.at : ""
  };
}

export class ProjectContextService {
  readonly records: QueryableRecordStore;
  readonly memoryIndex?: MemoryCandidateIndex;
  readonly defaultProjectId: string;

  constructor(options: ProjectContextOptions) {
    if (!options?.records) throw new Error("ProjectContextService requires an authoritative record store");
    this.records = options.records;
    this.memoryIndex = options.memoryIndex;
    this.defaultProjectId = options.defaultProjectId ?? "project_default";
  }

  async build(input: ProjectContextRequest): Promise<ProjectContextPacket> {
    const query = stringValue(input?.query, "context query", 2_048).trim();
    if (!query) throw new Error("context query cannot be empty");
    const projectId = input.projectId ? stringValue(input.projectId, "projectId", 256) : undefined;
    const sessionId = input.sessionId ? stringValue(input.sessionId, "sessionId", 256) : undefined;
    const limit = Number.isSafeInteger(input.limit) && Number(input.limit) > 0 ? Math.min(Number(input.limit), MAX_RESULTS) : 12;
    const maxBytes = Number.isSafeInteger(input.maxBytes) && Number(input.maxBytes) > 0 ? Math.min(Number(input.maxBytes), MAX_CONTEXT_BYTES) : 24 * 1024;
    let project: Record<string, unknown> | undefined;
    let session: Record<string, unknown> | undefined;
    if (projectId) {
      project = await this.records.getCurrentProject?.(projectId) as Record<string, unknown> | undefined;
      if (!project || project.status === "archived") throw new Error(`project not found or archived: ${projectId}`);
    }
    if (sessionId) {
      session = await this.records.getCurrentSession?.(sessionId) as Record<string, unknown> | undefined;
      if (!session || session.status === "deleted") throw new Error(`session not found: ${sessionId}`);
      const sessionProjectId = typeof session.projectId === "string" ? session.projectId : this.defaultProjectId;
      if (projectId && sessionProjectId !== projectId) throw new Error("session does not belong to the requested project");
    }
    const scopes = scopeList(projectId, sessionId);
    const memories = this.memoryIndex
      ? await this.fromIndex(query, scopes, limit, input)
      : await this.fromRecords(query, scopes, limit);
    const selected: ProjectContextMemory[] = [];
    let bytes = 0;
    for (const memory of memories.sort((left, right) => right.score - left.score || right.at.localeCompare(left.at) || left.id.localeCompare(right.id))) {
      const candidateBytes = Buffer.byteLength(canonical(memory), "utf8");
      if (selected.length >= limit || bytes + candidateBytes > maxBytes) break;
      selected.push(memory);
      bytes += candidateBytes;
    }
    const source = this.memoryIndex
      ? (() => { const status = this.memoryIndex!.status({ sourceGeneration: input.expectedSourceGeneration, sourceFingerprint: input.expectedSourceFingerprint }); return { kind: "memory-index" as const, generation: status.sourceGeneration, fingerprint: status.sourceFingerprint }; })()
      : { kind: "record-store" as const };
    const packetBase = { schemaVersion: 1 as const, ...(project ? { project } : {}), ...(session ? { session } : {}), query, memories: selected, source };
    const contextDigest = digest(packetBase);
    return { ...packetBase, contextDigest, bytes: Buffer.byteLength(canonical(packetBase), "utf8") };
  }

  projectDurable(packet: ProjectContextPacket): Record<string, unknown> {
    return {
      schemaVersion: packet.schemaVersion,
      queryDigest: digest(packet.query),
      contextDigest: packet.contextDigest,
      source: packet.source,
      memoryIds: packet.memories.map((memory) => ({ id: memory.id, score: memory.score, at: memory.at, scopeType: memory.scopeType, scopeId: memory.scopeId }))
    };
  }

  private async fromIndex(query: string, scopes: Array<{ scopeType: string; scopeId: string }>, limit: number, input: ProjectContextRequest): Promise<ProjectContextMemory[]> {
    const records = new Map<string, ProjectContextMemory>();
    const status = this.memoryIndex!.status({ sourceGeneration: input.expectedSourceGeneration, sourceFingerprint: input.expectedSourceFingerprint });
    if (status.stale) throw new Error("memory index is stale for the requested context snapshot");
    for (const scope of scopes) {
      const results = this.memoryIndex!.search({ text: query, scopeType: scope.scopeType, ...(scope.scopeId ? { scopeId: scope.scopeId } : {}), limit });
      for (const result of results) {
        if (records.has(result.id)) continue;
        const authoritative = await this.records.findById?.(result.id);
        if (!authoritative) continue;
        const memory = memoryFromRecord(authoritative, Math.max(0, -result.rank));
        if (memory) records.set(result.id, memory);
      }
    }
    return [...records.values()];
  }

  private async fromRecords(query: string, scopes: Array<{ scopeType: string; scopeId: string }>, limit: number): Promise<ProjectContextMemory[]> {
    const output = new Map<string, ProjectContextMemory>();
    for (const scope of scopes) {
      const page = await queryRecordPage(this.records, { typePrefix: "memory", scopeType: scope.scopeType, ...(scope.scopeId ? { scopeId: scope.scopeId } : {}), activeMemoryOnly: true, text: query, limit });
      for (const record of page.records) {
        const memory = memoryFromRecord(record, 0);
        if (memory && !output.has(memory.id)) output.set(memory.id, memory);
      }
    }
    return [...output.values()];
  }
}

export function createProjectContextService(options: ProjectContextOptions): ProjectContextService { return new ProjectContextService(options); }
