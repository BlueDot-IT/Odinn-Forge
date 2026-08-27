import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRemoteNodeResponder,
  type RemoteNodeDiagnosticsSnapshot,
  type RemoteNodeStatusSnapshot
} from "../../packages/kernel/src/index.ts";

export type AuthenticatedRemoteNodeFixture = Readonly<{
  nodeId: string;
  hostname: string;
  address: string;
  origin: string;
  tokenEnv: string;
  environment: NodeJS.ProcessEnv;
  certificate: Buffer;
  statusSnapshot: RemoteNodeStatusSnapshot;
  diagnosticsSnapshot: RemoteNodeDiagnosticsSnapshot;
  close(): Promise<void>;
}>;

export async function createAuthenticatedRemoteNodeFixture(): Promise<AuthenticatedRemoteNodeFixture | undefined> {
  if (spawnSync("openssl", ["version"], { stdio: "ignore" }).status !== 0) return undefined;
  const directory = await mkdtemp(join(tmpdir(), "odinn-remote-node-tls-"));
  const keyPath = join(directory, "fixture-key.pem");
  const certificatePath = join(directory, "fixture-certificate.pem");
  const hostname = "remote-node.test";
  const generated = spawnSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-sha256", "-nodes",
    "-keyout", keyPath,
    "-out", certificatePath,
    "-days", "1",
    "-subj", `/CN=${hostname}`,
    "-addext", `subjectAltName=DNS:${hostname}`
  ], { encoding: "utf8" });
  if (generated.status !== 0) {
    await rm(directory, { recursive: true, force: true });
    return undefined;
  }
  const [key, certificate] = await Promise.all([readFile(keyPath), readFile(certificatePath)]);
  const nodeId = "fixture-node";
  const tokenEnv = "ODINN_TEST_REMOTE_NODE_TOKEN";
  const environment = { [tokenEnv]: "synthetic-remote-node-credential" };
  const statusSnapshot = Object.freeze({
    observedAt: "2026-08-27T12:00:00.000Z",
    status: "ready" as const,
    uptimeSeconds: 7_200,
    activeTasks: 2,
    queuedTasks: 1
  });
  const diagnosticsSnapshot = Object.freeze({
    observedAt: "2026-08-27T12:00:01.000Z",
    status: "degraded" as const,
    checks: Object.freeze([
      Object.freeze({ name: "runtime" as const, status: "pass" as const }),
      Object.freeze({ name: "storage" as const, status: "warn" as const }),
      Object.freeze({ name: "network" as const, status: "pass" as const })
    ])
  });
  const server = createRemoteNodeResponder({
    enabled: true,
    nodeId,
    tokenEnv,
    environment,
    tls: { key, cert: certificate },
    status: async () => statusSnapshot,
    diagnostics: async () => diagnosticsSnapshot
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("remote node fixture did not bind a TCP port");
  return Object.freeze({
    nodeId,
    hostname,
    address: "127.0.0.1",
    origin: `https://${hostname}:${address.port}`,
    tokenEnv,
    environment,
    certificate,
    statusSnapshot,
    diagnosticsSnapshot,
    close: async () => {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      await rm(directory, { recursive: true, force: true });
    }
  });
}
