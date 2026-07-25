import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { StateMigrationDefinition } from "./types.ts";

export const browserRecoveryV0ToV1: StateMigrationDefinition = {
  id: "browser-recovery-v0-to-v1",
  surface: "browserRecovery",
  from: 0,
  to: 1,
  rollbackCompatible: true,
  async apply({ stateRoot }) {
    const changed: string[] = [];
    for (const filename of ["browser-recovery.json", "browser-tabs.json"]) {
      const path = join(stateRoot, filename);
      let input: Record<string, unknown>;
      try {
        const parsed = JSON.parse(await readFile(path, "utf8"));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${filename} must contain an object`);
        input = parsed;
      } catch (error: unknown) {
        if (isCode(error, "ENOENT")) continue;
        throw error;
      }
      if ("schemaVersion" in input) continue;
      const temporary = `${path}.${process.pid}.${Date.now()}.migration.tmp`;
      await writeFile(temporary, `${JSON.stringify({ schemaVersion: 1, ...input }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      await rename(temporary, path);
      await chmod(path, 0o600);
      changed.push(`${filename}: added explicit schemaVersion 1`);
    }
    if (!changed.length) throw new Error("browser-recovery-v0-to-v1 found no legacy browser state");
    return {
      changed,
      preservedUnknownFields: true,
      notes: ["Recovery status and durable browser handles were preserved; unknown outcomes were not cleared."]
    };
  }
};

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
