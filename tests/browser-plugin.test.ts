import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import test from "node:test";

import {
  BROWSER_PLUGIN_MANIFEST,
  browserHostCapabilityPlugin,
  createApprovalStore,
  createBuiltInRegistry,
  materializeHostCapabilityPlugin,
  toolSafetyDescriptor
} from "../packages/kernel/src/index.ts";
import { prepareBrowserProfileDirectory } from "../packages/kernel/src/browser.ts";
import { capabilitiesForTool } from "../packages/policy/src/index.ts";

const browserContext = (stateDir: string) => ({
  stateDir,
  approvalStore: createApprovalStore()
});

test("browser profiles remain owner-private and outside governed Odinn state", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-browser-profile-contract-"));
  try {
    const stateDir = join(root, "state");
    await mkdir(stateDir);
    const profileDir = await prepareBrowserProfileDirectory(stateDir);
    const profileRelativeToState = relative(stateDir, profileDir);
    assert.ok(profileRelativeToState === ".." || profileRelativeToState.startsWith(`..${sep}`));
    assert.equal(dirname(dirname(profileDir)), await realpath(root));
    assert.match(basename(dirname(profileDir)), /^\.odinn-browser-profiles-/u);
    assert.equal((await lstat(profileDir)).mode & 0o077, 0);
    await rm(profileDir, { recursive: true });
    await symlink(root, profileDir);
    await assert.rejects(() => prepareBrowserProfileDirectory(stateDir), /physical directory/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("browser host capability materializes exactly its declared tools", () => {
  const tools = materializeHostCapabilityPlugin(browserHostCapabilityPlugin, browserContext("/tmp/odinn-browser-plugin-test"));
  assert.deepEqual([...tools.keys()], BROWSER_PLUGIN_MANIFEST.tools.map((tool) => tool.name));
  assert.equal(typeof tools.get("browser.open")?.execute, "function");
  assert.equal(tools.get("browser.click")?.capabilityApprovalContinuation, "browser-policy");
  assert.equal(BROWSER_PLUGIN_MANIFEST.activation.enabledByDefault, true);
});

test("browser manifest authority is exactly the trusted policy authority", () => {
  for (const tool of BROWSER_PLUGIN_MANIFEST.tools) {
    assert.deepEqual(tool.capabilities, capabilitiesForTool(tool.name), tool.name);
    const trustedDescriptor = toolSafetyDescriptor(tool.name, {});
    const trustedSafety = {
      effects: trustedDescriptor.effects,
      reversibility: trustedDescriptor.reversibility,
      requiresCapability: trustedDescriptor.requiresCapability,
      requiresApproval: trustedDescriptor.requiresApproval,
      retrySafe: trustedDescriptor.retrySafe
    };
    assert.deepEqual(tool.safety, trustedSafety, tool.name);
  }
});

test("host capability materialization rejects manifest authority drift", () => {
  const drifted = {
    ...browserHostCapabilityPlugin,
    manifest: {
      ...BROWSER_PLUGIN_MANIFEST,
      tools: BROWSER_PLUGIN_MANIFEST.tools.map((tool) => tool.name === "browser.open"
        ? { ...tool, capabilities: ["browser.read"] }
        : tool)
    }
  };
  assert.throws(
    () => materializeHostCapabilityPlugin(drifted, browserContext("/tmp/odinn-browser-plugin-test")),
    /capability declaration does not match trusted policy/u
  );
});

test("host capability materialization rejects undeclared runtime resource authority", () => {
  const tools = browserHostCapabilityPlugin.createTools(browserContext("/tmp/odinn-browser-plugin-test"));
  const original = tools.get("browser.open");
  assert.ok(original);
  const driftedTools = new Map(tools);
  driftedTools.set("browser.open", {
    ...original,
    resourceForInput: () => ({ url: "https://example.test", unauthorizedCapability: "network.admin" })
  });
  const drifted = {
    ...browserHostCapabilityPlugin,
    createTools: () => driftedTools
  };
  assert.throws(
    () => materializeHostCapabilityPlugin(drifted, browserContext("/tmp/odinn-browser-plugin-test"))
      .get("browser.open")?.resourceForInput?.({ url: "https://example.test" }),
    /plugin browser-control resource binding returned an undeclared field: browser\.open\.unauthorizedCapability/u
  );
});

test("browser tools are composed through the host plugin seam and remain in the kernel registry", async () => {
  const root = await mkdtemp(join(tmpdir(), "odinn-browser-plugin-"));
  const registry = createBuiltInRegistry({ workspaceRoot: root, stateDir: join(root, ".odinn") });
  try {
    assert.deepEqual(
      [...registry.keys()].filter((name) => name.startsWith("browser.")).sort(),
      BROWSER_PLUGIN_MANIFEST.tools.map((tool) => tool.name).sort()
    );
    for (const tool of BROWSER_PLUGIN_MANIFEST.tools) {
      assert.equal(typeof registry.get(tool.name)?.execute, "function", tool.name);
      assert.equal(registry.get(tool.name)?.capabilities?.length > 0, true, tool.name);
    }
    assert.equal(registry.get("browser.open")?.inputSchema.properties.url.type, "string");
    assert.equal(registry.get("browser.recovery.resolve")?.inputSchema, undefined);
    assert.equal(registry.get("browser.recovery.resolve")?.modelVisible, false);
  } finally {
    registry.close();
    await rm(root, { recursive: true, force: true });
  }
});
