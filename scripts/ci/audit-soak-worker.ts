import { SqliteAuditStore } from "../../packages/store-sqlite/src/audit.ts";

const [path, keyringPath, writerId, rawCount] = process.argv.slice(2);
if (!path || !keyringPath || !writerId) throw new Error("audit soak worker requires database, keyring, and writer id");
const count = Number(rawCount);
if (!Number.isSafeInteger(count) || count < 1) throw new Error("audit soak worker count must be positive");
const store = new SqliteAuditStore(path, { keyringPath });
try {
  for (let index = 0; index < count; index++) await store.append({ at: new Date().toISOString(), runId: `soak-${writerId}-${index % 100}`, type: index % 2 ? "task.started" : "task.completed", actor: `soak-${writerId}`, tool: "soak", capability: "audit.append", decision: "allow", data: { writerId, index } });
} finally { store.close(); }
