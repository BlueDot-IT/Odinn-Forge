# Cross-agent benchmarks

This harness compares verified outcomes from Ódinn Forge, OpenClaw, Hermes
Agent, or any other command-line agent. It deliberately does not treat a
plausible final message as proof that a task succeeded.

## Model scope

The maintained cross-agent comparison uses cloud models only. Local-model
results are excluded because their latency and context constraints dominated
the runtime comparison instead of measuring the agent frameworks cleanly.

Cloud comparison configs set `modelPolicy` to `cloud-only`, and every adapter
must declare `metadata.deployment` as `cloud`. The runner rejects the config
before launching a trial if either condition is violated. Local protocol
fixtures remain appropriate for deterministic CI and provider integration
tests, but they are not part of the published agent-quality benchmark.

## Fairness rules

- Run the same case fixture and prompt for every adapter.
- Use the same underlying model, provider, reasoning level, and sampling
  settings whenever each runtime permits it.
- Start every trial from disposable workspace and state copies.
- Grade deterministic artifacts and commands before considering model-judged
  evaluation.
- Keep failures, timeouts, and policy denials in the result set.
- Report capability coverage separately from verified success. An unsupported
  task is not silently converted into a pass or removed from the comparison.
- Do not publish one aggregate score without the per-case results.

## Configure adapters

Copy `benchmarks/adapters.cloud.example.json` to the ignored
`benchmarks/adapters.cloud.json` and prepare one sanitized cloud-authenticated
state template per runtime:

```text
benchmarks/state/odinn/
benchmarks/state/openclaw/
benchmarks/state/hermes/
```

State templates are copied into a disposable directory before every trial.
They may contain provider configuration, but must not be committed and should
refer to credentials through environment variables or the runtime's protected
credential store. Do not put secret values in adapter metadata or command
arguments because both are written to reports. The repository ignores
`benchmarks/state/`.

The Forge benchmark state must explicitly add `workspace.writeText` and
`process.exec` to `policy.allowedCapabilities`. File mutation and subprocess
execution are deliberately not enabled by Forge's default policy. Benchmark
trials run them only inside their disposable case workspaces; process working
directories and I/O are bounded, but this is not operating-system sandboxing.

The OpenClaw state template should configure its `main` agent workspace as
`${ODINN_BENCH_WORKSPACE}`. The example adapter sets that variable to the
disposable case workspace for every trial. This prevents OpenClaw from grading
one workspace while editing another. Use a benchmark-only state template: do
not point the harness at a live personal OpenClaw or Hermes state directory.

The example invocation contracts are:

- Ódinn Forge: `odinn run --tool agent.run --input-file ...`
- OpenClaw: `openclaw agent --local --message-file ...`
- Hermes Agent: `hermes --oneshot ...`

OpenClaw's `--local` flag selects its embedded execution path; it does not
select a local inference model. The configured provider/model metadata and
state template still point at the cloud model under comparison.

Adjust executable paths, model flags, and adapter capabilities to match the
versions actually under test. Adapter commands use argument arrays and never a
shell. Supported placeholders are `{repo}`, `{workspace}`, `{state}`,
`{promptFile}`, `{inputFile}`, `{prompt}`, and `{trialId}`.

Fill in each adapter's provider, model, reasoning, and deployment metadata.
Maintained comparisons require `modelPolicy: "cloud-only"` and
`metadata.deployment: "cloud"`. A comparison with different underlying models
is a runtime-plus-model comparison and must not be presented as runtime-only
evidence. Optional version commands are captured in the report. JSON-producing
adapters may also map numeric usage fields through `output.metrics`.

## Run

```bash
pnpm benchmark:agents -- \
  --config benchmarks/adapters.cloud.json \
  --suite benchmarks/suites/comprehensive.json \
  --trials 5
```

Use `--adapter <id>` for one runtime, `--keep-workspaces` for diagnosis, or
`--run-unsupported` to force execution even when an adapter does not declare
the case's required capabilities.

Reports are written under `dist/benchmarks/` as a complete JSON report plus
one self-contained trial envelope per line in JSONL. They contain raw
per-trial results, deterministic assertion evidence, fixture and workspace
digests, Forge and suite commits, adapter versions and model metadata, runtime
metadata, duration percentiles, verified completion rates, and capability
coverage. `verifiedRateExecuted` excludes declared unsupported trials;
`verifiedRateAllTrials` keeps them in the denominator. Publish both.
The report also emits comparison warnings when provider/model/reasoning
metadata is absent or differs between adapters. A warned run can still be
useful, but it is a runtime-plus-model comparison rather than runtime-only
evidence.

Long runs append every completed trial to a progress journal before advancing.
Resume an interrupted cloud matrix without repeating completed trials:

```bash
pnpm benchmark:agents -- \
  --config benchmarks/adapters.cloud.json \
  --suite benchmarks/suites/comprehensive.json \
  --trials 5 \
  --resume-progress dist/benchmarks/<run>.progress.ndjson
```

Forge benchmark cases use a 12-turn agent loop by default, within the runtime's
hard ceiling of 16. They use the provider transport's normal bounded retry
policy unless a case explicitly sets `retries`. Exact structured-output cases
may opt into a recorded final verification pass with `verifyFinal: true`.

## Case format

A case owns a prompt, an optional workspace fixture, declared required
capabilities, and assertions. The initial runner supports:

- `stdout_equals`
- `stdout_contains`
- `stdout_json_equals`
- `file_exists`
- `file_absent`
- `file_equals`
- `file_json_equals`
- `file_contains`
- `file_sha256` for protecting tests or other immutable fixture files
- `command` with an executable and argument array

Command assertions run without a shell inside the disposable workspace.
