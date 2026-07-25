# AI provider support

Odinn can connect to several AI services and local model servers. The support
label tells you which part Odinn maintains and tests. It does not guarantee
that an outside service, account, or individual model will always be available.

Run `odinn config provider catalog` to see the same labels in machine-readable
form.

## First-class support

These connections are covered by Odinn's v1 provider contract:

| Provider | Sign-in options | What Odinn tests |
| --- | --- | --- |
| OpenAI / ChatGPT | Browser sign-in or API key | Setup, authentication path, requests, response parsing, safe error reporting, retries, model selection, and diagnostics |
| OpenRouter | Browser sign-in or API key | Setup, authentication path, requests, response parsing, safe error reporting, retries, model selection, and diagnostics |
| Ollama | Local server | Setup, local connection, requests, response parsing, safe error reporting, retries, model selection, and diagnostics |

Odinn tests these connection paths locally and in CI. Live service availability,
account access, quotas, prices, and model names are still controlled by the
provider. Ollama model availability depends on what is installed locally.

## Compatibility presets

These presets use Odinn's shared OpenAI-compatible connection. Odinn maintains
their endpoint and setup metadata, but does not promise continuous live-service
testing:

Arcee, Cerebras, Cohere, DeepInfra, DeepSeek, Featherless, Fireworks, GMI,
Groq, Hugging Face, KiloCode, LiteLLM, LM Studio, LongCat, Mistral, Moonshot,
Moonshot China, NVIDIA, Novita, Qianfan, SGLang, Together, Venice, vLLM,
Volcengine, Volcengine Plan, xAI, Xiaomi, Z.ai, Z.ai China, Z.ai Coding, and
Z.ai Coding China.

A compatibility preset can stop working when its provider changes an endpoint,
authentication rule, or response format. That is different from a regression
in the stable shared adapter.

## Experimental provider paths

Chutes browser sign-in, GitHub Copilot device sign-in, xAI device sign-in, and
the Antigravity CLI presets ship as experimental provider paths. They may
change outside the normal v1 compatibility promise.

## Custom endpoints

You can add a custom OpenAI-compatible endpoint with an explicit URL, model,
and optional API-key environment variable. The generic adapter is stable, but
Odinn cannot guarantee that an arbitrary server implements the protocol
correctly. Custom endpoints are labeled **Custom compatibility mode** in
diagnostics and the console.

Provider secrets remain outside normal configuration output. API keys should
come from environment variables, and OAuth tokens remain in the protected
state directory.
