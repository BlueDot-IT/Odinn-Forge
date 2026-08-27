import { createHash, createHmac } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  LIVE_ONLY_SESSION_CONTENT_PLACEHOLDER,
  canonicalJson,
  projectLiveOnlySessionContent,
  type JsonObject
} from "@odinn/protocol";

const LIVE_ONLY_TOOLS = new Set([
  "email.accounts", "email.search", "email.read", "email.thread",
  "calendar.calendars", "calendar.events", "calendar.read"
]);
const SHA256_REFERENCE = /^sha256:[a-f0-9]{64}$/u;
const SHA256_DIGEST = /^[a-f0-9]{64}$/u;
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;

type RecordValue = Record<string, any>;
type SqlRow = Record<string, any>;
type SessionBinding = Readonly<{
  runId: string;
  sessionId: string;
  contentDigest: string;
  contentBytes: number;
  model?: string;
  provider?: string;
}>;
type QuarantinedMessage = Readonly<{
  sessionId: string;
  content: string;
  projection: ReturnType<typeof projectLiveOnlySessionContent>;
}>;

function hasTable(database: DatabaseSync, table: string): boolean {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as RecordValue;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${label} contains invalid JSON`);
  }
}

function ordinaryRecord(value: unknown): RecordValue | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : undefined;
}

function artifactRoot(stateRoot: string): string {
  return resolve(stateRoot, "artifacts");
}

function artifactPath(stateRoot: string, path: unknown): string {
  if (typeof path !== "string" || !path) throw new Error("run-ledger artifact path is invalid");
  const root = artifactRoot(stateRoot);
  const resolved = resolve(root, path);
  if (!resolved.startsWith(`${root}${sep}`)) throw new Error("run-ledger artifact path escaped its root");
  const metadata = lstatSync(resolved);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size > MAX_ARTIFACT_BYTES) {
    throw new Error("run-ledger artifact must be a bounded private physical file");
  }
  return resolved;
}

function readArtifact(database: DatabaseSync, stateRoot: string, digest: unknown): unknown {
  if (typeof digest !== "string" || !SHA256_DIGEST.test(digest)) return undefined;
  const row = database.prepare("SELECT path,size_bytes FROM artifacts WHERE digest=?").get(digest) as SqlRow | undefined;
  if (!row || Number(row.size_bytes) > MAX_ARTIFACT_BYTES) return undefined;
  const path = artifactPath(stateRoot, row.path);
  const bytes = readFileSync(path);
  if (hash(bytes) !== digest) throw new Error("run-ledger artifact failed its digest binding");
  return parseJson(bytes.toString("utf8"), "run-ledger artifact");
}

function toolName(row: SqlRow): string {
  const metadata = ordinaryRecord(parseJson(String(row.metadata_json), "run step metadata"));
  return typeof metadata?.toolName === "string" ? metadata.toolName : "";
}

function liveOnlyParentRuns(database: DatabaseSync): Set<string> {
  const parents = new Set<string>();
  if (!hasTable(database, "runs") || !hasTable(database, "run_steps")) return parents;
  const rows = database.prepare(`SELECT r.parent_run_id,s.metadata_json
    FROM runs r JOIN run_steps s ON s.run_id=r.id WHERE r.parent_run_id IS NOT NULL`).all() as SqlRow[];
  for (const row of rows) if (LIVE_ONLY_TOOLS.has(toolName(row))) parents.add(String(row.parent_run_id));
  return parents;
}

function attributableSessionBindings(database: DatabaseSync, stateRoot: string): SessionBinding[] {
  const bindings: SessionBinding[] = [];
  for (const runId of liveOnlyParentRuns(database)) {
    const steps = database.prepare("SELECT input_digest,output_digest,metadata_json FROM run_steps WHERE run_id=? ORDER BY sequence").all(runId) as SqlRow[];
    for (const step of steps) {
      if (toolName(step) !== "agent.run") continue;
      const input = ordinaryRecord(readArtifact(database, stateRoot, step.input_digest));
      const output = ordinaryRecord(readArtifact(database, stateRoot, step.output_digest));
      if (typeof input?.sessionId !== "string" || !input.sessionId
        || typeof output?.contentDigest !== "string" || !SHA256_REFERENCE.test(output.contentDigest)
        || !Number.isSafeInteger(output.contentBytes) || Number(output.contentBytes) < 0) continue;
      bindings.push({
        runId,
        sessionId: input.sessionId,
        contentDigest: output.contentDigest,
        contentBytes: Number(output.contentBytes),
        ...(typeof output.model === "string" ? { model: output.model } : {}),
        ...(typeof output.provider === "string" ? { provider: output.provider } : {})
      });
    }
  }
  return bindings;
}

function bindingForMessage(record: RecordValue, bindings: SessionBinding[]): SessionBinding | undefined {
  if (record.role !== "assistant" || typeof record.sessionId !== "string" || typeof record.content !== "string") return undefined;
  if (record.contentRetention?.mode === "live-only-provider-read") return undefined;
  const digest = `sha256:${hash(record.content)}`;
  const bytes = Buffer.byteLength(record.content, "utf8");
  return bindings.find((binding) => binding.sessionId === record.sessionId
    && binding.contentDigest === digest
    && binding.contentBytes === bytes
    && (!binding.model || !record.model || binding.model === record.model)
    && (!binding.provider || !record.provider || binding.provider === record.provider));
}

function quarantinedMessageRecord(record: RecordValue, projection: ReturnType<typeof projectLiveOnlySessionContent>, migratedAt: string): JsonObject {
  return {
    ...record,
    content: LIVE_ONLY_SESSION_CONTENT_PLACEHOLDER,
    contentRetention: {
      schemaVersion: 1,
      mode: "live-only-provider-read",
      contentUnavailable: true,
      contentDigest: projection.contentDigest,
      contentBytes: projection.contentBytes,
      quarantinedAfterUpgrade: true,
      quarantinedAt: migratedAt
    }
  };
}

function quarantineRecordDatabase(path: string, bindings: SessionBinding[], migratedAt: string, applyChanges: boolean): QuarantinedMessage[] {
  const database = new DatabaseSync(path);
  const messages: QuarantinedMessage[] = [];
  try {
    database.exec("PRAGMA busy_timeout=30000; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON; BEGIN IMMEDIATE");
    try {
      if (!hasTable(database, "record_events")) {
        database.exec("COMMIT");
        return messages;
      }
      const rows = database.prepare("SELECT sequence,payload_json FROM record_events WHERE type='message.appended'").all() as SqlRow[];
      for (const row of rows) {
        const record = ordinaryRecord(parseJson(String(row.payload_json), `session record ${String(row.sequence)}`));
        if (!record) continue;
        const binding = bindingForMessage(record, bindings);
        if (!binding) continue;
        const projection = projectLiveOnlySessionContent(record.content);
        if (applyChanges) {
          database.prepare("UPDATE record_events SET payload_json=? WHERE sequence=?").run(
            canonicalJson(quarantinedMessageRecord(record, projection, migratedAt)),
            row.sequence
          );
        }
        messages.push({ sessionId: binding.sessionId, content: String(record.content), projection });
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    if (applyChanges && messages.length > 0) {
      database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").all();
      database.exec("VACUUM");
      database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").all();
    }
  } finally {
    database.close();
  }
  return messages;
}

function projectionForContent(content: string, messages: QuarantinedMessage[]) {
  return messages.find((message) => message.content === content)?.projection;
}

function replaceSensitiveContent(value: unknown, messages: QuarantinedMessage[], migratedAt: string): unknown {
  if (typeof value === "string") return projectionForContent(value, messages)?.content ?? value;
  if (Array.isArray(value)) return value.map((item) => replaceSensitiveContent(item, messages, migratedAt));
  if (!value || typeof value !== "object") return value;
  const source = value as RecordValue;
  const next = Object.fromEntries(Object.entries(source).map(([key, item]) => [key, replaceSensitiveContent(item, messages, migratedAt)]));
  if (typeof source.content === "string") {
    const projection = projectionForContent(source.content, messages);
    if (projection) {
      next.content = projection.content;
      next.contentRetention = {
        schemaVersion: 1,
        mode: "live-only-provider-read",
        contentUnavailable: true,
        contentDigest: projection.contentDigest,
        contentBytes: projection.contentBytes,
        quarantinedAfterUpgrade: true,
        quarantinedAt: migratedAt
      };
    }
  }
  return next;
}

function containsSensitiveContent(value: unknown, messages: QuarantinedMessage[]): boolean {
  if (typeof value === "string") return messages.some((message) => message.content === value);
  if (Array.isArray(value)) return value.some((item) => containsSensitiveContent(item, messages));
  return Boolean(value && typeof value === "object"
    && Object.values(value as RecordValue).some((item) => containsSensitiveContent(item, messages)));
}

function writeArtifact(database: DatabaseSync, stateRoot: string, value: unknown): { digest: string; path: string; sizeBytes: number } {
  const bytes = Buffer.from(JSON.stringify(value), "utf8");
  const digest = hash(bytes);
  const relativePath = join("sha256", digest.slice(0, 2), digest).replaceAll("\\", "/");
  const path = resolve(artifactRoot(stateRoot), relativePath);
  if (!path.startsWith(`${artifactRoot(stateRoot)}${sep}`)) throw new Error("projected artifact path escaped its root");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (!existsSync(path)) writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
  chmodSync(path, 0o600);
  database.prepare("INSERT OR IGNORE INTO artifacts(digest,path,media_type,size_bytes,created_at) VALUES (?,?,?,?,?)")
    .run(digest, relativePath, "application/json", bytes.byteLength, new Date().toISOString());
  return { digest, path: relativePath, sizeBytes: bytes.byteLength };
}

function replaceDigestReferences(database: DatabaseSync, oldDigest: string, replacement: { digest: string; path: string; sizeBytes: number }): void {
  database.prepare("UPDATE run_steps SET input_digest=? WHERE input_digest=?").run(replacement.digest, oldDigest);
  database.prepare("UPDATE run_steps SET output_digest=? WHERE output_digest=?").run(replacement.digest, oldDigest);
  if (hasTable(database, "execution_attempts")) database.prepare("UPDATE execution_attempts SET outcome_digest=? WHERE outcome_digest=?").run(replacement.digest, oldDigest);
  if (hasTable(database, "snapshot_entries")) database.prepare("UPDATE snapshot_entries SET artifact_digest=? WHERE artifact_digest=?").run(replacement.digest, oldDigest);
  if (hasTable(database, "checkpoint_manifest_artifacts")) {
    database.prepare("UPDATE checkpoint_manifest_artifacts SET artifact_digest=?,artifact_path=?,size_bytes=? WHERE artifact_digest=?")
      .run(replacement.digest, replacement.path, replacement.sizeBytes, oldDigest);
  }
  if (hasTable(database, "assertion_results")) {
    const rows = database.prepare("SELECT id,evidence_artifact_ids_json FROM assertion_results").all() as SqlRow[];
    for (const row of rows) {
      const values = parseJson(String(row.evidence_artifact_ids_json), "assertion artifact references");
      if (!Array.isArray(values) || !values.includes(oldDigest)) continue;
      database.prepare("UPDATE assertion_results SET evidence_artifact_ids_json=? WHERE id=?")
        .run(JSON.stringify(values.map((value) => value === oldDigest ? replacement.digest : value)), row.id);
    }
  }
}

function rewriteRunLedgerEvents(database: DatabaseSync, runId: string, digestReplacements: Map<string, string>): void {
  const rows = database.prepare("SELECT id,sequence,type,timestamp,payload_json FROM ledger_events WHERE run_id=? ORDER BY sequence").all(runId) as SqlRow[];
  let previous: string | null = null;
  for (const row of rows) {
    const replace = (value: unknown): unknown => {
      if (typeof value === "string") return digestReplacements.get(value) ?? value;
      if (Array.isArray(value)) return value.map(replace);
      if (!value || typeof value !== "object") return value;
      return Object.fromEntries(Object.entries(value as RecordValue).map(([key, item]) => [key, replace(item)]));
    };
    const payload = replace(parseJson(String(row.payload_json), `ledger event ${String(row.id)}`));
    const envelope = { id: row.id, runId, sequence: Number(row.sequence), type: row.type, timestamp: row.timestamp, payload, previousHash: previous };
    const eventHash = hash(stable(envelope));
    database.prepare("UPDATE ledger_events SET payload_json=?,previous_hash=?,hash=? WHERE id=?")
      .run(JSON.stringify(payload), previous, eventHash, row.id);
    previous = eventHash;
  }
}

function sanitizeRuntimeDatabase(path: string, stateRoot: string, messages: QuarantinedMessage[], migratedAt: string): Set<string> {
  const affectedRuns = new Set<string>();
  const database = new DatabaseSync(path);
  const obsoleteArtifacts = new Set<string>();
  const retainedArtifacts = new Set<string>();
  try {
    database.exec("PRAGMA busy_timeout=30000; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON; BEGIN IMMEDIATE");
    try {
      const steps = database.prepare("SELECT id,run_id,input_digest,output_digest,metadata_json FROM run_steps ORDER BY run_id,sequence").all() as SqlRow[];
      for (const step of steps) {
        if (toolName(step) !== "session.message") continue;
        const input = ordinaryRecord(readArtifact(database, stateRoot, step.input_digest));
        if (!input || typeof input.content !== "string" || !projectionForContent(input.content, messages)) continue;
        affectedRuns.add(String(step.run_id));
      }
      const replacements = new Map<string, string>();
      const artifacts = database.prepare("SELECT digest FROM artifacts").all() as SqlRow[];
      for (const artifact of artifacts) {
        const oldDigest = String(artifact.digest ?? "");
        if (!SHA256_DIGEST.test(oldDigest)) continue;
        const raw = readArtifact(database, stateRoot, oldDigest);
        if (raw === undefined) {
          retainedArtifacts.add(oldDigest);
          continue;
        }
        const safe = replaceSensitiveContent(raw, messages, migratedAt);
        if (canonicalJson(raw) === canonicalJson(safe)) {
          retainedArtifacts.add(oldDigest);
          continue;
        }
        const referencingRuns = database.prepare("SELECT DISTINCT run_id FROM run_steps WHERE input_digest=? OR output_digest=?").all(oldDigest, oldDigest) as SqlRow[];
        for (const row of referencingRuns) affectedRuns.add(String(row.run_id));
        const replacement = writeArtifact(database, stateRoot, safe);
        replaceDigestReferences(database, oldDigest, replacement);
        replacements.set(oldDigest, replacement.digest);
        retainedArtifacts.add(replacement.digest);
        obsoleteArtifacts.add(oldDigest);
      }
      for (const runId of affectedRuns) {
        if (hasTable(database, "policy_evaluations")) {
          const rows = database.prepare("SELECT id,input_json FROM policy_evaluations WHERE run_id=?").all(runId) as SqlRow[];
          for (const row of rows) database.prepare("UPDATE policy_evaluations SET input_json=? WHERE id=?")
            .run(canonicalJson(replaceSensitiveContent(parseJson(String(row.input_json), "policy evaluation"), messages, migratedAt)), row.id);
        }
        rewriteRunLedgerEvents(database, runId, replacements);
      }
      for (const oldDigest of obsoleteArtifacts) database.prepare("DELETE FROM artifacts WHERE digest=?").run(oldDigest);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    if (affectedRuns.size > 0) {
      database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").all();
      database.exec("VACUUM");
      database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").all();
    }
  } finally {
    database.close();
  }
  for (const digest of obsoleteArtifacts) {
    const path = join(artifactRoot(stateRoot), "sha256", digest.slice(0, 2), digest);
    rmSync(path, { force: true });
  }
  removeOrphanSensitiveArtifacts(stateRoot, messages, retainedArtifacts);
  return affectedRuns;
}

function removeOrphanSensitiveArtifacts(stateRoot: string, messages: QuarantinedMessage[], retained: Set<string>): void {
  const root = artifactRoot(stateRoot);
  if (!existsSync(root)) return;
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
        continue;
      }
      if (!entry.isFile() || !SHA256_DIGEST.test(entry.name)) continue;
      const metadata = lstatSync(path);
      if (metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size > MAX_ARTIFACT_BYTES) continue;
      const bytes = readFileSync(path);
      if (!messages.some((message) => bytes.includes(message.content))) continue;
      if (retained.has(entry.name)) throw new Error("a referenced artifact retained live-only session content");
      rmSync(path, { force: true });
    }
  };
  visit(root);
}

function auditConfiguration(stateRoot: string): { databasePath: string; keyringPath: string } | undefined {
  const configPath = join(stateRoot, "config.json");
  const config = existsSync(configPath) ? ordinaryRecord(parseJson(readFileSync(configPath, "utf8"), "state config")) : {};
  const filename = typeof config?.auditLog === "string" ? config.auditLog : "audit.jsonl";
  if (!/^audit(?:-[A-Za-z0-9._-]+)?\.jsonl$/u.test(filename)) return undefined;
  return {
    databasePath: join(stateRoot, "db", `${basename(filename, ".jsonl")}.sqlite`),
    keyringPath: join(stateRoot, `${filename}.keys.json`)
  };
}

function unsignedAuditEvent(event: RecordValue): RecordValue {
  const data = ordinaryRecord(event.data) ?? {};
  const copy = { ...event, data: { ...data } };
  delete copy.data.__odinnIntegrity;
  return copy;
}

function segmentInventory(rows: SqlRow[]): RecordValue[] {
  return rows.map((row) => ({
    id: Number(row.id),
    firstSequence: Number(row.first_sequence),
    lastSequence: row.last_sequence === null ? null : Number(row.last_sequence),
    anchorSignature: row.anchor_signature ?? null,
    finalSignature: row.final_signature ?? null,
    openedAt: String(row.opened_at),
    closedAt: row.closed_at === null ? null : String(row.closed_at)
  }));
}

function sanitizeAuditDatabase(stateRoot: string, messages: QuarantinedMessage[], migratedAt: string, runtimeRuns: Set<string>): number {
  const paths = auditConfiguration(stateRoot);
  if (!paths || !existsSync(paths.databasePath)) return 0;
  const database = new DatabaseSync(paths.databasePath);
  let changed = 0;
  try {
    const rows = database.prepare("SELECT sequence,run_id,event_json FROM audit_events ORDER BY sequence").all() as SqlRow[];
    const affectedRuns = new Set(runtimeRuns);
    for (const row of rows) {
      const event = ordinaryRecord(parseJson(String(row.event_json), `audit event ${String(row.sequence)}`));
      const input = ordinaryRecord(event?.data)?.input;
      const record = ordinaryRecord(input);
      if (event?.tool !== "session.message" || !record || typeof record.content !== "string") continue;
      if (projectionForContent(record.content, messages)) affectedRuns.add(String(row.run_id));
    }
    if (affectedRuns.size === 0) return 0;
    const affectedRows = rows.filter((row) => affectedRuns.has(String(row.run_id)));
    if (!affectedRows.some((row) => containsSensitiveContent(parseJson(String(row.event_json), "audit event"), messages))) return 0;
    const state = database.prepare("SELECT retained_sequence,retained_signature FROM audit_state WHERE singleton=1").get() as SqlRow;
    const segments = database.prepare("SELECT * FROM audit_segments ORDER BY id").all() as SqlRow[];
    const retainedSequence = Number(state.retained_sequence);
    const retainedSignature = state.retained_signature === null ? null : String(state.retained_signature);
    if (rows.length > 0 && Number(rows[0]!.sequence) !== retainedSequence + 1) throw new Error("online audit history is not contiguous during live-only session quarantine");
    const keyring = ordinaryRecord(parseJson(readFileSync(paths.keyringPath, "utf8"), "audit keyring"));
    const current = typeof keyring?.current === "string" ? keyring.current : "";
    const keys = ordinaryRecord(keyring?.keys);
    const secret = typeof keys?.[current] === "string" ? Buffer.from(keys[current], "base64") : undefined;
    if (!current || !secret?.length) throw new Error("audit keyring is invalid during live-only session quarantine");
    database.exec("PRAGMA busy_timeout=30000; PRAGMA secure_delete=ON; BEGIN IMMEDIATE");
    try {
      let previous: string | null = retainedSignature;
      const projectedSegments = segments.map((segment) => ({ ...segment }));
      for (const row of rows) {
        const event = ordinaryRecord(parseJson(String(row.event_json), `audit event ${String(row.sequence)}`))!;
        let safeEvent = affectedRuns.has(String(row.run_id))
          ? replaceSensitiveContent(unsignedAuditEvent(event), messages, migratedAt) as RecordValue
          : unsignedAuditEvent(event);
        const sequence = Number(row.sequence);
        const segmentIndex = projectedSegments.findIndex((segment) => sequence >= Number(segment.first_sequence)
          && (segment.last_sequence === null || sequence <= Number(segment.last_sequence)));
        if (segmentIndex < 0) throw new Error("audit event is outside the segment inventory during live-only session quarantine");
        const segment = projectedSegments[segmentIndex]!;
        if (sequence === Number(segment.first_sequence) && segmentIndex > 0) {
          const closed = projectedSegments[segmentIndex - 1]!;
          closed.final_signature = previous;
          segment.anchor_signature = previous;
          if (safeEvent.type !== "audit.segment.rotated") throw new Error("audit segment is missing its rotation event during live-only session quarantine");
          safeEvent = {
            ...safeEvent,
            data: {
              ...(ordinaryRecord(safeEvent.data) ?? {}),
              segmentRotation: {
                closed: segmentInventory([closed])[0],
                opened: {
                  id: Number(segment.id),
                  firstSequence: Number(segment.first_sequence),
                  anchorSignature: segment.anchor_signature ?? null,
                  openedAt: String(segment.opened_at)
                }
              }
            }
          };
        }
        const signature: string = createHmac("sha256", secret).update(JSON.stringify({ event: safeEvent, previous })).digest("base64url");
        const signed = {
          ...safeEvent,
          data: { ...(ordinaryRecord(safeEvent.data) ?? {}), __odinnIntegrity: { keyId: current, previous, signature } }
        };
        if (String(row.event_json) !== JSON.stringify(signed)) changed += 1;
        database.prepare("UPDATE audit_events SET key_id=?,previous_signature=?,signature=?,event_json=? WHERE sequence=?")
          .run(current, previous, signature, JSON.stringify(signed), row.sequence);
        previous = signature;
        if (segment.last_sequence !== null && sequence === Number(segment.last_sequence)) segment.final_signature = signature;
      }
      database.prepare("UPDATE audit_state SET head_signature=?,current_key_id=?,updated_at=? WHERE singleton=1")
        .run(previous, current, new Date().toISOString());
      for (const segment of projectedSegments) {
        database.prepare("UPDATE audit_segments SET anchor_signature=?,final_signature=? WHERE id=?")
          .run(segment.anchor_signature ?? null, segment.last_sequence === null ? null : segment.final_signature ?? null, segment.id);
      }
      const updatedSegments = database.prepare("SELECT * FROM audit_segments ORDER BY id").all() as SqlRow[];
      const inventorySignature = createHmac("sha256", secret).update(JSON.stringify(segmentInventory(updatedSegments))).digest("base64url");
      database.prepare("UPDATE audit_segment_integrity SET key_id=?,signature=? WHERE singleton=1").run(current, inventorySignature);
      const summaries = database.prepare("SELECT run_id,summary_json FROM audit_runs").all() as SqlRow[];
      for (const summary of summaries) {
        if (!affectedRuns.has(String(summary.run_id))) continue;
        database.prepare("UPDATE audit_runs SET summary_json=? WHERE run_id=?")
          .run(canonicalJson(replaceSensitiveContent(parseJson(String(summary.summary_json), "audit run summary"), messages, migratedAt)), summary.run_id);
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    if (changed > 0) {
      database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").all();
      database.exec("VACUUM");
      database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").all();
    }
  } finally {
    database.close();
  }
  return changed;
}

/**
 * Quarantine model replies that are cryptographically attributable to an
 * agent run with a live email/calendar child read. Ambiguous historical
 * messages are left untouched rather than guessed at.
 */
export function quarantineLegacyLiveOnlySessionState(stateRoot: string): number {
  const runtimePath = join(stateRoot, "db", "odinn.sqlite");
  const recordsPath = join(stateRoot, "db", "records.sqlite");
  if (!existsSync(runtimePath) || !existsSync(recordsPath)) return 0;
  const runtime = new DatabaseSync(runtimePath, { readOnly: true });
  let bindings: SessionBinding[];
  try {
    bindings = attributableSessionBindings(runtime, stateRoot);
  } finally {
    runtime.close();
  }
  if (bindings.length === 0) return 0;
  const migratedAt = new Date().toISOString();
  // Discover first, then remove attributable copies from the auxiliary
  // ledger/audit stores. Keeping the authoritative record unchanged until
  // those rewrites succeed makes an interrupted run safely retryable.
  const messages = quarantineRecordDatabase(recordsPath, bindings, migratedAt, false);
  if (messages.length === 0) return 0;
  const affectedRuns = sanitizeRuntimeDatabase(runtimePath, stateRoot, messages, migratedAt);
  sanitizeAuditDatabase(stateRoot, messages, migratedAt, affectedRuns);
  const applied = quarantineRecordDatabase(recordsPath, bindings, migratedAt, true);
  if (applied.length !== messages.length) throw new Error("live-only session state changed during startup quarantine");
  return messages.length;
}
