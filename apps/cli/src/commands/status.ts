import type { CliCommandDefinition } from "./types.ts";

export const statusCommand = {
  name: "status",
  usage: "status [--state .odinn]",
  description: "Check configuration and runtime health.",
  execute: async ({ args, context }) => context.readStatus(args)
} satisfies CliCommandDefinition;
