import { join } from "node:path";
import { readBrowserRecoveryJournal } from "./browser.ts";
import { validateProcessRecoveryJournal } from "./process-supervisor.ts";
import { readRecoveryJournalJson } from "./recovery-journal-file.ts";
import { validateSandboxRecoveryJournal } from "./sandbox-recovery.ts";

const PROCESS_MAX_BYTES = 512 * 1024;
const SANDBOX_MAX_BYTES = 256 * 1024;

export interface OperatorRecoveryInspection {
  readonly browser: { readonly invalid: boolean; readonly status?: string };
  readonly sandbox: { readonly invalid: boolean; readonly pendingCount?: number };
  readonly process: { readonly invalid: boolean; readonly pendingCount?: number };
}

/** Strict, read-only recovery projection shared by every presentation surface. */
export async function inspectOperatorRecovery(
  stateDir: string,
  { sandboxQuarantined = false, processQuarantined = false }: { readonly sandboxQuarantined?: boolean; readonly processQuarantined?: boolean } = {},
): Promise<OperatorRecoveryInspection> {
  const [browser, sandbox, processState] = await Promise.all([
    inspectBrowser(join(stateDir, "browser-recovery.json")),
    inspectPending(join(stateDir, "sandbox-recovery.json"), SANDBOX_MAX_BYTES, validateSandboxRecoveryJournal),
    inspectPending(join(stateDir, "process-recovery.json"), PROCESS_MAX_BYTES, validateProcessRecoveryJournal),
  ]);
  return Object.freeze({
    browser,
    sandbox: sandboxQuarantined ? Object.freeze({ invalid: true }) : sandbox,
    process: processQuarantined ? Object.freeze({ invalid: true }) : processState,
  });
}

async function inspectBrowser(path: string): Promise<OperatorRecoveryInspection["browser"]> {
  try {
    const value = await readBrowserRecoveryJournal(path);
    return Object.freeze({ invalid: false, status: String(value.status) });
  } catch {
    return Object.freeze({ invalid: true });
  }
}

async function inspectPending(
  path: string,
  maxBytes: number,
  validate: (value: unknown) => { readonly pending: readonly unknown[] },
): Promise<{ readonly invalid: boolean; readonly pendingCount?: number }> {
  try {
    const source = await readRecoveryJournalJson(path, maxBytes);
    if (source === undefined) return Object.freeze({ invalid: false, pendingCount: 0 });
    return Object.freeze({ invalid: false, pendingCount: validate(source).pending.length });
  } catch {
    return Object.freeze({ invalid: true });
  }
}
