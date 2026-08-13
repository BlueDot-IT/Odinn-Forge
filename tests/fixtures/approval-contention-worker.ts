import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createApprovalStoreWithTestHooks, type ApprovalAction } from "../../packages/kernel/src/approvals.ts";

type WorkerInput = {
  action: ApprovalAction;
  ageOwnedLock?: boolean;
  barrierTimeoutMs?: number;
  contentionReadyPath?: string;
  dispatchPath?: string;
  id: string;
  lockTimeoutMs?: number;
  operation: "consume" | "list";
  ownerReadyPath?: string;
  path: string;
  releasePath?: string;
};

const input = JSON.parse(process.argv[2] ?? "null") as WorkerInput;
const lockPath = `${input.path}.lock`;
const waitState = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

function waitForBarrier(path: string, timeoutMs = 10_000): void {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for test barrier: ${path}`);
    Atomics.wait(waitState, 0, 0, 10);
  }
}

const store = createApprovalStoreWithTestHooks({
  path: input.path,
  ...(input.lockTimeoutMs === undefined ? {} : { lockTimeoutMs: input.lockTimeoutMs }),
  __testOnlyAfterLockAcquired() {
    if (!input.ownerReadyPath || !input.releasePath) return;
    if (input.ageOwnedLock) {
      const lease = JSON.parse(readFileSync(lockPath, "utf8"));
      writeFileSync(lockPath, JSON.stringify({ ...lease, createdAt: Date.now() - 60_000 }), { mode: 0o600 });
    }
    writeFileSync(input.ownerReadyPath, "owned\n", { mode: 0o600 });
    waitForBarrier(input.releasePath, input.barrierTimeoutMs);
  },
  __testOnlyOnLockContention() {
    if (input.contentionReadyPath) writeFileSync(input.contentionReadyPath, "contended\n", { mode: 0o600 });
  }
});

try {
  if (input.operation === "list") {
    await store.listAsync!();
    process.stdout.write(`${JSON.stringify({ outcome: "listed" })}\n`);
  } else {
    const approval = await store.consumeAsync!(input.id, input.action);
    if (approval && input.dispatchPath) appendFileSync(input.dispatchPath, `${process.pid}\n`, { mode: 0o600 });
    process.stdout.write(`${JSON.stringify({ outcome: approval ? "approved" : "denied" })}\n`);
  }
} catch (error) {
  process.stdout.write(`${JSON.stringify({
    outcome: "error",
    code: error && typeof error === "object" && "code" in error ? String(error.code) : "",
    message: error instanceof Error ? error.message : String(error)
  })}\n`);
}
