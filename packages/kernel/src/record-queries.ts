import type { JsonObject } from "@odinn/protocol";
import type { RecordPage, RecordQuery } from "@odinn/store-sqlite";

export type QueryRecord = JsonObject & { schemaVersion: number; at: string; id: string };

export interface QueryableRecordStore {
  append(record: JsonObject): Promise<QueryRecord>;
  queryRecordsPage?: (query?: RecordQuery) => Promise<RecordPage<QueryRecord>>;
  findById?: (id: string) => Promise<QueryRecord | undefined>;
  findMessageByExternalId?: (sessionId: string, externalId: string) => Promise<QueryRecord | undefined>;
  /** Compatibility-only escape hatch for pre-#58 FileRecordStore instances. SQLite never uses this path. */
  readAll?: () => Promise<QueryRecord[]>;
}

function legacyMatches(record: QueryRecord, query: RecordQuery, all: QueryRecord[]): boolean {
  if (query.types?.length && !query.types.includes(String(record.type))) return false;
  if (query.typePrefix && !String(record.type ?? "").startsWith(query.typePrefix)) return false;
  if (query.id && record.id !== query.id) return false;
  if (query.ids?.length && !query.ids.includes(record.id)) return false;
  for (const [key, value] of Object.entries({
    sessionId: query.sessionId, projectId: query.projectId, scopeType: query.scopeType, scopeId: query.scopeId,
    namespace: query.namespace, kind: query.kind, status: query.status, subject: query.subject,
    targetId: query.targetId, goalId: query.goalId, candidateId: query.candidateId,
    externalId: query.externalId, supersedes: query.supersedes
  })) {
    if (value !== undefined && value !== "" && String(record[key]) !== String(value)) return false;
  }
  if (query.namespacePrefix && !(record.namespace === query.namespacePrefix || String(record.namespace ?? "").startsWith(`${query.namespacePrefix}/`))) return false;
  if (query.text?.trim() && !JSON.stringify(record).toLowerCase().includes(query.text.trim().toLowerCase())) return false;
  if (query.activeMemoryOnly) {
    if (record.type !== "memory" || record.status !== "active") return false;
    if (record.expiresAt && String(record.expiresAt) <= new Date().toISOString()) return false;
    if (all.some((entry) => entry.supersedes === record.id || (entry.type === "memory.deactivation" && entry.targetId === record.id))) return false;
  }
  return true;
}

async function legacyRecordPage(store: QueryableRecordStore, query: RecordQuery): Promise<RecordPage<QueryRecord>> {
  const reader = store.readAll;
  if (typeof reader !== "function") throw new Error("record store does not expose a bounded query port");
  const all = await reader.call(store);
  const filtered = all.filter((record) => legacyMatches(record, query, all));
  filtered.sort((left, right) => String(left.at).localeCompare(String(right.at)) || left.id.localeCompare(right.id));
  if (query.order === "desc") filtered.reverse();
  let start = 0;
  if (query.cursor) {
    try { start = Math.max(0, Number(JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8")).sequence ?? 1) - 1); } catch { throw new Error("invalid record cursor"); }
  }
  const limit = Number.isSafeInteger(query.limit) && Number(query.limit) > 0 ? Math.min(Number(query.limit), 200) : 50;
  const records = filtered.slice(start, start + limit);
  const hasMore = start + records.length < filtered.length;
  return {
    records,
    hasMore,
    ...(hasMore ? { nextCursor: Buffer.from(JSON.stringify({ sequence: start + records.length + 1 }), "utf8").toString("base64url") } : {})
  };
}

export async function queryRecordPage(store: QueryableRecordStore, query: RecordQuery = {}): Promise<RecordPage<QueryRecord>> {
  if (typeof store.queryRecordsPage === "function") return store.queryRecordsPage({ limit: 50, ...query });
  return legacyRecordPage(store, { limit: 50, ...query });
}

export async function findRecordById(store: QueryableRecordStore, id: string): Promise<QueryRecord | undefined> {
  if (typeof store.findById === "function") return store.findById(id);
  return (await queryRecordPage(store, { id, limit: 1 })).records[0];
}

export async function findMessageByExternalId(store: QueryableRecordStore, sessionId: string, externalId: string): Promise<QueryRecord | undefined> {
  if (typeof store.findMessageByExternalId === "function") return store.findMessageByExternalId(sessionId, externalId);
  return (await queryRecordPage(store, { types: ["message.appended"], sessionId, externalId, limit: 1 })).records[0];
}

export async function collectRecordPages(
  store: QueryableRecordStore,
  query: RecordQuery = {},
  maxRecords = 2_000
): Promise<QueryRecord[]> {
  const records: QueryRecord[] = [];
  let cursor = query.cursor;
  while (true) {
    const page = await queryRecordPage(store, { ...query, cursor });
    records.push(...page.records);
    if (!page.hasMore) return records;
    if (records.length >= maxRecords || !page.nextCursor) throw new Error("record query exceeded its bounded history limit");
    cursor = page.nextCursor;
  }
}

export function pageInput(input: Record<string, unknown>, fallback = 20): { limit: number; cursor?: string } {
  const parsed = Number(input.limit ?? fallback);
  const limit = Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, 200) : fallback;
  const cursor = typeof input.cursor === "string" && input.cursor.trim() ? input.cursor.trim() : undefined;
  return { limit, ...(cursor ? { cursor } : {}) };
}

export function pageResult<T>(records: T[], page: RecordPage, key = "records") {
  return {
    [key]: records,
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    hasMore: page.hasMore
  };
}
