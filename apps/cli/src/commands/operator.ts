import type { CliCommandDefinition } from "./types.ts";

export const operatorCommand = {
  name: "operator",
  aliases: ["inspect"],
  usage: "operator snapshot [--page <n>] [--state .odinn]",
  description: "Inspect the shared operator control plane.",
  matches: ({ name, args }) => {
    if (name === "inspect") return true;
    const subcommand = args[0];
    return subcommand === undefined || subcommand.startsWith("-") || subcommand === "snapshot" || subcommand === "show";
  },
  execute: async ({ name, args, context }) => {
    await context.readOperator(name === "inspect" ? ["snapshot", ...args] : args);
  }
} satisfies CliCommandDefinition;

export const tuiCommand = {
  name: "tui",
  usage: "tui [--state .odinn] [--watch]",
  description: "Render the operator snapshot in the terminal.",
  execute: async ({ args, context }) => context.runTui(args)
} satisfies CliCommandDefinition;
