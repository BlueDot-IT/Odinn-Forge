import type { JsonObject } from "@odinn/protocol";
import type { CurrentEntityPage, MemoryNamespaceAggregate, ProjectEntityCounts, RecordPage, RecordQuery } from "@odinn/store-sqlite";

export type QueryRecord = JsonObject & { schemaVersion: number; at: string; id: string };

export interface QueryableRecordStore {
  append(record: JsonObject): Promise<QueryRecord>;
  queryRecordsPage: (query?: RecordQuery) => Promise<RecordPage<QueryRecord>>;
  findById?: (id: string) => Promise<QueryRecord | undefined>;
  findMessageByExternalId?: (sessionId: string, externalId: string) => Promise<QueryRecord | undefined>;
  countRecords?: (query?: RecordQuery) => Promise<number>;
  queryCurrentSessionsPage?: (query?: { projectId?: string; limit?: number; cursor?: string }) => Promise<CurrentEntityPage>;
  queryCurrentProjectsPage?: (query?: { includeArchived?: boolean; limit?: number; cursor?: string }) => Promise<CurrentEntityPage>;
  queryCurrentGoalsPage?: (query?: { projectId?: string; sessionId?: string; status?: string; limit?: number; cursor?: string }) => Promise<CurrentEntityPage>;
  projectEntityCounts?: (projectId: string) => Promise<ProjectEntityCounts>;
  getCurrentSession?: (id: string) => Promise<JsonObject | undefined>;
  getCurrentProject?: (id: string) => Promise<JsonObject | undefined>;
  getCurrentGoal?: (id: string) => Promise<JsonObject | undefined>;
  getCurrentImprovement?: (id: string) => Promise<JsonObject | undefined>;
  queryCurrentImprovementsPage?: (query?: { limit?: number; cursor?: string }) => Promise<CurrentEntityPage>;
  aggregateActiveMemoryNamespaces?: (query?: Pick<RecordQuery, "scopeAny" | "namespacePrefix">) => Promise<MemoryNamespaceAggregate[]>;
}

export async function queryRecordPage(store: QueryableRecordStore, query: RecordQuery = {}): Promise<RecordPage<QueryRecord>> {
  if (typeof store.queryRecordsPage !== "function") throw new Error("record store does not expose a bounded query port");
  return store.queryRecordsPage({ limit: 50, ...query });
}

export async function findRecordById(store: QueryableRecordStore, id: string): Promise<QueryRecord | undefined> {
  if (typeof store.findById === "function") return store.findById(id);
  return (await queryRecordPage(store, { id, limit: 1 })).records[0];
}

export async function findMessageByExternalId(store: QueryableRecordStore, sessionId: string, externalId: string): Promise<QueryRecord | undefined> {
  if (typeof store.findMessageByExternalId === "function") return store.findMessageByExternalId(sessionId, externalId);
  return (await queryRecordPage(store, { types: ["message.appended"], sessionId, externalId, limit: 1 })).records[0];
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
