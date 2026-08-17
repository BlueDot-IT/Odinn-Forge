import type { CliCommandDefinition } from "./types.ts";

export const sessionsCommand = {
  name: "session",
  aliases: ["sessions"],
  usage: "session list|sessions [--limit 20] [--state .odinn]",
  description: "List session records.",
  matches: ({ args }) => args.length === 0 || args[0]?.startsWith("-") === true || args[0] === "list",
  execute: async ({ args, context }) => {
    const forwarded = args.length === 0 || args[0]?.startsWith("-") ? ["list", ...args] : args;
    await context.runSessionList(forwarded);
  }
} satisfies CliCommandDefinition;
