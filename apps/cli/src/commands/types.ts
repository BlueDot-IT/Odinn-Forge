import type { CliReadCommandContext } from "../application-context.ts";

export type CliCommandInvocation = {
  name: string;
  args: string[];
  context: CliReadCommandContext;
};

export type CliCommandDefinition = {
  name: string;
  aliases?: readonly string[];
  usage: string;
  description: string;
  matches?(invocation: Omit<CliCommandInvocation, "context">): boolean;
  execute(invocation: CliCommandInvocation): Promise<void>;
};

export type CliCommandRegistry = {
  resolve(name: string | undefined, args?: readonly string[]): CliCommandDefinition | undefined;
  list(): readonly CliCommandDefinition[];
};
