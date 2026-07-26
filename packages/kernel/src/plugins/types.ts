export interface RuntimePluginContext {
  ledger: any;
  stateDir: string;
  workspaceRoot: string;
  featureFlags: Record<string, boolean>;
}

export interface RuntimePlugin<TService = unknown> {
  id: string;
  displayName: string;
  configKey: string;
  create(context: RuntimePluginContext): TService;
}

export interface LoadedRuntimePlugin<TService = unknown> {
  id: string;
  displayName: string;
  configKey: string;
  enabled: boolean;
  service: TService;
}

export function loadRuntimePlugins(context: RuntimePluginContext, plugins: RuntimePlugin[]) {
  return new Map(plugins.map((plugin) => [plugin.id, {
    id: plugin.id,
    displayName: plugin.displayName,
    configKey: plugin.configKey,
    enabled: context.featureFlags[plugin.id] === true,
    service: plugin.create(context)
  }]));
}
