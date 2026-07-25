import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { StateMigrationDefinition } from "./types.ts";

export const hostMetadataV0ToV1: StateMigrationDefinition = {
  id: "host-metadata-v0-to-v1",
  surface: "hostMetadata",
  from: 0,
  to: 1,
  rollbackCompatible: true,
  async apply({ stateRoot, applicationVersion, applicationCommit, minimumApplicationVersion, targetVersions }) {
    const path = join(stateRoot, "state-schema.json");
    await writeFile(path, `${JSON.stringify({
      schemaVersion: 1,
      applicationVersion,
      applicationCommit,
      storeVersions: targetVersions,
      minimumApplicationVersion,
      createdAt: new Date().toISOString()
    }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await chmod(path, 0o600);
    return {
      changed: ["state-schema.json: created the per-store compatibility manifest"],
      preservedUnknownFields: true,
      notes: ["Existing state stores were left in their independently owned schemas."]
    };
  }
};
