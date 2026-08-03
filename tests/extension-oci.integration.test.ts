import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAuditStore, createDifferentiatedRuntime } from "../packages/kernel/src/index.ts";
import { digestExtensionBundle, ExtensionExecutor, ExtensionRegistry } from "../packages/kernel/src/extensions.ts";
import { createDefaultPolicy } from "../packages/policy/src/index.ts";

const image = String(process.env.ODINN_TEST_EXTENSION_OCI_IMAGE ?? "");
const enabled = process.env.ODINN_RUN_OCI_TESTS === "1" && Boolean(image);

test("real extension execution seals, audits, dispatches, parses, and removes its OCI container", { skip: !enabled }, async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-extension-oci-"));
  const bundle = join(root, "bundle");
  const stateDir = join(root, ".odinn");
  await mkdir(bundle);
  await writeFile(join(bundle, "main.js"), [
    'let raw = "";',
    'process.stdin.setEncoding("utf8");',
    'process.stdin.on("data", (chunk) => raw += chunk);',
    'process.stdin.on("end", () => {',
    '  const request = JSON.parse(raw);',
    '  process.stdout.write(JSON.stringify({ result: { echoed: request.input.text, hostSecret: process.env.ODINN_EXTENSION_HOST_SECRET || null } }) + "\\n");',
    '});'
  ].join("\n"));
  const registry = new ExtensionRegistry(join(stateDir, "extensions.json"));
  await registry.install({
    id: "oci-e2e",
    version: "1.0.0",
    type: "tool",
    entrypoint: "bundle/main.js",
    bundleRoot: "bundle",
    capabilities: ["text.echo"],
    sandbox: "container",
    bundleDigest: await digestExtensionBundle(bundle),
    containerImage: image
  });
  await registry.enable("oci-e2e", { grants: ["text.echo"], trust: true });
  const differentiated = createDifferentiatedRuntime({ stateDir, workspaceRoot: root });
  const auditStore = createAuditStore(join(stateDir, "audit.jsonl"));
  try {
    const executor = new ExtensionExecutor(registry, {
      workspaceRoot: root,
      config: { sandbox: { backend: { mode: "oci", preference: ["oci"], unavailable: "refuse" }, network: { mode: "denied" } } }
    });
    process.env.ODINN_EXTENSION_HOST_SECRET = "must-not-cross";
    const output = await executor.invoke("oci-e2e", { text: "SEALED_OK" }, {
      runtime: { runId: "extension-oci-e2e", runLedger: differentiated.ledger, auditStore, policy: createDefaultPolicy(), workspaceRoot: root }
    });
    delete process.env.ODINN_EXTENSION_HOST_SECRET;
    assert.deepEqual(output, { echoed: "SEALED_OK", hostSecret: null });
    const run = await auditStore.readRun("extension-oci-e2e");
    const prepared = run.events.find((event: any) => event.type === "sandbox.prepared");
    const dispatched = run.events.find((event: any) => event.type === "sandbox.dispatch-authorized");
    const settled = run.events.find((event: any) => event.type === "sandbox.settled");
    const completed = run.events.find((event: any) => event.type === "task.completed");
    assert.ok(prepared);
    assert.ok(dispatched);
    assert.ok(settled);
    assert.ok(completed);
    const lifecycle = run.events.map((event: any) => event.type).filter((type: string) =>
      ["sandbox.prepared", "sandbox.dispatch-authorized", "sandbox.settled", "task.completed"].includes(type)
    );
    assert.deepEqual(lifecycle, ["sandbox.prepared", "sandbox.dispatch-authorized", "sandbox.settled", "task.completed"]);
    assert.match(prepared.data.sealedBundleDigest, /^[a-f0-9]{64}$/u);
    assert.match(prepared.data.profileDigest, /^[a-f0-9]{64}$/u);
    assert.match(dispatched.data.containerName, /^odinn-/u);
    assert.ok(["docker", "podman"].includes(dispatched.data.backend));
    assert.equal(settled.data.containerName, dispatched.data.containerName);
    assert.equal(settled.data.backend, dispatched.data.backend);
    assert.equal(settled.data.cleanupUncertain, false);
    const inspection = spawnSync(`/usr/bin/${dispatched.data.backend}`, ["container", "inspect", dispatched.data.containerName], { encoding: "utf8", shell: false, timeout: 10_000 });
    assert.notEqual(inspection.status, 0, "the extension sandbox container must be removed");
  } finally {
    delete process.env.ODINN_EXTENSION_HOST_SECRET;
    auditStore.close();
    differentiated.ledger.close();
  }
});
