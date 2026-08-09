import type { JsonObject } from "@odinn/protocol";

export const OPERATOR_CONTRACT_VERSION = 1 as const;
export const OPERATOR_MAX_PAGE_SIZE = 50;
export const OPERATOR_DEFAULT_PAGE_SIZE = 10;

export type OperatorSurface = "cli" | "tui" | "http" | "console";
export type OperatorHealth = "healthy" | "attention" | "degraded";
export type OperatorActionName =
  | "cancel-job"
  | "approve"
  | "cancel-workflow"
  | "resume-workflow"
  | "verify-audit";

export type OperatorPage = {
  page: number;
  pageSize: number;
  pages: number;
  total: number;
  from: number;
  to: number;
};

export type OperatorItem = {
  id: string;
  kind: string;
  label: string;
  status: string;
  summary?: string;
  updatedAt?: string;
  attention?: boolean;
  controls?: OperatorActionName[];
  details?: JsonObject;
};

export type OperatorSection = {
  status: OperatorHealth;
  counts: Record<string, number>;
  items: OperatorItem[];
  pagination: OperatorPage;
};

export type OperatorActionDescriptor = {
  action: OperatorActionName;
  label: string;
  mutation: boolean;
  requiresTarget: boolean;
  confirmation: boolean;
};

export type OperatorSnapshot = {
  schemaVersion: typeof OPERATOR_CONTRACT_VERSION;
  generatedAt: string;
  surface: OperatorSurface;
  identity: {
    state: string;
    workspaceRoot: string;
    version?: string;
    commit?: string;
  };
  health: {
    status: OperatorHealth;
    ok: boolean;
    attention: number;
    summary: string;
  };
  sections: {
    runtime: OperatorSection;
    work: OperatorSection;
    approvals: OperatorSection;
    automation: OperatorSection;
    context: OperatorSection;
    recovery: OperatorSection;
    audit: OperatorSection;
    surfaces: OperatorSection;
  };
  actions: OperatorActionDescriptor[];
};

export type OperatorSectionInput = {
  status?: OperatorHealth;
  counts?: Record<string, number>;
  items?: OperatorSectionItemInput[];
};

type OperatorSectionItemInput = Partial<OperatorItem> & { id: string; kind: string; label: string; status: string };

export type OperatorSnapshotInput = {
  surface: OperatorSurface;
  identity: OperatorSnapshot["identity"];
  health?: Partial<OperatorSnapshot["health"]>;
  sections?: Partial<Record<keyof OperatorSnapshot["sections"], OperatorSectionInput>>;
  page?: number;
  pageSize?: number;
  actions?: OperatorActionDescriptor[];
};

const ACTIONS: OperatorActionDescriptor[] = [
  { action: "cancel-job", label: "Cancel job", mutation: true, requiresTarget: true, confirmation: true },
  { action: "approve", label: "Approve once", mutation: true, requiresTarget: true, confirmation: true },
  { action: "cancel-workflow", label: "Cancel workflow", mutation: true, requiresTarget: true, confirmation: true },
  { action: "resume-workflow", label: "Resume workflow", mutation: true, requiresTarget: true, confirmation: true },
  { action: "verify-audit", label: "Verify audit", mutation: false, requiresTarget: false, confirmation: false }
];

const SENSITIVE_KEY = /(?:api.?key|access.?token|refresh.?token|client.?secret|password|authorization|cookie|header|credential|private.?key|prompt|content|result)/iu;
const SENSITIVE_VALUE = /(?:bearer\s+|basic\s+|https?:\/\/[^\s/@:]+:[^\s/@]+@|(?:api[-_]?key|access[-_]?token|refresh[-_]?token|client[-_]?secret|password|authorization)\s*[=:]\s*)/iu;

function safeText(value: unknown, fallback = ""): string {
  const text = String(value ?? fallback).replace(/\s+/gu, " ").trim();
  if (!text || SENSITIVE_VALUE.test(text)) return fallback;
  return text.length > 240 ? `${text.slice(0, 237)}...` : text;
}

/** Project arbitrary runtime data into a bounded, credential-safe operator value. */
export function redactOperatorValue(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[bounded]";
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return safeText(value, "[redacted]");
  if (Array.isArray(value)) return value.slice(0, 50).map((entry) => redactOperatorValue(entry, depth + 1));
  if (!value || typeof value !== "object") return undefined;
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>).slice(0, 50)) {
    if (SENSITIVE_KEY.test(key)) {
      output[key] = "[redacted]";
      continue;
    }
    output[key] = redactOperatorValue(entry, depth + 1);
  }
  return output;
}

function normalizePage(page: unknown, pageSize: unknown): { page: number; pageSize: number } {
  const normalizedPage = Number.isSafeInteger(Number(page)) && Number(page) > 0 ? Number(page) : 1;
  const requestedSize = Number.isSafeInteger(Number(pageSize)) && Number(pageSize) > 0 ? Number(pageSize) : OPERATOR_DEFAULT_PAGE_SIZE;
  return { page: normalizedPage, pageSize: Math.min(OPERATOR_MAX_PAGE_SIZE, Math.max(1, requestedSize)) };
}

export function paginateOperatorItems<T>(items: readonly T[], page: unknown = 1, pageSize: unknown = OPERATOR_DEFAULT_PAGE_SIZE): { items: T[]; pagination: OperatorPage } {
  const normalized = normalizePage(page, pageSize);
  const total = items.length;
  const pages = Math.max(1, Math.ceil(total / normalized.pageSize));
  const currentPage = Math.min(normalized.page, pages);
  const offset = (currentPage - 1) * normalized.pageSize;
  return {
    items: items.slice(offset, offset + normalized.pageSize),
    pagination: {
      page: currentPage,
      pageSize: normalized.pageSize,
      pages,
      total,
      from: total ? offset + 1 : 0,
      to: total ? Math.min(offset + normalized.pageSize, total) : 0
    }
  };
}

function sectionStatus(input: OperatorSectionInput): OperatorHealth {
  if (input.status) return input.status;
  return (input.items ?? []).some((item) => item.attention === true || ["failed", "needs-review", "blocked", "degraded"].includes(item.status))
    ? "attention"
    : "healthy";
}

function normalizeItem(input: OperatorSectionItemInput): OperatorItem {
  const details = input.details && typeof input.details === "object" && !Array.isArray(input.details)
    ? redactOperatorValue(input.details) as JsonObject
    : undefined;
  const allowedActions = new Set(ACTIONS.map((action) => action.action));
  const controls = Array.isArray(input.controls)
    ? input.controls.filter((control): control is OperatorActionName => allowedActions.has(control)).slice(0, 8)
    : [];
  return {
    id: safeText(input.id, "unknown"),
    kind: safeText(input.kind, "item"),
    label: safeText(input.label, "Untitled"),
    status: safeText(input.status, "unknown"),
    ...(input.summary ? { summary: safeText(input.summary) } : {}),
    ...(input.updatedAt ? { updatedAt: safeText(input.updatedAt) } : {}),
    ...(input.attention === true ? { attention: true } : {}),
    ...(controls.length ? { controls } : {}),
    ...(details ? { details } : {})
  };
}

function buildSection(input: OperatorSectionInput = {}, page = 1, pageSize = OPERATOR_DEFAULT_PAGE_SIZE): OperatorSection {
  const allItems = (input.items ?? []).slice(0, 500).map(normalizeItem);
  const { items, pagination } = paginateOperatorItems(allItems, page, pageSize);
  const counts = Object.fromEntries(Object.entries(input.counts ?? {}).map(([key, value]) => [safeText(key, "other"), Math.max(0, Number(value) || 0)]));
  if (!counts.total) counts.total = allItems.length;
  return { status: sectionStatus({ ...input, items: allItems }), counts, items, pagination };
}

export function defaultOperatorActions(): OperatorActionDescriptor[] {
  return ACTIONS.map((action) => ({ ...action }));
}

export function buildOperatorSnapshot(input: OperatorSnapshotInput): OperatorSnapshot {
  const page = input.page ?? 1;
  const pageSize = input.pageSize ?? OPERATOR_DEFAULT_PAGE_SIZE;
  const sections = input.sections ?? {};
  const normalizedSections = {
    runtime: buildSection(sections.runtime, page, pageSize),
    work: buildSection(sections.work, page, pageSize),
    approvals: buildSection(sections.approvals, page, pageSize),
    automation: buildSection(sections.automation, page, pageSize),
    context: buildSection(sections.context, page, pageSize),
    recovery: buildSection(sections.recovery, page, pageSize),
    audit: buildSection(sections.audit, page, pageSize),
    surfaces: buildSection(sections.surfaces, page, pageSize)
  } satisfies OperatorSnapshot["sections"];
  const attention = Object.values(normalizedSections).reduce((sum, section) => sum + section.items.filter((item) => item.attention === true || section.status !== "healthy").length, 0);
  const status: OperatorHealth = input.health?.status ?? (attention ? "attention" : "healthy");
  return {
    schemaVersion: OPERATOR_CONTRACT_VERSION,
    generatedAt: new Date().toISOString(),
    surface: input.surface,
    identity: {
      state: safeText(input.identity.state, "unknown"),
      workspaceRoot: safeText(input.identity.workspaceRoot, "unknown"),
      ...(input.identity.version ? { version: safeText(input.identity.version) } : {}),
      ...(input.identity.commit ? { commit: safeText(input.identity.commit) } : {})
    },
    health: {
      status,
      ok: input.health?.ok ?? status === "healthy",
      attention: input.health?.attention ?? attention,
      summary: safeText(input.health?.summary, status === "healthy" ? "All governed surfaces are operating normally." : "One or more governed surfaces need operator attention.")
    },
    sections: normalizedSections,
    actions: (input.actions ?? defaultOperatorActions()).slice(0, ACTIONS.length)
  };
}

export function operatorActionNames(): OperatorActionName[] {
  return ACTIONS.map((action) => action.action);
}
