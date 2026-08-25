import { spawnPnpmSync } from "../lib/package-manager.ts";

const gates = [
  "test:platform",
  "test:gateway",
  "test:invariants",
  "test:migrations",
  "test:lifecycle",
  "test:browser-lifecycle"
] as const;

for (const gate of gates) {
  const result = spawnPnpmSync([gate], { cwd: process.cwd(), encoding: "utf8", env: process.env });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error || result.status !== 0) {
    throw new Error(`${gate} failed: ${result.error?.message ?? `exit ${result.status ?? "unknown"}`}`);
  }
}
