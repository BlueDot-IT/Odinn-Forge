import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { StateMigrationDefinition } from "./types.ts";

export const configV0ToV1: StateMigrationDefinition = {
  id: "config-v0-to-v1",
  surface: "config",
  from: 0,
  to: 1,
  rollbackCompatible: true,
  async apply({ stateRoot }) {
    const path = join(stateRoot, "config.json");
    const input = JSON.parse(await readFile(path, "utf8"));
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("config.json must contain an object");
    if ("version" in input) throw new Error("config-v0-to-v1 requires a configuration with no version field");
    const temporary = `${path}.${process.pid}.${Date.now()}.migration.tmp`;
    await writeFile(temporary, `${JSON.stringify({ ...input, version: 1 }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
    await chmod(path, 0o600);
    return {
      changed: ["config.json: added explicit version 1"],
      preservedUnknownFields: true,
      notes: ["Existing policy and provider fields were preserved without changing security defaults."]
    };
  }
};
