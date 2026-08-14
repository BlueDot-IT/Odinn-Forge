import assert from "node:assert/strict";
import test from "node:test";
import { pluginIdentityFingerprint, validatePluginManifest } from "../packages/kernel/src/plugin-contracts.ts";

const browserManifest = {
  schemaVersion: 1,
  id: "browser-control",
  version: "0.1.0",
  kind: "host-capability",
  runtime: "host-adapter",
  displayName: "Browser control",
  activation: { enabledByDefault: true },
  tools: [{
    name: "browser.open",
    description: "Open a public page in the isolated Forge browser.",
    capabilities: ["browser.read", "network.access"],
    safety: {
      effects: ["read", "network"],
      reversibility: "pure",
      requiresCapability: true,
      requiresApproval: false,
      retrySafe: true
    },
    idempotency: "not-applicable",
    resourceFields: ["url"],
    modelVisible: true
  }]
} as const;

test("plugin manifests are strict, immutable metadata with host-recognized capabilities", () => {
  const manifest = validatePluginManifest(browserManifest);
  assert.equal(manifest.id, "browser-control");
  assert.deepEqual(manifest.tools[0]?.capabilities, ["browser.read", "network.access"]);
  assert.equal(Object.isFrozen(manifest), true);
  assert.equal(Object.isFrozen(manifest.tools), true);
  assert.equal(Object.isFrozen(manifest.tools[0]?.safety), true);
});

test("plugin identity fingerprints are stable across JSON key order", () => {
  const reordered = {
    tools: browserManifest.tools,
    activation: browserManifest.activation,
    displayName: browserManifest.displayName,
    runtime: browserManifest.runtime,
    kind: browserManifest.kind,
    version: browserManifest.version,
    id: browserManifest.id,
    schemaVersion: browserManifest.schemaVersion
  };
  assert.equal(pluginIdentityFingerprint(browserManifest), pluginIdentityFingerprint(reordered));
  assert.notEqual(pluginIdentityFingerprint(browserManifest), pluginIdentityFingerprint({ ...browserManifest, version: "0.1.1" }));
});

test("plugin manifests fail closed for unknown capabilities and unsupported runtime combinations", () => {
  assert.throws(
    () => validatePluginManifest({ ...browserManifest, tools: [{ ...browserManifest.tools[0], capabilities: ["plugin.unknown"] }] }),
    /unknown capability identifier/u
  );
  assert.throws(
    () => validatePluginManifest({ ...browserManifest, kind: "mcp", runtime: "host-adapter" }),
    /not valid for mcp/u
  );
});

test("plugin manifests reject executable skills and duplicate tools", () => {
  assert.throws(
    () => validatePluginManifest({ ...browserManifest, kind: "skill", runtime: "reference" }),
    /skill plugins cannot declare executable tools/u
  );
  assert.throws(
    () => validatePluginManifest({ ...browserManifest, tools: [browserManifest.tools[0], browserManifest.tools[0]] }),
    /must not contain duplicate names/u
  );
});
