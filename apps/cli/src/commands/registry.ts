import { diagnosticsCommand } from "./diagnostics.ts";
import { operatorCommand, tuiCommand } from "./operator.ts";
import { sessionsCommand } from "./sessions.ts";
import { statusCommand } from "./status.ts";
import type { CliCommandDefinition, CliCommandRegistry } from "./types.ts";

export function createCommandRegistry(definitions: readonly CliCommandDefinition[]): CliCommandRegistry {
  const byName = new Map<string, CliCommandDefinition>();
  for (const definition of definitions) {
    for (const name of [definition.name, ...(definition.aliases ?? [])]) {
      if (!name || name !== name.trim()) throw new Error("CLI command names must be non-empty and trimmed");
      if (byName.has(name)) throw new Error(`duplicate CLI command registration: ${name}`);
      byName.set(name, definition);
    }
  }
  const ordered = Object.freeze([...definitions]);
  return Object.freeze({
    resolve: (name: string | undefined, args: readonly string[] = []) => {
      if (!name) return undefined;
      const definition = byName.get(name);
      return definition && (!definition.matches || definition.matches({ name, args: [...args] }))
        ? definition
        : undefined;
    },
    list: () => ordered
  });
}

export const cliReadCommandRegistry = createCommandRegistry([
  statusCommand,
  diagnosticsCommand,
  sessionsCommand,
  operatorCommand,
  tuiCommand
]);
