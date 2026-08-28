process.env.ODINN_GATEWAY_AUTH = "off";

import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  GatewayInstanceOwnership,
  GatewayInstanceOwnershipError,
  gatewayOwnershipDirectory
} from "../apps/gateway/src/instance-ownership.ts";
import { createGatewayServer } from "../apps/gateway/src/server.ts";

const HOST_A = `sha256:${"a".repeat(64)}`;
const HOST_B = `sha256:${"b".repeat(64)}`;

async function closeServer(server: any): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error: Error | undefined) => error ? reject(error) : resolve()));
}

test("gateway admits one state owner and permits clean failover after release", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "odinn-gateway-instance-"));
  const ownershipDirectory = gatewayOwnershipDirectory(stateDir);
  const first = await createGatewayServer({ stateDir, workspaceRoot: stateDir });
  await new Promise<void>((resolve) => first.listen(0, "127.0.0.1", resolve));
  try {
    await assert.rejects(
      () => createGatewayServer({ stateDir, workspaceRoot: stateDir }),
      (error: unknown) => error instanceof GatewayInstanceOwnershipError
        && error.code === "GATEWAY_INSTANCE_OWNED"
        && error.status === 503
    );
  } finally {
    await closeServer(first);
  }

  const successor = await createGatewayServer({ stateDir, workspaceRoot: stateDir });
  await new Promise<void>((resolve) => successor.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${successor.address().port}/status`);
    assert.equal(response.status, 200);
  } finally {
    await closeServer(successor);
    await rm(stateDir, { recursive: true, force: true });
    await rm(ownershipDirectory, { recursive: true, force: true });
  }
});

test("expired cross-host takeover increments the epoch and fences the old owner", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "odinn-gateway-instance-epoch-"));
  const ownershipDirectory = gatewayOwnershipDirectory(stateDir);
  let now = Date.parse("2026-01-01T00:00:00.000Z");
  const first = new GatewayInstanceOwnership(stateDir, {
    ownerId: "gateway:first",
    ownerHostDigest: HOST_A,
    ownerPid: 1001,
    leaseMs: 100,
    heartbeatMs: 25,
    now: () => now,
    processAlive: () => false,
    disableHeartbeat: true
  });
  try {
    assert.equal(first.epoch, 1);
    now += 101;
    const successor = new GatewayInstanceOwnership(stateDir, {
      ownerId: "gateway:successor",
      ownerHostDigest: HOST_B,
      ownerPid: 2002,
      leaseMs: 100,
      heartbeatMs: 25,
      now: () => now,
      processAlive: () => false,
      disableHeartbeat: true
    });
    try {
      assert.equal(successor.epoch, 2);
      assert.equal(first.heartbeat(), false);
      assert.equal(first.signal.aborted, true);
      first.release();
      assert.equal(successor.isOwned(), true);
    } finally {
      successor.release();
    }
  } finally {
    first.release();
    await rm(stateDir, { recursive: true, force: true });
    await rm(ownershipDirectory, { recursive: true, force: true });
  }
});

test("a fenced live Gateway rejects new requests and closes", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "odinn-gateway-instance-fenced-"));
  const ownershipDirectory = gatewayOwnershipDirectory(stateDir);
  const server = await createGatewayServer({ stateDir, workspaceRoot: stateDir });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const database = new DatabaseSync(join(ownershipDirectory, "gateway-instance.sqlite"));
  database.prepare(`UPDATE gateway_instance_lease
    SET owner_id = ?, owner_host_digest = ?, epoch = epoch + 1,
      heartbeat_at = ?, expires_at = ?
    WHERE singleton = 1`).run(
    "gateway:successor",
    HOST_B,
    new Date().toISOString(),
    new Date(Date.now() + 60_000).toISOString()
  );
  database.close();

  const response = await fetch(`http://127.0.0.1:${port}/status`);
  assert.equal(response.status, 503);
  assert.equal(server.listening, false);

  await rm(stateDir, { recursive: true, force: true });
  await rm(ownershipDirectory, { recursive: true, force: true });
});

test("expired same-host lease refuses takeover while the prior process remains alive", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "odinn-gateway-instance-live-owner-"));
  const ownershipDirectory = gatewayOwnershipDirectory(stateDir);
  let now = Date.parse("2026-01-01T00:00:00.000Z");
  const first = new GatewayInstanceOwnership(stateDir, {
    ownerId: "gateway:first",
    ownerHostDigest: HOST_A,
    ownerPid: 1001,
    leaseMs: 100,
    heartbeatMs: 25,
    now: () => now,
    processAlive: () => true,
    disableHeartbeat: true
  });
  try {
    now += 101;
    assert.throws(
      () => new GatewayInstanceOwnership(stateDir, {
        ownerId: "gateway:second",
        ownerHostDigest: HOST_A,
        ownerPid: 2002,
        leaseMs: 100,
        heartbeatMs: 25,
        now: () => now,
        processAlive: () => true,
        disableHeartbeat: true
      }),
      /owner process is still alive/u
    );
  } finally {
    first.release();
    await rm(stateDir, { recursive: true, force: true });
    await rm(ownershipDirectory, { recursive: true, force: true });
  }
});

test("ownership state is owner-only and refuses a forged schema", { skip: process.platform === "win32" }, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "odinn-gateway-instance-schema-"));
  const ownership = new GatewayInstanceOwnership(stateDir, { disableHeartbeat: true });
  const ownershipDirectory = gatewayOwnershipDirectory(stateDir);
  try {
    assert.equal((await stat(ownershipDirectory)).mode & 0o777, 0o700);
    assert.equal((await stat(ownership.path)).mode & 0o777, 0o600);
  } finally {
    ownership.release();
  }

  await rm(ownership.path, { force: true });
  const database = new DatabaseSync(ownership.path);
  database.exec("CREATE TABLE gateway_instance_lease(singleton INTEGER PRIMARY KEY)");
  database.close();
  assert.throws(() => new GatewayInstanceOwnership(stateDir, { disableHeartbeat: true }), /ownership schema is invalid/u);

  await rm(stateDir, { recursive: true, force: true });
  await rm(ownershipDirectory, { recursive: true, force: true });
});
