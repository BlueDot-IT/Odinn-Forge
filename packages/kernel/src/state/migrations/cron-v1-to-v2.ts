import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { StateMigrationDefinition } from "./types.ts";

export const cronV1ToV2: StateMigrationDefinition = {
  id: "cron-v1-to-v2",
  surface: "cron",
  from: 1,
  to: 2,
  rollbackCompatible: false,
  async apply({ stateRoot }) {
    const path = join(stateRoot, "cron-jobs.json");
    const value = JSON.parse(await readFile(path, "utf8"));
    if (!value || value.schemaVersion !== 1 || !Array.isArray(value.jobs)) {
      throw new Error("cron-jobs.json is not a schema v1 job collection");
    }
    for (const [index, job] of value.jobs.entries()) validateLegacyCronJob(job, index);
    await writeFile(path, `${JSON.stringify({ ...value, schemaVersion: 2 }, null, 2)}\n`, { mode: 0o600 });
    await chmod(path, 0o600);
    return {
      changed: ["cron-jobs.json: upgraded schema 1 to 2 after validating every legacy definition; occurrence metadata is initialized lazily without changing job definitions"],
      preservedUnknownFields: true,
      notes: ["The state migration manager creates a protected backup before this upgrade.", "The scheduler persists nextRunAt and its dispatch lease before dispatching each occurrence.", "Rollback to a pre-v2 binary is refused because that binary cannot safely read occurrence metadata; restore the protected pre-migration backup instead."]
    };
  }
};

function validateLegacyCronJob(job: any, index: number) {
  const schedule = typeof job?.schedule === "string" ? job.schedule.trim() : "";
  const fields = schedule.split(/\s+/u);
  const ranges = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]] as const;
  if (fields.length !== 5 || fields.some((field: string, fieldIndex: number) => !parseField(field, ranges[fieldIndex][0], ranges[fieldIndex][1]))) {
    throw new Error(`cron migration refused legacy job ${String(job?.id || index)}: invalid five-field schedule`);
  }
  if (typeof job?.timezone !== "string" || !job.timezone.trim()) {
    throw new Error(`cron migration refused legacy job ${String(job?.id || index)}: missing timezone`);
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: job.timezone }).format();
  } catch {
    throw new Error(`cron migration refused legacy job ${String(job?.id || index)}: invalid IANA timezone`);
  }
  const days = parseField(fields[2], 1, 31)!;
  const months = parseField(fields[3], 1, 12)!;
  if (![...months].some((month) => [...days].some((day) => day <= new Date(Date.UTC(2024, month, 0)).getUTCDate()))) {
    throw new Error(`cron migration refused legacy job ${String(job?.id || index)}: impossible day/month combination`);
  }
}

function parseField(field: string, minimum: number, maximum: number): Set<number> | null {
  const values = new Set<number>();
  for (const token of field.split(",")) {
    const match = /^(?:(\d+)(?:-(\d+))?|\*)(?:\/(\d+))?$/u.exec(token);
    if (!match) return null;
    const start = match[1] === undefined ? minimum : Number(match[1]);
    const end = match[2] === undefined ? (match[1] === undefined ? maximum : start) : Number(match[2]);
    const step = match[3] === undefined ? 1 : Number(match[3]);
    if (start < minimum || end > maximum || start > end || step < 1) return null;
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return values.size ? values : null;
}
