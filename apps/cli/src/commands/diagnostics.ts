import type { CliCommandDefinition } from "./types.ts";

export const diagnosticsCommand = {
  name: "doctor",
  usage: "doctor [--state .odinn]",
  description: "Diagnose the current setup.",
  execute: async ({ args, context }) => context.readDiagnostics(args)
} satisfies CliCommandDefinition;
