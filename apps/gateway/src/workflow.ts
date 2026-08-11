const DEFAULT_WORKFLOW_HEARTBEAT_MS = 30_000;

/** Keep a live gateway-owned workflow lease current until its dispatch settles. */
export async function runWithWorkflowLeaseHeartbeat<T>(
  operation: () => Promise<T>,
  renewLease: () => boolean,
  intervalMs = DEFAULT_WORKFLOW_HEARTBEAT_MS
): Promise<T> {
  if (!Number.isInteger(intervalMs) || intervalMs < 1) throw new Error("workflow heartbeat interval must be a positive integer");
  const timer = setInterval(() => {
    if (!renewLease()) clearInterval(timer);
  }, intervalMs);
  timer.unref?.();
  try {
    return await operation();
  } finally {
    clearInterval(timer);
  }
}
