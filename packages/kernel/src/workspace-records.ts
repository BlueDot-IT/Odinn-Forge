import { randomUUID } from "node:crypto";
import type { JsonObject } from "@odinn/protocol";
import { collectRecordPages, findMessageByExternalId, pageInput, queryRecordPage, type QueryRecord, type QueryableRecordStore } from "./record-queries.ts";

export const DEFAULT_PROJECT_ID = "project_default";

const SESSION_ROLES = new Set(["system", "user", "assistant", "tool", "note"]);
const GOAL_STATUSES = new Set(["active", "completed", "blocked", "paused", "cancelled"]);
const PROJECT_STATUSES = new Set(["active", "archived"]);
export type WorkspaceRecord = QueryRecord;

export interface WorkspaceRecordStore extends QueryableRecordStore {}

const SESSION_EVENT_TYPES = ["session.renamed", "session.assigned", "session.updated", "session.closed", "session.deleted", "message.appended"];
const PROJECT_EVENT_TYPES = ["project.updated"];
const GOAL_EVENT_TYPES = ["goal.updated"];

async function sessionRecords(store: WorkspaceRecordStore, sessionId: string): Promise<WorkspaceRecord[]> {
  const [created, events] = await Promise.all([
    collectRecordPages(store, { types: ["session.created"], id: sessionId }),
    collectRecordPages(store, { types: SESSION_EVENT_TYPES, sessionId })
  ]);
  return [...created, ...events].sort((left, right) => left.at.localeCompare(right.at) || left.id.localeCompare(right.id));
}

async function projectRecords(store: WorkspaceRecordStore, projectId: string): Promise<WorkspaceRecord[]> {
  const [created, events] = await Promise.all([
    collectRecordPages(store, { types: ["project.created"], id: projectId }),
    collectRecordPages(store, { types: PROJECT_EVENT_TYPES, projectId })
  ]);
  return [...created, ...events].sort((left, right) => left.at.localeCompare(right.at) || left.id.localeCompare(right.id));
}

async function goalRecords(store: WorkspaceRecordStore, goalId: string): Promise<WorkspaceRecord[]> {
  const [created, events] = await Promise.all([
    collectRecordPages(store, { types: ["goal.created"], id: goalId }),
    collectRecordPages(store, { types: GOAL_EVENT_TYPES, goalId })
  ]);
  const sessionId = typeof created[0]?.sessionId === "string" ? created[0].sessionId : "";
  const sessionContext = sessionId ? await sessionRecords(store, sessionId) : [];
  return [...created, ...events, ...sessionContext].sort((left, right) => left.at.localeCompare(right.at) || left.id.localeCompare(right.id));
}

async function resolveProject(store: WorkspaceRecordStore, projectId: string): Promise<ProjectView | undefined> {
  const records = projectId === DEFAULT_PROJECT_ID ? [] : await projectRecords(store, projectId);
  return reduceProjects(records).find((project) => project.id === projectId);
}

async function resolveSession(store: WorkspaceRecordStore, sessionId: string): Promise<SessionView | undefined> {
  return reduceSessions(await sessionRecords(store, sessionId)).find((session) => session.id === sessionId);
}

async function resolveGoal(store: WorkspaceRecordStore, goalId: string): Promise<GoalView | undefined> {
  return reduceGoals(await goalRecords(store, goalId)).find((goal) => goal.id === goalId);
}

async function listSessionPage(store: WorkspaceRecordStore, input: SessionCommandInput) {
  const page = pageInput(input as Record<string, unknown>, 20);
  const createdPage = await queryRecordPage(store, { types: ["session.created"], order: "asc", ...page });
  const sessions: SessionView[] = [];
  for (const created of createdPage.records) {
    const current = await resolveSession(store, created.id);
    if (current && current.status !== "deleted") sessions.push(current);
  }
  const projectId = cleanString(input.projectId, "");
  return { sessions: sessions.filter((session) => !projectId || session.projectId === projectId), ...(createdPage.nextCursor ? { nextCursor: createdPage.nextCursor, hasMore: true } : {}) };
}

async function projectCounts(store: WorkspaceRecordStore, projectId: string) {
  const sessionCreated = await collectRecordPages(store, { types: ["session.created"], limit: 2_000 }, 2_000);
  let sessionCount = 0;
  for (const created of sessionCreated) {
    const session = await resolveSession(store, created.id);
    if (session && session.status !== "deleted" && session.projectId === projectId) sessionCount += 1;
  }
  const goalCreated = await collectRecordPages(store, { types: ["goal.created"], limit: 2_000 }, 2_000);
  let goalCount = 0;
  let activeGoalCount = 0;
  for (const created of goalCreated) {
    const goal = reduceGoals(await goalRecords(store, created.id)).find((entry) => entry.id === created.id);
    if (!goal || goal.projectId !== projectId) continue;
    goalCount += 1;
    if (goal.status === "active") activeGoalCount += 1;
  }
  return { sessionCount, goalCount, activeGoalCount };
}

async function listProjectPage(store: WorkspaceRecordStore, input: ProjectCommandInput) {
  const page = pageInput(input as Record<string, unknown>, 100);
  const createdPage = await queryRecordPage(store, { types: ["project.created"], order: "asc", ...page });
  const projects: ProjectView[] = [{ ...reduceProjects([])[0]!, ...(await projectCounts(store, DEFAULT_PROJECT_ID)) }];
  for (const created of createdPage.records) {
    const current = reduceProjects(await projectRecords(store, created.id)).find((project) => project.id === created.id);
    if (current && (input.includeArchived === true || current.status !== "archived")) {
      projects.push({ ...current, ...(await projectCounts(store, current.id)) });
    }
  }
  return { projects, defaultProjectId: DEFAULT_PROJECT_ID, ...(createdPage.nextCursor ? { nextCursor: createdPage.nextCursor, hasMore: true } : {}) };
}

async function listGoalPage(store: WorkspaceRecordStore, input: GoalCommandInput) {
  const page = pageInput(input as Record<string, unknown>, 20);
  const requestedProjectId = cleanString(input.projectId, "");
  const requestedSessionId = cleanString(input.sessionId, "");
  const createdPage = await queryRecordPage(store, {
    types: ["goal.created"],
    ...(requestedSessionId ? { sessionId: requestedSessionId } : {}),
    order: "asc", ...page
  });
  const goals: GoalView[] = [];
  for (const created of createdPage.records) {
    const current = reduceGoals(await goalRecords(store, created.id)).find((goal) => goal.id === created.id);
    if (!current) continue;
    if (requestedProjectId && current.projectId !== requestedProjectId) continue;
    if (requestedSessionId && current.sessionId !== requestedSessionId) continue;
    if (input.status && current.status !== input.status) continue;
    goals.push(current);
  }
  return { goals, ...(createdPage.nextCursor ? { nextCursor: createdPage.nextCursor, hasMore: true } : {}) };
}

export type SessionCommandInput = {
  sessionId?: unknown;
  projectId?: unknown;
  title?: unknown;
  role?: unknown;
  content?: unknown;
  actor?: unknown;
  source?: unknown;
  tags?: unknown;
  model?: unknown;
  provider?: unknown;
  externalId?: unknown;
  cursor?: unknown;
  limit?: unknown;
};

export type ProjectCommandInput = {
  id?: unknown;
  projectId?: unknown;
  name?: unknown;
  description?: unknown;
  status?: unknown;
  source?: unknown;
  tags?: unknown;
  includeArchived?: unknown;
  cursor?: unknown;
  limit?: unknown;
};

export type GoalCommandInput = {
  goalId?: unknown;
  projectId?: unknown;
  sessionId?: unknown;
  title?: unknown;
  description?: unknown;
  status?: unknown;
  note?: unknown;
  source?: unknown;
  tags?: unknown;
  cursor?: unknown;
  limit?: unknown;
};

export type SessionView = {
  id: string;
  title: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  lastEventAt: string;
  messageCount: number;
  tags: string[];
  actor: string;
  source: string;
  projectId: string;
  lastMessageRole?: string;
};

export type ProjectView = {
  id: string;
  name: string;
  description: string;
  status: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
};

export type GoalView = {
  id: string;
  title: string;
  description: string;
  status: string;
  tags: string[];
  scopeType: string;
  scopeId: string;
  projectId: string;
  sessionId?: string;
  createdAt: string;
  updatedAt: string;
  notes: Array<{ at: string; note: string; status: string }>;
};

export async function createSession(store: WorkspaceRecordStore, input: SessionCommandInput = {}) {
  const projectId = cleanString(input.projectId, DEFAULT_PROJECT_ID);
  const project = await resolveProject(store, projectId);
  if (!project || project.status === "archived") {
    throw new Error(`project not found or archived: ${projectId}`);
  }
  return store.append({
    id: prefixedId("sess"),
    type: "session.created",
    status: "open",
    title: cleanString(input.title, "Untitled session"),
    actor: cleanString(input.actor, "local"),
    source: cleanString(input.source, "local"),
    tags: normalizeTags(input.tags),
    projectId
  });
}

export async function appendSessionMessage(store: WorkspaceRecordStore, input: SessionCommandInput = {}) {
  const sessionId = cleanRequired(input.sessionId, "session.message requires sessionId");
  const role = cleanString(input.role, "user");
  if (!SESSION_ROLES.has(role)) throw new Error(`session role must be one of: ${Array.from(SESSION_ROLES).join(", ")}`);
  const content = cleanRequired(input.content, "session.message requires content");
  const externalId = cleanString(input.externalId, "");
  if (externalId) {
    const existing = await findMessageByExternalId(store, sessionId, externalId);
    if (existing) return existing;
  }
  const session = await resolveSession(store, sessionId);
  if (!session) throw new Error(`session not found: ${sessionId}`);
  if (session.status !== "open") throw new Error(`session is not open: ${sessionId}`);
  const model = cleanString(input.model, "");
  const provider = cleanString(input.provider, "");
  return store.append({
    id: prefixedId("msg"),
    type: "message.appended",
    sessionId,
    role,
    content,
    actor: cleanString(input.actor, "local"),
    source: cleanString(input.source, "local"),
    ...(externalId ? { externalId } : {}),
    ...(model ? { model } : {}),
    ...(provider ? { provider } : {})
  });
}

export async function renameSession(store: WorkspaceRecordStore, input: SessionCommandInput = {}) {
  const sessionId = cleanRequired(input.sessionId, "session.rename requires sessionId");
  const title = cleanRequired(input.title, "session.rename requires title");
  const session = await resolveSession(store, sessionId);
  if (!session) throw new Error(`session not found: ${sessionId}`);
  if (session.status !== "open") throw new Error(`session is not open: ${sessionId}`);
  return store.append({ id: prefixedId("sess_evt"), type: "session.renamed", sessionId, title, actor: cleanString(input.actor, "local"), source: cleanString(input.source, "local") });
}

export async function assignSessionProject(store: WorkspaceRecordStore, input: SessionCommandInput = {}) {
  const sessionId = cleanRequired(input.sessionId, "session.assign requires sessionId");
  const projectId = cleanRequired(input.projectId, "session.assign requires projectId");
  const session = await resolveSession(store, sessionId);
  if (!session || session.status === "deleted") throw new Error(`session not found: ${sessionId}`);
  const project = await resolveProject(store, projectId);
  if (!project || project.status === "archived") throw new Error(`project not found or archived: ${projectId}`);
  return store.append({ id: prefixedId("sess_evt"), type: "session.assigned", sessionId, projectId, actor: cleanString(input.actor, "local"), source: cleanString(input.source, "local") });
}

export async function updateSession(store: WorkspaceRecordStore, input: SessionCommandInput = {}) {
  const sessionId = cleanRequired(input.sessionId, "session.update requires sessionId");
  const session = await resolveSession(store, sessionId);
  if (!session) throw new Error(`session not found: ${sessionId}`);
  const hasTitle = input.title !== undefined;
  const hasProject = input.projectId !== undefined;
  if (!hasTitle && !hasProject) throw new Error("session.update requires a title or projectId");
  const title = hasTitle ? cleanRequired(input.title, "session.update requires a non-empty title") : undefined;
  if (hasTitle && session.status !== "open") throw new Error(`session is not open: ${sessionId}`);
  const projectId = hasProject ? cleanRequired(input.projectId, "session.update requires projectId") : undefined;
  const targetProject = projectId ? await resolveProject(store, projectId) : undefined;
  if (projectId && (!targetProject || targetProject.status === "archived")) {
    throw new Error(`project not found or archived: ${projectId}`);
  }
  const event = await store.append({
    id: prefixedId("sess_evt"),
    type: "session.updated",
    sessionId,
    ...(title === undefined ? {} : { title }),
    ...(projectId === undefined ? {} : { projectId }),
    actor: cleanString(input.actor, "local"),
    source: cleanString(input.source, "local")
  });
  return { ...event, session: { ...session, ...(title === undefined ? {} : { title }), ...(projectId === undefined ? {} : { projectId }), updatedAt: event.at, lastEventAt: event.at } };
}

export async function deleteSession(store: WorkspaceRecordStore, input: SessionCommandInput = {}) {
  const sessionId = cleanRequired(input.sessionId, "session.delete requires sessionId");
  const session = await resolveSession(store, sessionId);
  if (!session) throw new Error(`session not found: ${sessionId}`);
  if (session.status === "deleted") throw new Error(`session already deleted: ${sessionId}`);
  return store.append({ id: prefixedId("sess_evt"), type: "session.deleted", sessionId, actor: cleanString(input.actor, "local"), source: cleanString(input.source, "local") });
}

export async function listSessions(store: WorkspaceRecordStore, input: SessionCommandInput = {}) {
  return listSessionPage(store, input);
}

export async function readSession(store: WorkspaceRecordStore, input: SessionCommandInput = {}) {
  const sessionId = cleanRequired(input.sessionId, "session.read requires sessionId");
  const records = await sessionRecords(store, sessionId);
  const session = reduceSessions(records).find((entry) => entry.id === sessionId);
  if (!session || session.status === "deleted") throw new Error(`session not found: ${sessionId}`);
  const messages = records
    .filter((record) => record.type === "message.appended" && record.sessionId === sessionId)
    .map(({ id, at, role, content, actor, source, model, provider }) => ({ id, at, role, content, actor, source, model, provider }));
  return { session, messages };
}

export async function createProject(store: WorkspaceRecordStore, input: ProjectCommandInput = {}) {
  const name = cleanRequired(input.name, "project.create requires name");
  const id = cleanString(input.id, prefixedId("project"));
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{1,119}$/u.test(id)) throw new Error("project id must be 2-120 letters, digits, dots, underscores, or hyphens");
  if (await resolveProject(store, id)) throw new Error(`project already exists: ${id}`);
  return store.append({ id, type: "project.created", status: "active", name, description: cleanString(input.description, ""), tags: normalizeTags(input.tags), source: cleanString(input.source, "local") });
}

export async function updateProject(store: WorkspaceRecordStore, input: ProjectCommandInput = {}) {
  const projectId = cleanRequired(input.projectId, "project.update requires projectId");
  const project = await resolveProject(store, projectId);
  if (!project) throw new Error(`project not found: ${projectId}`);
  const status = cleanString(input.status, project.status);
  if (!PROJECT_STATUSES.has(status)) throw new Error(`project status must be one of: ${Array.from(PROJECT_STATUSES).join(", ")}`);
  if (projectId === DEFAULT_PROJECT_ID && status === "archived") throw new Error("the default Workspace project cannot be archived");
  return store.append({
    id: prefixedId("project_evt"),
    type: "project.updated",
    projectId,
    status,
    ...(input.name !== undefined ? { name: cleanRequired(input.name, "project name cannot be empty") } : {}),
    ...(input.description !== undefined ? { description: cleanString(input.description, "") } : {}),
    source: cleanString(input.source, "local")
  });
}

export async function listProjects(store: WorkspaceRecordStore, input: ProjectCommandInput = {}) {
  return listProjectPage(store, input);
}

export async function createGoal(store: WorkspaceRecordStore, input: GoalCommandInput = {}) {
  const scopeRecords = input.sessionId
    ? await sessionRecords(store, cleanRequired(input.sessionId, "goal.create requires sessionId"))
    : input.projectId
      ? await projectRecords(store, cleanRequired(input.projectId, "goal.create requires projectId"))
      : [];
  return store.append({
    id: prefixedId("goal"),
    type: "goal.created",
    status: "active",
    title: cleanRequired(input.title, "goal.create requires title"),
    description: cleanString(input.description, ""),
    tags: normalizeTags(input.tags),
    source: cleanString(input.source, "local"),
    ...resolveGoalScope(scopeRecords, input)
  });
}

export async function updateGoal(store: WorkspaceRecordStore, input: GoalCommandInput = {}) {
  const goalId = cleanRequired(input.goalId, "goal.update requires goalId");
  const current = await resolveGoal(store, goalId);
  if (!current) throw new Error(`goal not found: ${goalId}`);
  const status = cleanString(input.status, current.status);
  if (!GOAL_STATUSES.has(status)) throw new Error(`goal status must be one of: ${Array.from(GOAL_STATUSES).join(", ")}`);
  return store.append({
    id: prefixedId("goal_evt"),
    type: "goal.updated",
    goalId,
    status,
    ...(input.title === undefined ? {} : { title: cleanRequired(input.title, "goal title cannot be empty") }),
    ...(input.description === undefined ? {} : { description: cleanString(input.description, "") }),
    note: cleanString(input.note, ""),
    source: cleanString(input.source, "local")
  });
}

export async function listGoals(store: WorkspaceRecordStore, input: GoalCommandInput = {}) {
  return listGoalPage(store, input);
}

export function reduceSessions(records: WorkspaceRecord[]): SessionView[] {
  const sessions = new Map<string, SessionView>();
  for (const record of records) {
    if (record.type === "session.created") {
      const id = storedString(record.id, "");
      if (!id) continue;
      sessions.set(id, {
        id,
        title: storedString(record.title, "Untitled session"),
        status: storedString(record.status, "open"),
        createdAt: storedString(record.at, ""),
        updatedAt: storedString(record.at, ""),
        lastEventAt: storedString(record.at, ""),
        messageCount: 0,
        tags: storedStringArray(record.tags),
        actor: storedString(record.actor, "local"),
        source: storedString(record.source, "local"),
        projectId: storedString(record.projectId, DEFAULT_PROJECT_ID)
      });
      continue;
    }
    const current = sessions.get(storedString(record.sessionId, ""));
    if (!current) continue;
    if (record.type === "message.appended") {
      current.messageCount += 1;
      current.lastMessageRole = storedString(record.role, "");
    } else if (record.type === "session.renamed") current.title = storedString(record.title, current.title);
    else if (record.type === "session.assigned") current.projectId = storedString(record.projectId, DEFAULT_PROJECT_ID);
    else if (record.type === "session.updated") {
      if (record.title !== undefined) current.title = storedString(record.title, current.title);
      if (record.projectId !== undefined) current.projectId = storedString(record.projectId, current.projectId);
    } else if (record.type === "session.closed") current.status = "closed";
    else if (record.type === "session.deleted") current.status = "deleted";
    else continue;
    current.lastEventAt = storedString(record.at, "");
    current.updatedAt = storedString(record.at, "");
  }
  return Array.from(sessions.values()).sort((left, right) => right.lastEventAt.localeCompare(left.lastEventAt));
}

export function reduceProjects(records: WorkspaceRecord[]): ProjectView[] {
  const projects = new Map<string, ProjectView>([[DEFAULT_PROJECT_ID, {
    id: DEFAULT_PROJECT_ID,
    name: "Workspace",
    description: "Sessions and goals that have not been moved into another project.",
    status: "active",
    tags: [],
    createdAt: "",
    updatedAt: ""
  }]]);
  for (const record of records) {
    if (record.type === "project.created") {
      const id = storedString(record.id, "");
      if (!id) continue;
      projects.set(id, {
        id,
        name: storedString(record.name, ""),
        description: storedString(record.description, ""),
        status: storedString(record.status, "active"),
        tags: storedStringArray(record.tags),
        createdAt: storedString(record.at, ""),
        updatedAt: storedString(record.at, "")
      });
    } else if (record.type === "project.updated") {
      const current = projects.get(storedString(record.projectId, ""));
      if (!current) continue;
      if (record.name !== undefined) current.name = storedString(record.name, current.name);
      if (record.description !== undefined) current.description = storedString(record.description, current.description);
      if (record.status !== undefined) current.status = storedString(record.status, current.status);
      current.updatedAt = storedString(record.at, "");
    }
  }
  return Array.from(projects.values()).sort((left, right) => {
    if (left.id === DEFAULT_PROJECT_ID) return -1;
    if (right.id === DEFAULT_PROJECT_ID) return 1;
    return right.updatedAt.localeCompare(left.updatedAt);
  });
}

export function reduceGoals(records: WorkspaceRecord[]): GoalView[] {
  const goals = new Map<string, GoalView>();
  for (const record of records) {
    if (record.type === "goal.created") {
      const sessionId = storedString(record.sessionId, "");
      const id = storedString(record.id, "");
      if (!id) continue;
      goals.set(id, {
        id,
        title: storedString(record.title, ""),
        description: storedString(record.description, ""),
        status: storedString(record.status, "active"),
        tags: storedStringArray(record.tags),
        scopeType: storedString(record.scopeType, sessionId ? "session" : "project"),
        scopeId: storedString(record.scopeId, sessionId || storedString(record.projectId, DEFAULT_PROJECT_ID)),
        projectId: storedString(record.projectId, DEFAULT_PROJECT_ID),
        ...(sessionId ? { sessionId } : {}),
        createdAt: storedString(record.at, ""),
        updatedAt: storedString(record.at, ""),
        notes: []
      });
    } else if (record.type === "goal.updated") {
      const current = goals.get(storedString(record.goalId, ""));
      if (!current) continue;
      current.status = storedString(record.status, current.status);
      current.title = storedString(record.title, current.title);
      current.description = storedString(record.description, current.description);
      current.updatedAt = storedString(record.at, "");
      const note = storedString(record.note, "");
      if (note) current.notes.push({ at: storedString(record.at, ""), note, status: storedString(record.status, current.status) });
    }
  }
  const sessions = new Map(reduceSessions(records).map((session) => [session.id, session]));
  for (const goal of goals.values()) {
    if (!goal.sessionId) continue;
    const session = sessions.get(goal.sessionId);
    if (session) goal.projectId = session.projectId;
  }
  return Array.from(goals.values()).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function resolveGoalScope(records: WorkspaceRecord[], input: GoalCommandInput) {
  const sessionId = cleanString(input.sessionId, "");
  const requestedProjectId = cleanString(input.projectId, "");
  if (sessionId) {
    const session = reduceSessions(records).find((entry) => entry.id === sessionId && entry.status !== "deleted");
    if (!session) throw new Error(`session not found: ${sessionId}`);
    if (requestedProjectId && requestedProjectId !== session.projectId) throw new Error("goal projectId must match the selected session's project");
    return { scopeType: "session", scopeId: sessionId, sessionId, projectId: session.projectId };
  }
  const projectId = requestedProjectId || DEFAULT_PROJECT_ID;
  if (!reduceProjects(records).some((entry) => entry.id === projectId && entry.status !== "archived")) {
    throw new Error(`project not found or archived: ${projectId}`);
  }
  return { scopeType: "project", scopeId: projectId, projectId };
}

function prefixedId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

function cleanRequired(value: unknown, message: string): string {
  const cleaned = cleanString(value, "");
  if (!cleaned) throw new Error(message);
  return cleaned;
}

function cleanString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function storedString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function storedStringArray(value: unknown): string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? [...value]
    : [];
}

function normalizeTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  return Array.from(new Set(tags.map((tag) => cleanString(tag, "")).filter(Boolean))).slice(0, 20);
}

function normalizeLimit(value: unknown, fallback: number): number {
  const parsed = Number(value ?? fallback);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 200) : fallback;
}
