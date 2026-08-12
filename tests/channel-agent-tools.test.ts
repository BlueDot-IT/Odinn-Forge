import assert from "node:assert/strict";
import test from "node:test";

import type { ChannelAgentToolDefinition } from "../packages/channels/src/plugin.ts";
import { createApprovalStore } from "../packages/kernel/src/approvals.ts";
import { registerChannelAgentTools } from "../packages/kernel/src/channel-agent-tools.ts";

const readDefinition = (): ChannelAgentToolDefinition => ({
  description: "Read through a test channel adapter.",
  resourceBinding: () => ({}),
  invoke: async () => ({ ok: true })
});

test("channel tool registration rejects collisions and tools without trusted policy", () => {
  const existing = new Map<string, Record<string, unknown>>([["text.echo", {}]]);
  assert.throws(
    () => registerChannelAgentTools(
      existing,
      new Map([["text.echo", readDefinition()]]),
      createApprovalStore()
    ),
    /conflicts with an existing tool/u
  );

  assert.throws(
    () => registerChannelAgentTools(
      new Map(),
      new Map([["channel.unregistered", readDefinition()]]),
      createApprovalStore()
    ),
    /has no trusted approval policy/u
  );
});

test("trusted policy controls channel approval declarations and compatibility aliases", () => {
  const readRegistry = new Map<string, Record<string, any>>();
  registerChannelAgentTools(
    readRegistry,
    new Map([["discord.readMessages", readDefinition()]]),
    createApprovalStore()
  );
  assert.equal(readRegistry.get("discord.readMessages")?.capability, "discord.read");

  assert.throws(
    () => registerChannelAgentTools(
      new Map(),
      new Map([["discord.sendMessage", readDefinition()]]),
      createApprovalStore()
    ),
    /approval declaration does not match trusted safety policy/u
  );

  assert.throws(
    () => registerChannelAgentTools(
      new Map(),
      new Map([["discord.readMessages", {
        ...readDefinition(),
        approvalBinding: (input: Record<string, unknown>) => ({ input, summary: "untrusted read approval" })
      }]]),
      createApprovalStore()
    ),
    /approval declaration does not match trusted safety policy/u
  );
});

test("malformed adapter approval bindings fail before invocation", async () => {
  let invoked = false;
  const registry = new Map<string, Record<string, any>>();
  registerChannelAgentTools(
    registry,
    new Map([["discord.sendMessage", {
      description: "Malformed test mutation.",
      resourceBinding: () => ({}),
      approvalBinding: () => null as never,
      invoke: async () => {
        invoked = true;
        return { ok: true };
      }
    }]]),
    createApprovalStore()
  );

  await assert.rejects(
    registry.get("discord.sendMessage")?.execute({}, { request: { id: "malformed-binding" } }),
    /returned an invalid approval binding/u
  );
  assert.equal(invoked, false);
});
