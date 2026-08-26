import { spawnSync } from "node:child_process";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const MODEL = "gpt-5.6-luna";
const MINIMUM_VALIDITY_MS = 4 * 60 * 60 * 1_000;

export type OAuthCredential = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
};

function required(value: unknown, label: string): string {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function normalizeExpiry(value: unknown): number | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return parsed < 1e12 ? parsed * 1_000 : parsed;
}

function jwtExpiry(accessToken: string): number | undefined {
  const payload = accessToken.split(".")[1];
  if (!payload) return undefined;
  try {
    return normalizeExpiry(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")).exp);
  } catch {
    return undefined;
  }
}

export function parseOAuthCredential(value: string | Record<string, unknown>): OAuthCredential {
  const source = typeof value === "string" ? JSON.parse(value) : value;
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new Error("OAuth credential must be an object");
  }
  const accessToken = String(source.accessToken ?? source.access_token ?? "").trim();
  const refreshToken = String(source.refreshToken ?? source.refresh_token ?? "").trim();
  const expiresAt = normalizeExpiry(source.expiresAt ?? source.expires_at) ?? jwtExpiry(accessToken);
  if (!accessToken || !refreshToken || !expiresAt) {
    throw new Error("OAuth credential must contain access, refresh, and expiry data");
  }
  return { accessToken, refreshToken, expiresAt };
}

export function assertCredentialFresh(
  credential: OAuthCredential,
  now = Date.now(),
  minimumValidityMs = MINIMUM_VALIDITY_MS
): void {
  if (credential.expiresAt <= now + minimumValidityMs) {
    throw new Error("GitHub Actions OAuth secret is not fresh enough for the complete benchmark matrix; wait for the local sync job and retry");
  }
}

async function secureJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

function childEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  delete environment.ODINN_OPENAI_OAUTH_JSON;
  delete environment.GITHUB_TOKEN;
  delete environment.GH_TOKEN;
  return environment;
}

function checked(command: string, args: string[], cwd?: string): void {
  const result = spawnSync(command, args, {
    cwd,
    env: childEnvironment(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.status !== 0) {
    const diagnostic = `${result.stderr || result.stdout || "command failed"}`.trim().slice(0, 2_000);
    throw new Error(`${command} failed: ${diagnostic}`);
  }
}

function accountId(accessToken: string): string {
  const payload = accessToken.split(".")[1];
  if (!payload) return "";
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return String(claims?.["https://api.openai.com/auth"]?.chatgpt_account_id ?? "");
  } catch {
    return "";
  }
}

async function prepare(args: string[]): Promise<void> {
  const option = (name: string): string => {
    const index = args.indexOf(name);
    return index >= 0 ? String(args[index + 1] ?? "") : "";
  };
  const stateRoot = resolve(required(option("--state-root"), "--state-root"));
  const harness = resolve(required(option("--harness"), "--harness"));
  const odinn = resolve(required(option("--odinn"), "--odinn"));
  const openclaw = resolve(required(option("--openclaw"), "--openclaw"));
  const hermes = resolve(required(option("--hermes"), "--hermes"));
  const configOutput = resolve(required(option("--config-output"), "--config-output"));
  const openclawAdapter = new URL("./openclaw-benchmark-adapter.ts", import.meta.url).pathname;
  const credential = parseOAuthCredential(required(
    process.env.ODINN_OPENAI_OAUTH_JSON,
    "ODINN_OPENAI_OAUTH_JSON"
  ));
  assertCredentialFresh(credential);

  const odinnState = join(stateRoot, "odinn");
  const openclawState = join(stateRoot, "openclaw");
  const hermesState = join(stateRoot, "hermes");
  await rm(stateRoot, { recursive: true, force: true });
  await Promise.all([
    mkdir(join(openclawState, "agents", "main", "agent"), { recursive: true, mode: 0o700 }),
    mkdir(hermesState, { recursive: true, mode: 0o700 }),
    mkdir(odinnState, { recursive: true, mode: 0o700 })
  ]);

  const chatGptAccountId = accountId(credential.accessToken);
  const openclawAuth = join(openclawState, "agents", "main", "agent", "auth-profiles.json");
  await secureJson(openclawAuth, {
    version: 1,
    profiles: {
      "openai:benchmark": {
        type: "oauth",
        provider: "openai",
        access: credential.accessToken,
        refresh: credential.refreshToken,
        expires: credential.expiresAt,
        ...(chatGptAccountId ? { accountId: chatGptAccountId } : {})
      }
    }
  });
  await secureJson(join(openclawState, "openclaw.json"), {
    auth: {
      profiles: { "openai:benchmark": { provider: "openai", mode: "oauth" } },
      order: { openai: ["openai:benchmark"] }
    },
    agents: {
      defaults: {
        model: { primary: "openai/gpt-5.6-luna", fallbacks: [] },
        workspace: "${AGENT_BENCH_WORKSPACE}",
        skills: []
      },
      list: [{
        id: "main",
        default: true,
        name: "Benchmark Agent",
        workspace: "${AGENT_BENCH_WORKSPACE}",
        model: "openai/gpt-5.6-luna",
        tools: { allow: ["read", "write", "edit", "exec"] }
      }]
    },
    tools: {
      allow: ["read", "write", "edit", "exec"],
      exec: { host: "gateway", security: "full", ask: "off" }
    }
  });
  await secureJson(join(hermesState, "auth.json"), {
    version: 1,
    active_provider: "openai-codex",
    providers: {
      "openai-codex": {
        auth_mode: "chatgpt",
        last_refresh: new Date().toISOString(),
        tokens: {
          access_token: credential.accessToken,
          refresh_token: credential.refreshToken,
          expires_at: credential.expiresAt,
          ...(chatGptAccountId ? { account_id: chatGptAccountId } : {})
        }
      }
    }
  });
  await writeFile(
    join(hermesState, "config.yaml"),
    `model:\n  provider: openai-codex\n  default: ${MODEL}\n`,
    { mode: 0o600 }
  );

  checked(odinn, [
    "auth", "import", "openclaw",
    "--source", openclawAuth,
    "--state", odinnState,
    "--profile", "benchmark",
    "--model", MODEL
  ]);
  checked("pnpm", ["prepare:odinn-state", "--", "--state", odinnState], harness);

  const metadata = {
    provider: "openai-oauth",
    model: MODEL,
    reasoning: "model-default",
    deployment: "cloud",
    sampling: "runtime-default",
    toolPolicy: "bounded-filesystem-and-process"
  };
  const preflight = {
    prompt: "Reply with exactly AGENT_BENCH_PREFLIGHT_OK and do not call tools.",
    expected: "AGENT_BENCH_PREFLIGHT_OK",
    timeoutMs: 300000,
    maxTurns: 2
  };
  await secureJson(configOutput, {
    schemaVersion: 1,
    executionPolicy: "trusted-local",
    modelPolicy: "cloud-only",
    adapters: [
      {
        id: "odinn-forge",
        metadata,
        capabilities: ["text.generate", "workspace.read", "workspace.write", "process.exec"],
        preflight,
        command: odinn,
        args: ["run", "--tool", "agent.run", "--input-file", "{inputFile}", "--durable-process", "--confirm-process", "--state", "{state}"],
        env: { HOME: "{state}", INIT_CWD: "{workspace}" },
        stateFixture: odinnState,
        output: {
          format: "json",
          path: "output.content",
          metrics: {
            totalTokens: "output.usage.total_tokens",
            provider: "output.provider",
            model: "output.model"
          }
        },
        version: { command: odinn, args: ["--version"] }
      },
      {
        id: "openclaw",
        metadata,
        capabilities: ["text.generate", "workspace.read", "workspace.write", "process.exec"],
        preflight,
        command: process.execPath,
        args: [openclawAdapter, "--openclaw", openclaw, "--trial-id", "{trialId}", "--prompt-file", "{promptFile}"],
        env: {
          OPENCLAW_STATE_DIR: "{state}",
          AGENT_BENCH_WORKSPACE: "{workspace}",
          HOME: "{state}"
        },
        stateFixture: openclawState,
        output: {
          format: "json",
          path: "payloads.0.text",
          metrics: {
            runtimeDurationMs: "meta.durationMs",
            provider: "meta.agentMeta.provider",
            model: "meta.agentMeta.model"
          }
        },
        version: { command: openclaw, args: ["--version"] }
      },
      {
        id: "hermes-agent",
        metadata,
        capabilities: ["text.generate", "workspace.read", "workspace.write", "process.exec"],
        preflight,
        command: hermes,
        args: ["--oneshot", "{prompt}", "--model", MODEL, "--provider", "openai-codex", "--toolsets", "terminal,file", "--ignore-rules"],
        env: {
          HERMES_HOME: "{state}",
          HOME: "{state}",
          TERMINAL_CWD: "{workspace}"
        },
        stateFixture: hermesState,
        output: { format: "text" },
        version: { command: hermes, args: ["--version"] }
      }
    ]
  });
}

async function main(args = process.argv.slice(2)): Promise<void> {
  if (args[0] !== "prepare") {
    throw new Error("usage: weekly-benchmark-state.ts prepare [options]");
  }
  await prepare(args.slice(1));
  process.stdout.write("Prepared isolated weekly benchmark state from the existing repository OAuth secret.\n");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
