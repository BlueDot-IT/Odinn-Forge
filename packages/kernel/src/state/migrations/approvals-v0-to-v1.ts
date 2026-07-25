import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { StateMigrationDefinition } from "./types.ts";

export const approvalsV0ToV1: StateMigrationDefinition = {
  id: "approvals-v0-to-v1",
  surface: "approvals",
  from: 0,
  to: 1,
  rollbackCompatible: true,
  async apply({ stateRoot }) {
    const path = join(stateRoot, "approvals.json");
    const approvals = JSON.parse(await readFile(path, "utf8"));
    if (!Array.isArray(approvals)) throw new Error("approvals-v0-to-v1 requires the legacy approval array");
    if (approvals.some((approval) => !approval || typeof approval !== "object" || Array.isArray(approval))) {
      throw new Error("legacy approval entries must be objects");
    }
    const temporary = `${path}.${process.pid}.${Date.now()}.migration.tmp`;
    await writeFile(temporary, `${JSON.stringify({ schemaVersion: 1, approvals }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
    await chmod(path, 0o600);
    return {
      changed: ["approvals.json: wrapped the legacy array in the versioned approval store"],
      preservedUnknownFields: true,
      notes: ["Approval records and pending status values were preserved."]
    };
  }
};
