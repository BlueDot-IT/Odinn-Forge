export type CliReadCommandContext = {
  readStatus(args: string[]): Promise<void>;
  readDiagnostics(args: string[]): Promise<void>;
  readOperator(args: string[]): Promise<void>;
  runTui(args: string[]): Promise<void>;
  runSessionList(args: string[]): Promise<void>;
};

export type CliReadCommandOperations = {
  printJson(value: unknown): Promise<void>;
  status(args: string[]): Promise<unknown>;
  doctor(args: string[]): Promise<unknown>;
  operatorSnapshot(args: string[]): Promise<void>;
  tui(args: string[]): Promise<void>;
  session(args: string[]): Promise<void>;
};

export function createCliReadCommandContext(operations: CliReadCommandOperations): CliReadCommandContext {
  return {
    readStatus: async (args) => operations.printJson(await operations.status(args)),
    readDiagnostics: async (args) => operations.printJson(await operations.doctor(args)),
    readOperator: async (args) => operations.operatorSnapshot(args),
    runTui: async (args) => operations.tui(args),
    runSessionList: async (args) => operations.session(args)
  };
}
