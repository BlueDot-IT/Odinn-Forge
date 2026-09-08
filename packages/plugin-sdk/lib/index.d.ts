/** Public host-neutral v1 connector contract. Metadata never grants authority. */
export declare const PLUGIN_SDK_VERSION: "1.0";
export declare const DEFAULT_PLUGIN_IMAGE = "node:24.19.0-bookworm@sha256:4196d66a565c6f195728d9952f161f4adfe2ad753052a08b7ec7f1c5a6bda42b";
export type PluginKind = "connector";
export type PluginRuntime = "oci-mcp-stdio";
export type ConnectorTransport = "mcp-jsonrpc-stdio";
export type PluginCapability = "mcp.discover" | "mcp.invoke" | "network.access" | "secret.reference.use";
export type SecretReference = Readonly<{
    name: string;
    purpose: string;
}>;
export type EgressDeclaration = Readonly<{
    protocol: "https";
    hosts: readonly string[];
    port: 443;
}>;
export type PluginService = Readonly<{
    id: string;
    origin: string;
    paths: readonly string[];
    queryKeys: readonly string[];
    credential?: string;
}>;
export type PluginServiceBinding = Readonly<{
    enabled: boolean;
    credentialRef?: `env:${string}`;
}>;
export type PluginServiceBindings = Readonly<Record<string, PluginServiceBinding>>;
export type PluginTool = Readonly<{
    name: string;
    description: string;
    capabilities: readonly PluginCapability[];
    inputSchema: Readonly<Record<string, unknown>>;
    effects: readonly ("read" | "network" | "credential")[];
    requiresApproval: boolean;
    retrySafe: boolean;
}>;
export type PluginManifest = Readonly<{
    schemaVersion: 1;
    sdkVersion: typeof PLUGIN_SDK_VERSION;
    id: string;
    version: string;
    name: string;
    description: string;
    kind: PluginKind;
    runtime: PluginRuntime;
    transport: ConnectorTransport;
    tools: readonly PluginTool[];
    egress: EgressDeclaration;
    secrets: readonly SecretReference[];
    services: readonly PluginService[];
    containerImage: string;
    entrypoint: string;
}>;
export declare function validatePluginId(value: unknown): string;
export declare function validatePluginVersion(value: unknown): string;
export declare function validatePluginImage(value: unknown): string;
/** Forge's bounded MCP schema subset, deliberately not general JSON Schema. */
export declare function validatePluginInputSchema(input: unknown): Readonly<Record<string, unknown>>;
export declare function validatePluginManifest(input: unknown): PluginManifest;
export declare function createManifest(input: Omit<PluginManifest, "schemaVersion" | "sdkVersion">): PluginManifest;
export declare function createConnectorScaffold(id: string, containerImage?: string): Readonly<{
    manifest: PluginManifest;
    files: Readonly<Record<string, string>>;
}>;
