export type ProviderAuthMode = "api-key" | "oauth" | "device" | "cli";
export type ProviderSupportTier = "first-class" | "compatible" | "experimental";
export type ProviderTransport =
  | "openai-chat-completions"
  | "openai-responses"
  | "openai-chatgpt-responses"
  | "cli-antigravity";

export type ProviderAuthorization = {
  mode?: ProviderAuthMode;
  flow?: string;
  authorizationUrl?: string;
  tokenUrl?: string;
  clientId?: string;
  clientIdEnv?: string;
  clientSecretEnv?: string;
  scopes?: string[];
  redirectUri?: string;
  commandEnv?: string;
  authorizationParams?: Record<string, string>;
};

export type ProviderAuthVariant = {
  baseUrl?: string;
  models?: string[];
  transport?: ProviderTransport;
  flow?: string;
  auth?: ProviderAuthorization;
};

export type ProviderPresetInput = {
  defaultAuth?: ProviderAuthMode;
  type: "openai-compatible" | "cli";
  baseUrl: string;
  apiKeyEnv: string;
  models: string[];
  transport?: ProviderTransport;
  auth?: ProviderAuthorization;
  oauth?: ProviderAuthVariant;
};

export type ProviderDefinition = ProviderPresetInput & {
  id: string;
  displayName: string;
  authModes: ProviderAuthMode[];
  supportTier: ProviderSupportTier;
  locallyTested: boolean;
  genericCompatibilityMode: boolean;
  modelAvailability: "local" | "provider-dependent";
  documentationUrl?: string;
};

export type ProviderSupportDescriptor = {
  id: string;
  displayName: string;
  supportTier: ProviderSupportTier | "custom";
  locallyTested: boolean;
  genericCompatibilityMode: boolean;
  modelAvailability: "local" | "provider-dependent";
};
