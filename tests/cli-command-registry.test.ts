import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createCliReadCommandContext } from "../apps/cli/src/application-context.ts";
import { cliReadCommandRegistry, createCommandRegistry } from "../apps/cli/src/commands/registry.ts";
import type { CliCommandDefinition } from "../apps/cli/src/commands/types.ts";

test("CLI command registry rejects duplicate names and aliases", () => {
  const execute = async () => {};
  const definitions: CliCommandDefinition[] = [
    { name: "one", aliases: ["shared"], usage: "one", description: "one", execute },
    { name: "two", aliases: ["shared"], usage: "two", description: "two", execute }
  ];
  assert.throws(() => createCommandRegistry(definitions), /duplicate CLI command registration: shared/u);
});

test("CLI read command registry resolves aliases and preserves help order", () => {
  assert.equal(cliReadCommandRegistry.resolve("sessions", ["--limit", "5"])?.name, "session");
  assert.equal(cliReadCommandRegistry.resolve("session", ["list"])?.name, "session");
  assert.equal(cliReadCommandRegistry.resolve("session", ["create"]), undefined);
  assert.equal(cliReadCommandRegistry.resolve("sessions", ["create"]), undefined);
  assert.equal(cliReadCommandRegistry.resolve("inspect")?.name, "operator");
  assert.equal(cliReadCommandRegistry.resolve("operator", ["action", "verify-audit"]), undefined);
  assert.equal(cliReadCommandRegistry.resolve("unknown"), undefined);
  assert.deepEqual(cliReadCommandRegistry.list().map((entry) => entry.name), [
    "status",
    "doctor",
    "session",
    "operator",
    "tui"
  ]);
});

test("CLI read commands forward exact arguments through a bounded context", async () => {
  const events: unknown[] = [];
  const context = createCliReadCommandContext({
    printJson: async (value) => { events.push(["json", value]); },
    status: async (args) => { events.push(["status", [...args]]); return { kind: "status" }; },
    doctor: async (args) => { events.push(["doctor", [...args]]); return { kind: "doctor" }; },
    operatorSnapshot: async (args) => { events.push(["operator", [...args]]); },
    tui: async (args) => { events.push(["tui", [...args]]); },
    session: async (args) => { events.push(["session", [...args]]); }
  });

  const invoke = async (name: string, args: string[]) => {
    const definition = cliReadCommandRegistry.resolve(name, args);
    assert.ok(definition);
    await definition.execute({ name, args, context });
  };

  await invoke("status", ["--state", "state"]);
  await invoke("doctor", ["--state", "state"]);
  await invoke("sessions", ["--limit", "5"]);
  await invoke("session", ["list", "--limit", "9"]);
  await invoke("inspect", ["--text"]);
  await invoke("operator", ["snapshot", "--page", "2"]);
  await invoke("tui", ["--watch"]);

  assert.deepEqual(events, [
    ["status", ["--state", "state"]],
    ["json", { kind: "status" }],
    ["doctor", ["--state", "state"]],
    ["json", { kind: "doctor" }],
    ["session", ["list", "--limit", "5"]],
    ["session", ["list", "--limit", "9"]],
    ["operator", ["snapshot", "--text"]],
    ["operator", ["snapshot", "--page", "2"]],
    ["tui", ["--watch"]]
  ]);
});

test("legacy CLI dispatcher no longer owns registered read commands", async () => {
  const source = await readFile(new URL("../apps/cli/src/cli.ts", import.meta.url), "utf8");
  const mainStart = source.indexOf("async function main()");
  const mainEnd = source.indexOf("function quickUsage", mainStart);
  assert.ok(mainStart >= 0 && mainEnd > mainStart);
  const mainDispatch = source.slice(mainStart, mainEnd);
  for (const command of ["status", "doctor", "inspect", "tui"]) {
    assert.doesNotMatch(mainDispatch, new RegExp(`case "${command}":`, "u"));
  }
  assert.match(mainDispatch, /cliReadCommandRegistry\.resolve\(command, args\)/u);
  assert.match(mainDispatch, /case "operator":/u);
  assert.match(mainDispatch, /case "session":/u);
  assert.match(mainDispatch, /case "sessions":/u);
});
