# Ódinn Forge

![Ódinn Forge — your AI assistant, on your computer](docs/odinn-header.png)

> **Your AI assistant, on your computer, under your control.**

Ódinn Forge is an AI assistant that runs on a computer you control. It can
remember useful context, research the web, use approved tools, and help you
carry work across multiple conversations.

It is built for people who want more than a chatbot, but do not want an AI
quietly clicking buttons, changing accounts, or hiding what it did.

**Ódinn Forge is currently beta software.** It works on Linux, macOS, and
Windows, but installation still requires Node.js and a few terminal commands.

## What can I use it for?

### Everyday work

- Research a topic and turn the results into a useful summary.
- Keep separate conversations, saved details, and goals for different projects.
- Remember preferences and project context you choose to save.
- Draft plans, documents, checklists, and communications.
- Use the web without mixing its browser activity into your personal browser
  profile.
- Review a clear history of tool use and important decisions.

### Small business owners and independent professionals

- Research competitors, suppliers, products, or market changes.
- Keep client and internal projects separated inside one workspace.
- Preserve useful business context between work sessions.
- Schedule repeatable tool-based tasks.
- Choose the AI service that fits your budget and privacy needs.
- Keep an activity trail so you can see what ran, when it ran, and whether it
  succeeded.

Ódinn is not a finished industry-specific business suite. It is a general
assistant you can connect to the models and tools that make sense for your
work.

## Why use Ódinn instead of a regular chatbot?

### Your work stays organized

Ódinn groups conversations, goals, memories, and activity by project. You can
return later without rebuilding all the context from scratch.

### You choose the AI

Use OpenAI / ChatGPT, another supported cloud provider, or a local model through
Ollama and other OpenAI-compatible servers. You are not locked into one model
company.

### Important actions are visible

Reading a public webpage is different from clicking **Buy**, sending a form, or
changing an account. Ódinn treats those actions differently and asks for
approval before browser actions that can change something outside your
computer.

### Memory is inspectable

Ódinn can suggest useful details to remember, but you decide what to keep. You
can review, edit, scope, or forget saved memories instead of trusting a hidden
profile you cannot inspect.

### There is a record of what happened

Tool runs, approvals, and important system events are recorded locally. This
makes it easier to understand failures, review past work, and verify that the
assistant followed the expected path.

## Quick start

### What you need

- Linux, macOS, or Windows
- [Node.js 24 or newer](https://nodejs.org/)
- Corepack, which is included with Node.js 24
- An account with a supported AI provider, or a local AI model through Ollama

### Install a release

Download the latest package from
[GitHub Releases](https://github.com/jason-allen-oneal/Odinn/releases), then
follow the platform instructions in the [user guide](docs/user-guide.md).

After installation, run:

```bash
odinn onboard
```

Setup will help you:

1. Choose an AI provider and model.
2. Sign in or connect a local model.
3. Review what the assistant is allowed to do.
4. Test a real AI response before saving the setup.
5. Open the local console in your browser.

To open Ódinn again later:

```bash
odinn start
```

The console normally opens at
[http://127.0.0.1:18790/](http://127.0.0.1:18790/). That address points to your
own computer, not a public website.

Already use OpenClaw or Hermes? Setup can detect compatible installations and
offer to copy supported sign-in details or state. It does not change the
original installation.

### Run from source

If you are a developer or want to try the current repository checkout:

```bash
corepack enable
pnpm install
pnpm check
pnpm odinn onboard
```

See [Getting started](docs/getting-started.md) for local-model setup, scripted
installation, headless systems, and troubleshooting.

## Privacy in plain language

Ódinn has no built-in product telemetry. Its settings, memories, conversations,
browser profile, and activity records stay in its local state folder by
default.

Local-first does **not** mean nothing ever leaves your computer:

- If you use a cloud AI provider, that provider receives the prompts and
  context needed to answer you.
- If Ódinn visits a website, that website receives normal web traffic.
- If you enable third-party extensions or tools, they may have their own data
  practices.
- A local model can keep AI requests on your machine, but web activity still
  reaches the websites you ask Ódinn to visit.

Choose providers and tools that are appropriate for the information you handle.
Do not give any AI system secrets or sensitive client data unless you understand
where that data will go.

## Safety and control

Ódinn is designed to make consequential choices explicit:

- It uses a separate browser profile instead of silently taking cookies from
  your everyday browser.
- Browser clicks, typing, and keypresses require approval by default.
- New agent, skill, and extension packages start disabled.
- Setup changes are reviewed, tested, and backed up before replacing a working
  configuration.
- Built-in automatic improvements are limited to reversible reliability
  settings. They cannot rewrite the application, disable safeguards, change
  credentials, or grant themselves new permissions.

You can weaken some of these controls, but Ódinn makes that an explicit choice.
Read [SECURITY.md](SECURITY.md) before enabling remote access, relaxing
approvals, allowing private-network access, or installing third-party code.

## Honest limits

- Ódinn is beta software. Keep backups and review important output.
- It is not a safety-critical system and should not make medical, legal,
  financial, or other high-stakes decisions for you.
- Its worker processes help contain crashes; they are not a security sandbox
  for hostile code.
- It cannot guarantee that an action on an outside website can be undone.
- AI responses can be wrong, and cloud services can be unavailable, rate
  limited, or changed by their providers.
- The normal local console is for one person on one computer. Do not expose it
  directly to the public internet.
- Multi-user hosting is available for experienced operators, but people who do
  not trust one another should use separate operating-system accounts,
  containers, or machines.

The [surface matrix](docs/surface-matrix.md) separates tested behavior,
experimental features, provider-dependent behavior, and unsupported uses.

## Advanced features

Ódinn includes optional labs for people who want deeper control and
inspection. These features are disabled until you turn them on individually.

- **Proof** checks whether a run met specific acceptance rules.
- **Sentinel** checks commands, file locations, and approval requirements
  before an operation.
- **Capability Tokens** give one narrowly defined permission to one run.
- **Rewind** saves selected local files and previews a restore before applying
  it.
- **Capsules** export a redacted, verifiable bundle of a run.
- **Counterfactual** compares work in separate copies of a workspace.
- **Darwin** compares models using recorded reliability, speed, cost, policy,
  and verification results.

These tools improve visibility and recovery for local work. They do not make
outside actions perfectly reversible, and copied workspaces are not security
sandboxes.

Use the **Experimental Lab** in the console or read the notes under
[docs/features](docs/features/) before enabling a lab.

## Useful commands

```bash
odinn status          # Check the current setup
odinn onboard         # Set up, repair, or change the AI connection
odinn start           # Open the local console
odinn sessions        # List saved conversations
odinn runs            # Show recent tool runs
odinn audit verify    # Check the local activity record
odinn doctor          # Create a safe diagnostic summary
```

## Documentation

- [User guide](docs/user-guide.md) — installation, privacy, and bug reports
- [Getting started](docs/getting-started.md) — setup and troubleshooting
- [Operator console](docs/operator-console.md) — projects, tasks, memory, and
  scheduled jobs
- [Security guide](SECURITY.md) — safe operation and vulnerability reporting
- [Capability boundaries](docs/surface-matrix.md) — what is tested,
  experimental, provider-dependent, or unsupported

## For developers and contributors

Ódinn Forge is an original, clean-room implementation. It does not copy
OpenClaw, Hermes, OpenViking, or another agent framework.

[![CI](https://github.com/jason-allen-oneal/Odinn/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/jason-allen-oneal/Odinn/actions/workflows/ci.yml)
[![Security](https://github.com/jason-allen-oneal/Odinn/actions/workflows/security.yml/badge.svg?branch=main)](https://github.com/jason-allen-oneal/Odinn/actions/workflows/security.yml)
[![Package Integrity](https://github.com/jason-allen-oneal/Odinn/actions/workflows/package-integrity.yml/badge.svg?branch=main)](https://github.com/jason-allen-oneal/Odinn/actions/workflows/package-integrity.yml)
[![Workflow Lint](https://github.com/jason-allen-oneal/Odinn/actions/workflows/workflow-lint.yml/badge.svg?branch=main)](https://github.com/jason-allen-oneal/Odinn/actions/workflows/workflow-lint.yml)

The repository is a Node.js workspace:

```text
apps/cli/              command-line interface and setup
apps/gateway/          local service and browser-based console
packages/kernel/       AI providers, memory, sessions, and tool execution
packages/policy/       permissions and safety rules
packages/protocol/     shared request and activity formats
packages/store-file/   local append-only storage
packages/store-sqlite/ durable run and artifact storage
tests/                 unit, integration, CLI, and platform coverage
```

Common development commands:

```bash
pnpm install
pnpm check
pnpm test
pnpm build
```

Detailed architecture, release validation, storage formats, remote hosting, API
routes, and extension contracts live under [docs/](docs/). Keeping those
details there lets this README explain the product before exposing the
machinery underneath it.

## License

[MIT](LICENSE)
