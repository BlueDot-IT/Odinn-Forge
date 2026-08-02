import { AUDIT_SCHEMA_VERSION } from "@odinn/protocol";
import { STORE_SCHEMA_VERSION } from "@odinn/store-file";
import { AUTHORITATIVE_RECORD_SCHEMA_VERSION, SQLITE_SCHEMA_VERSION } from "@odinn/store-sqlite";

export const STATE_SCHEMA_MINIMUM_APPLICATION_VERSION = "0.4.0";

export const STATE_SCHEMA_TARGETS = Object.freeze({
  config: 1,
  records: AUTHORITATIVE_RECORD_SCHEMA_VERSION,
  jobs: STORE_SCHEMA_VERSION,
  audit: AUDIT_SCHEMA_VERSION,
  approvals: 1,
  browserRecovery: 1,
  sessions: AUTHORITATIVE_RECORD_SCHEMA_VERSION,
  projects: AUTHORITATIVE_RECORD_SCHEMA_VERSION,
  goals: AUTHORITATIVE_RECORD_SCHEMA_VERSION,
  memory: AUTHORITATIVE_RECORD_SCHEMA_VERSION,
  cron: 2,
  extensions: 1,
  skills: 1,
  agents: 1,
  hostMetadata: 1,
  runtimeDatabase: SQLITE_SCHEMA_VERSION
});

export type StateSurface = keyof typeof STATE_SCHEMA_TARGETS;
export type StateSchemaVersions = { [Surface in StateSurface]: number };
export type StateSupport = "stable" | "experimental" | "internal";

export type StateSchemaOwner = {
  owner: string;
  location: string;
  support: StateSupport;
  description: string;
};

export const STATE_SCHEMA_OWNERS: Readonly<Record<StateSurface, StateSchemaOwner>> = Object.freeze({
  config: { owner: "@odinn/kernel/config", location: "config.json", support: "stable", description: "Configuration and security policy" },
  records: { owner: "@odinn/store-sqlite", location: "db/records.sqlite", support: "stable", description: "Typed append-only product records" },
  jobs: { owner: "@odinn/store-sqlite", location: "db/odinn.sqlite:runtime_jobs", support: "stable", description: "Tasks, execution-attempt bindings, leases, retries, and uncertain outcomes; jobs.json is legacy import evidence" },
  audit: { owner: "@odinn/protocol + @odinn/store-file", location: "audit*.jsonl", support: "stable", description: "Audit events and verification keyring" },
  approvals: { owner: "@odinn/kernel/approvals", location: "approvals.json", support: "stable", description: "Pending and consumed approvals" },
  browserRecovery: { owner: "@odinn/kernel/browser", location: "browser-recovery.json + browser-tabs.json", support: "stable", description: "Browser uncertain-outcome recovery and durable handles" },
  sessions: { owner: "@odinn/kernel/sessions", location: "db/records.sqlite:session.*", support: "stable", description: "Sessions and messages" },
  projects: { owner: "@odinn/kernel/projects", location: "db/records.sqlite:project.*", support: "stable", description: "Projects" },
  goals: { owner: "@odinn/kernel/goals", location: "db/records.sqlite:goal.*", support: "stable", description: "Goals" },
  memory: { owner: "@odinn/kernel/memory", location: "db/records.sqlite:memory.*", support: "stable", description: "Memory records" },
  cron: { owner: "@odinn/gateway/cron", location: "cron-jobs.json", support: "stable", description: "Cron definitions and run metadata" },
  extensions: { owner: "@odinn/kernel/extensions", location: "extensions.json", support: "experimental", description: "Third-party extension registry" },
  skills: { owner: "@odinn/kernel/skills", location: "skills/registry.json", support: "experimental", description: "Skill package registry" },
  agents: { owner: "@odinn/kernel/agents", location: "agents.json + agents/*", support: "stable", description: "Agent SDK registry, manifests, and provider-independent identity files" },
  hostMetadata: { owner: "@odinn/kernel/state", location: "state-schema.json", support: "internal", description: "Per-store schema snapshot and application compatibility metadata" },
  runtimeDatabase: { owner: "@odinn/store-sqlite", location: "db/odinn.sqlite", support: "stable", description: "Run ledger and runtime records" }
});

export function targetStateSchemaVersions(): StateSchemaVersions {
  return { ...STATE_SCHEMA_TARGETS };
}
