import type {
  ProviderAuthMode,
  ProviderDefinition,
  ProviderPresetInput,
  ProviderSupportDescriptor,
  ProviderSupportTier,
  ProviderTransport
} from "./types.ts";

const RAW_PROVIDER_PRESETS = {
  openai: {
    defaultAuth: "oauth",
    type: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    apiKeyEnv: "OPENAI_API_KEY",
    models: ["gpt-4.1-mini"],
    oauth: {
      baseUrl: "https://chatgpt.com/backend-api/codex",
      models: ["gpt-5.5", "gpt-5.4-mini"],
      transport: "openai-chatgpt-responses",
      auth: {
        mode: "oauth",
        authorizationUrl: "https://auth.openai.com/oauth/authorize",
        tokenUrl: "https://auth.openai.com/oauth/token",
        clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
        scopes: ["openid", "profile", "email", "offline_access"],
        redirectUri: "http://localhost:1455/auth/callback",
        authorizationParams: {
          id_token_add_organizations: "true",
          codex_cli_simplified_flow: "true",
          originator: "odinn"
        }
      }
    }
  },
  openrouter: {
    defaultAuth: "oauth",
    type: "openai-compatible",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKeyEnv: "OPENROUTER_API_KEY",
    models: ["openrouter/auto"],
    oauth: {
      flow: "openrouter-pkce"
    }
  },
  groq: {
    type: "openai-compatible",
    baseUrl: "https://api.groq.com/openai/v1",
    apiKeyEnv: "GROQ_API_KEY",
    models: ["llama-3.3-70b-versatile"]
  },
  together: {
    type: "openai-compatible",
    baseUrl: "https://api.together.xyz/v1",
    apiKeyEnv: "TOGETHER_API_KEY",
    models: ["meta-llama/Llama-3.3-70B-Instruct-Turbo"]
  },
  mistral: {
    type: "openai-compatible",
    baseUrl: "https://api.mistral.ai/v1",
    apiKeyEnv: "MISTRAL_API_KEY",
    models: ["mistral-large-latest"]
  },
  deepseek: {
    type: "openai-compatible",
    baseUrl: "https://api.deepseek.com",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    models: ["deepseek-v4-flash"]
  },
  xai: {
    type: "openai-compatible",
    baseUrl: "https://api.x.ai/v1",
    apiKeyEnv: "XAI_API_KEY",
    models: ["grok-4.3"]
  },
  moonshot: {
    type: "openai-compatible",
    baseUrl: "https://api.moonshot.ai/v1",
    apiKeyEnv: "MOONSHOT_API_KEY",
    models: ["kimi-k2.6"]
  },
  "moonshot-cn": {
    type: "openai-compatible",
    baseUrl: "https://api.moonshot.cn/v1",
    apiKeyEnv: "MOONSHOT_API_KEY",
    models: ["kimi-k2.6"]
  },
  fireworks: {
    type: "openai-compatible",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    apiKeyEnv: "FIREWORKS_API_KEY",
    models: ["accounts/fireworks/routers/kimi-k2p5-turbo"]
  },
  cerebras: {
    type: "openai-compatible",
    baseUrl: "https://api.cerebras.ai/v1",
    apiKeyEnv: "CEREBRAS_API_KEY",
    models: ["zai-glm-4.7"]
  },
  cohere: {
    type: "openai-compatible",
    baseUrl: "https://api.cohere.ai/compatibility/v1",
    apiKeyEnv: "COHERE_API_KEY",
    models: ["command-a-03-2025"]
  },
  deepinfra: {
    type: "openai-compatible",
    baseUrl: "https://api.deepinfra.com/v1/openai",
    apiKeyEnv: "DEEPINFRA_API_KEY",
    models: ["deepseek-ai/DeepSeek-V4-Flash"]
  },
  nvidia: {
    type: "openai-compatible",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    apiKeyEnv: "NVIDIA_API_KEY",
    models: ["meta/llama-3.3-70b-instruct"]
  },
  zai: {
    type: "openai-compatible",
    baseUrl: "https://api.z.ai/api/paas/v4",
    apiKeyEnv: "ZAI_API_KEY",
    models: ["glm-5.1"]
  },
  "zai-cn": {
    type: "openai-compatible",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    apiKeyEnv: "ZAI_API_KEY",
    models: ["glm-5.1"]
  },
  "zai-coding": {
    type: "openai-compatible",
    baseUrl: "https://api.z.ai/api/coding/paas/v4",
    apiKeyEnv: "ZAI_API_KEY",
    models: ["glm-5.2"]
  },
  "zai-coding-cn": {
    type: "openai-compatible",
    baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
    apiKeyEnv: "ZAI_API_KEY",
    models: ["glm-5.2"]
  },
  qianfan: {
    type: "openai-compatible",
    baseUrl: "https://qianfan.baidubce.com/v2",
    apiKeyEnv: "QIANFAN_API_KEY",
    models: ["deepseek-v3.2"]
  },
  volcengine: {
    type: "openai-compatible",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    apiKeyEnv: "VOLCANO_ENGINE_API_KEY",
    models: ["doubao-seed-1-8-251228"]
  },
  "volcengine-plan": {
    type: "openai-compatible",
    baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
    apiKeyEnv: "VOLCANO_ENGINE_API_KEY",
    models: ["ark-code-latest"]
  },
  xiaomi: {
    type: "openai-compatible",
    baseUrl: "https://api.xiaomimimo.com/v1",
    apiKeyEnv: "XIAOMI_API_KEY",
    models: ["mimo-v2-flash"]
  },
  huggingface: {
    type: "openai-compatible",
    baseUrl: "https://router.huggingface.co/v1",
    apiKeyEnv: "HF_TOKEN",
    models: ["deepseek-ai/DeepSeek-R1"]
  },
  venice: {
    type: "openai-compatible",
    baseUrl: "https://api.venice.ai/api/v1",
    apiKeyEnv: "VENICE_API_KEY",
    models: ["kimi-k2-5"]
  },
  arcee: {
    type: "openai-compatible",
    baseUrl: "https://api.arcee.ai/api/v1",
    apiKeyEnv: "ARCEEAI_API_KEY",
    models: ["trinity-large-thinking"]
  },
  chutes: {
    defaultAuth: "oauth",
    type: "openai-compatible",
    baseUrl: "https://llm.chutes.ai/v1",
    apiKeyEnv: "CHUTES_API_KEY",
    models: ["zai-org/GLM-4.7-TEE"],
    oauth: {
      flow: "chutes-pkce",
      auth: {
        authorizationUrl: "https://api.chutes.ai/idp/authorize",
        tokenUrl: "https://api.chutes.ai/idp/token",
        clientIdEnv: "CHUTES_CLIENT_ID",
        clientSecretEnv: "CHUTES_CLIENT_SECRET",
        scopes: ["openid", "profile", "chutes:invoke"],
        redirectUri: "http://127.0.0.1:1456/oauth-callback"
      }
    }
  },
  featherless: {
    type: "openai-compatible",
    baseUrl: "https://api.featherless.ai/v1",
    apiKeyEnv: "FEATHERLESS_API_KEY",
    models: ["Qwen/Qwen3-32B"]
  },
  gmi: {
    type: "openai-compatible",
    baseUrl: "https://api.gmi-serving.com/v1",
    apiKeyEnv: "GMI_API_KEY",
    models: ["google/gemini-3.1-flash-lite"]
  },
  kilocode: {
    type: "openai-compatible",
    baseUrl: "https://api.kilo.ai/api/gateway",
    apiKeyEnv: "KILOCODE_API_KEY",
    models: ["kilo/auto"]
  },
  longcat: {
    type: "openai-compatible",
    baseUrl: "https://api.longcat.chat/openai",
    apiKeyEnv: "LONGCAT_API_KEY",
    models: ["LongCat-2.0"]
  },
  novita: {
    type: "openai-compatible",
    baseUrl: "https://api.novita.ai/openai/v1",
    apiKeyEnv: "NOVITA_API_KEY",
    models: ["deepseek/deepseek-v3-0324"]
  },
  litellm: {
    type: "openai-compatible",
    baseUrl: "http://127.0.0.1:4000/v1",
    apiKeyEnv: "LITELLM_API_KEY",
    models: ["claude-opus-4-6"]
  },
  vllm: {
    type: "openai-compatible",
    baseUrl: "http://127.0.0.1:8000/v1",
    apiKeyEnv: "VLLM_API_KEY",
    models: ["local-model"]
  },
  sglang: {
    type: "openai-compatible",
    baseUrl: "http://127.0.0.1:30000/v1",
    apiKeyEnv: "SGLANG_API_KEY",
    models: ["Qwen/Qwen3-8B"]
  },
  "github-copilot": {
    type: "openai-compatible",
    baseUrl: "https://api.individual.githubcopilot.com",
    apiKeyEnv: "",
    models: ["gpt-5.5"],
    defaultAuth: "device",
    auth: {
      mode: "device",
      flow: "github-copilot-device"
    }
  },
  "xai-oauth": {
    type: "openai-compatible",
    baseUrl: "https://api.x.ai/v1",
    apiKeyEnv: "",
    models: ["grok-4.3"],
    defaultAuth: "device",
    auth: {
      mode: "device",
      flow: "xai-device",
      clientId: "b1a00492-073a-47ea-816f-4c329264a828"
    }
  },
  antigravity: {
    type: "cli",
    baseUrl: "",
    apiKeyEnv: "",
    models: ["gemini-3-flash", "gemini-3-pro-high"],
    defaultAuth: "cli",
    transport: "cli-antigravity",
    auth: {
      mode: "cli",
      flow: "antigravity-cli",
      commandEnv: "ODINN_ANTIGRAVITY_CLI"
    }
  },
  "google-antigravity": {
    type: "cli",
    baseUrl: "",
    apiKeyEnv: "",
    models: ["gemini-3-flash", "gemini-3-pro-high"],
    defaultAuth: "cli",
    transport: "cli-antigravity",
    auth: {
      mode: "cli",
      flow: "antigravity-cli",
      commandEnv: "ODINN_ANTIGRAVITY_CLI"
    }
  },
  ollama: {
    type: "openai-compatible",
    baseUrl: "http://127.0.0.1:11434/v1",
    apiKeyEnv: "",
    models: []
  },
  lmstudio: {
    type: "openai-compatible",
    baseUrl: "http://127.0.0.1:1234/v1",
    apiKeyEnv: "",
    models: []
  }
} satisfies Record<string, ProviderPresetInput>;

const FIRST_CLASS_PROVIDER_IDS = new Set(["openai", "openrouter", "ollama"]);
const EXPERIMENTAL_PROVIDER_IDS = new Set([
  "chutes",
  "github-copilot",
  "xai-oauth",
  "antigravity",
  "google-antigravity"
]);
const LOCAL_PROVIDER_IDS = new Set(["ollama", "lmstudio", "litellm", "vllm", "sglang"]);

const DISPLAY_NAMES: Record<string, string> = {
  openai: "OpenAI / ChatGPT",
  openrouter: "OpenRouter",
  ollama: "Ollama (local)",
  lmstudio: "LM Studio (local)",
  xai: "xAI",
  "xai-oauth": "xAI OAuth",
  huggingface: "Hugging Face",
  litellm: "LiteLLM",
  vllm: "vLLM",
  sglang: "SGLang",
  "github-copilot": "GitHub Copilot",
  antigravity: "Antigravity CLI",
  "google-antigravity": "Google Antigravity CLI"
};

const DOCUMENTATION_URLS: Record<string, string> = {
  openai: "https://platform.openai.com/docs",
  openrouter: "https://openrouter.ai/docs",
  ollama: "https://docs.ollama.com"
};

const ALLOWED_TRANSPORTS = new Set<ProviderTransport>([
  "openai-chat-completions",
  "openai-responses",
  "openai-chatgpt-responses",
  "cli-antigravity"
]);
const ALLOWED_AUTH_MODES = new Set<ProviderAuthMode>(["api-key", "oauth", "device", "cli"]);

function supportTier(id: string): ProviderSupportTier {
  if (FIRST_CLASS_PROVIDER_IDS.has(id)) return "first-class";
  if (EXPERIMENTAL_PROVIDER_IDS.has(id)) return "experimental";
  return "compatible";
}

function displayName(id: string): string {
  return DISPLAY_NAMES[id]
    ?? id.split(/[-_]/u).map((part) => part ? `${part[0].toUpperCase()}${part.slice(1)}` : part).join(" ");
}

function authModes(preset: ProviderPresetInput): ProviderAuthMode[] {
  if (preset.defaultAuth === "oauth") return ["oauth", "api-key"];
  if (preset.defaultAuth === "device") return ["device"];
  if (preset.defaultAuth === "cli") return ["cli"];
  return ["api-key"];
}

function validateProviderDefinition(key: string, definition: ProviderDefinition): void {
  if (definition.id !== key || !/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/u.test(definition.id)) {
    throw new Error(`invalid provider id: ${key}`);
  }
  if (!definition.displayName.trim()) throw new Error(`provider ${key} requires a display name`);
  if (!definition.authModes.length || definition.authModes.some((mode) => !ALLOWED_AUTH_MODES.has(mode))) {
    throw new Error(`provider ${key} has an invalid authentication mode`);
  }
  const transport = definition.oauth?.transport ?? definition.transport ?? "openai-chat-completions";
  if (!ALLOWED_TRANSPORTS.has(transport)) throw new Error(`provider ${key} has an invalid transport`);
  if (definition.type === "cli") {
    if (definition.baseUrl) throw new Error(`CLI provider ${key} must not define a base URL`);
  } else {
    let endpoint: URL;
    try {
      endpoint = new URL(definition.baseUrl);
    } catch {
      throw new Error(`provider ${key} has an invalid base URL`);
    }
    if (!["http:", "https:"].includes(endpoint.protocol)) {
      throw new Error(`provider ${key} has an unsupported base URL protocol`);
    }
  }
  if (definition.supportTier === "first-class") {
    if (!definition.locallyTested) throw new Error(`first-class provider ${key} must be locally tested`);
    if (!definition.documentationUrl) throw new Error(`first-class provider ${key} requires documentation`);
  }
}

function createProviderRegistry(): Readonly<Record<string, ProviderDefinition>> {
  const definitions = Object.fromEntries(
    Object.entries(RAW_PROVIDER_PRESETS).map(([id, preset]) => {
      const tier = supportTier(id);
      const definition: ProviderDefinition = {
        ...preset,
        id,
        displayName: displayName(id),
        authModes: authModes(preset),
        supportTier: tier,
        locallyTested: tier === "first-class",
        genericCompatibilityMode: tier === "compatible",
        modelAvailability: LOCAL_PROVIDER_IDS.has(id) ? "local" : "provider-dependent",
        ...(DOCUMENTATION_URLS[id] ? { documentationUrl: DOCUMENTATION_URLS[id] } : {})
      };
      validateProviderDefinition(id, definition);
      return [id, Object.freeze(definition)];
    })
  );
  return Object.freeze(definitions);
}

export const PROVIDER_REGISTRY = createProviderRegistry();

// Compatibility export for v0.x consumers. New code should use PROVIDER_REGISTRY.
export const PROVIDER_PRESETS = PROVIDER_REGISTRY;

export const CUSTOM_PROVIDER_SUPPORT: ProviderSupportDescriptor = Object.freeze({
  id: "custom-openai-compatible",
  displayName: "Custom OpenAI-compatible endpoint",
  supportTier: "custom",
  locallyTested: false,
  genericCompatibilityMode: true,
  modelAvailability: "provider-dependent"
});

export function providerSupport(name: string): ProviderSupportDescriptor {
  const definition = PROVIDER_REGISTRY[name];
  if (!definition) {
    return {
      ...CUSTOM_PROVIDER_SUPPORT,
      id: name,
      displayName: displayName(name)
    };
  }
  return {
    id: definition.id,
    displayName: definition.displayName,
    supportTier: definition.supportTier,
    locallyTested: definition.locallyTested,
    genericCompatibilityMode: definition.genericCompatibilityMode,
    modelAvailability: definition.modelAvailability
  };
}

export function listProviderPresets() {
  return Object.values(PROVIDER_REGISTRY).map((definition) => ({
    name: definition.id,
    displayName: definition.displayName,
    supportTier: definition.supportTier,
    locallyTested: definition.locallyTested,
    genericCompatibilityMode: definition.genericCompatibilityMode,
    modelAvailability: definition.modelAvailability,
    authModes: definition.authModes,
    auth: definition.defaultAuth === "oauth"
      ? "oauth or api-key"
      : definition.defaultAuth === "device"
        ? "device oauth"
        : definition.defaultAuth === "cli"
          ? "cli oauth"
          : "api-key",
    baseUrl: definition.baseUrl || definition.oauth?.baseUrl || "",
    apiKeyEnv: definition.apiKeyEnv,
    models: definition.models,
    transport: definition.oauth?.transport ?? definition.transport ?? "openai-chat-completions",
    documentationUrl: definition.documentationUrl
  }));
}
