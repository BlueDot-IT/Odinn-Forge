# Benchmark evidence and limitations

Ódinn Forge has several kinds of benchmark evidence. They answer different
questions and must not be combined into a universal speed, quality, cost, or
model-ranking claim.

This page documents the benchmark behavior present in this repository. It does
not publish invented historical results. A published timing or comparison result
is evidence only when it links the exact code revision, command, environment,
and raw output that produced it.

## Evidence classes

### Enforced synthetic OpenAI-compatible protocol latency gate

`pnpm benchmark:ci` starts with `scripts/ci/benchmark.ts`. The script builds and
stages the production package, then runs 20 cold OpenAI-compatible protocol
smoke samples through the packaged gateway. It reports p50, p95, and maximum
elapsed time and fails when p95 exceeds the configured limit, which defaults to
2,000 milliseconds through `ODINN_BENCHMARK_P95_MAX_MS`.

The command runs in CI, merge-queue, nightly, and release verification. This is
an enforced regression gate for that bounded protocol path. It is not a
measurement of live cloud-model latency, end-user task completion time, model
quality, or throughput under production traffic.

### Assurance microbenchmarks

`pnpm benchmark:assurance` runs
`scripts/ci/assurance-benchmark.ts`. Its default configuration uses 10 warmups
and 80 measured samples for:

- built-in tool dispatch with zero, one, three, and ten policy invariants;
- atomic execution-envelope persistence;
- complete admission including the separate signed audit commit;
- pinned Raven Route selection; and
- evidence-based Raven Route selection over 100, 1,000, and 10,000 synthetic
  observations.

The report includes p50, p95, maximum latency, and the observed p95 difference
between zero-invariant and three-invariant dispatch. Atomic execution-envelope
persistence has an enforced 10 ms p95 gate. Complete admission includes a
second authoritative SQLite store configured with `synchronous=FULL`; that
signed-audit cost remains visible but observational. Other assurance scenarios
also remain observational. These numbers are useful for investigation and
trend detection on comparable hosts, not for a product-wide performance
promise.

`ODINN_ASSURANCE_BENCHMARK_SAMPLES` and
`ODINN_ASSURANCE_BENCHMARK_WARMUPS` can change the bounded sample counts. Any
published result must record non-default values.

### Bounded large-workspace inspection gate

`pnpm benchmark:workspace-inspection` runs
`scripts/ci/workspace-inspection-benchmark.ts` with explicit garbage
collection enabled. The default synthetic fixture contains 10,000 flat text
files plus a bounded nested directory. The benchmark enforces:

- deterministic consumption of every cursor page with the exact expected
  component-wise preorder, no omissions, and no duplicates;
- a maximum of 128 results per page and a recursive depth of four;
- explicit `maxFiles` rejection and bounded, resumable search `maxBytes`
  behavior;
- no more than 96 MiB of measured heap growth; and
- no more than 15 seconds for the timed first-page recursive listing and 120
  seconds for complete pagination of the default fixture.

The JSON report records the gates, host platform, architecture, Node.js
version, timings, heap measurements, counts, and every Boolean check at
`dist/benchmark/workspace-inspection.json`. The file-count and duration gates
can be changed for slower-platform diagnosis with
`ODINN_WORKSPACE_BENCHMARK_FILES` and
`ODINN_WORKSPACE_BENCHMARK_MAX_MS`. The complete-pagination diagnostic gate
uses `ODINN_WORKSPACE_BENCHMARK_PAGINATION_MAX_MS`; any evidence must disclose
overrides.

This is a deterministic filesystem guardrail, not a claim about all real
repositories. It does not represent arbitrary directory shapes, slow or remote
filesystems, concurrent workspace mutation, ignore-pattern complexity, model
latency, or hostile-code containment.

### Synthetic memory-index profiling

`pnpm benchmark:memory-index` runs
`scripts/ci/memory-index-benchmark.ts`. It builds a deterministic synthetic
20,000-document corpus, verifies retrieval parity between the SQLite FTS5
candidate index and a full JavaScript scan, and reports fingerprint, rebuild,
p50, and p95 timings. Query measurements use 50 samples after warmup.

Its result is observational and has no enforced latency threshold. Its
generated text, lexical query, document shape, and single process do not
establish semantic retrieval quality or production-corpus performance.

### Independent runtime and model evaluation

End-to-end runtime and model comparisons belong to the separate public
[BlueDot-IT/agent-benchmarks](https://github.com/BlueDot-IT/agent-benchmarks)
repository. That harness launches runtimes as bounded commands in disposable
workspaces and scores deterministic outcomes rather than accepting a plausible
final message as proof.

An external comparison can include model and provider behavior in addition to
runtime behavior. It is therefore not interchangeable with Ódinn Forge's local
protocol gate or microbenchmarks. The external harness owns its cases,
adapters, grading, reproducibility metadata, and reports; product fixes remain
in the product repository.

## Reproduction requirements

The repository timing scripts sort measured durations and use nearest-rank
selection (`ceil(sample count × percentile) - 1`) without interpolation. The
script revision is therefore part of the measurement method.

A benchmark report intended for review or publication should preserve:

1. The exact Ódinn Forge commit. External evaluations also need the exact
   benchmark-harness commit.
2. The command, scenario or suite, configuration digest, threshold overrides,
   sample count, and warmup count.
3. Operating system, architecture, Node.js and pnpm versions, CPU or runner
   class, and whether the host was shared, virtualized, thermally constrained,
   or under notable background load.
4. The complete raw JSON or captured stdout and stderr, not only a rounded
   summary or screenshot.
5. The workflow-run and retained-artifact URLs for CI evidence, including the
   artifact retention period.
6. All failures, timeouts, policy denials, and unsupported cases. Do not remove
   them from the denominator without stating that choice.
7. Sanitization confirmation. Raw artifacts must not contain credentials,
   tokens, cookies, private prompts, personal state, or private workspace
   content.

For controlled-host reproduction, keep the source revision, runtime, power
mode, background workload, sample counts, and command constant. Run enough
independent repetitions to expose variance. A difference observed on unmatched
hosts is environment evidence, not a product regression by itself.

## Raw artifacts and CI retention

The packaged gateway gate writes its raw JSON report to
`dist/benchmark/benchmark.json`. CI, merge-queue, nightly, and release
workflows upload that file as the `benchmark-report` artifact. Link the exact
workflow run and retained artifact when citing its values; a green check alone
does not preserve the measured distribution.

The observational assurance and memory-index scripts emit JSON to standard
output. Their console output remains transient unless a workflow or operator
captures it. Other workflow artifacts, such as release candidates or security
reports, must not be cited as benchmark raw data unless they actually contain
the complete output being discussed. Do not reconstruct precise historical
values from a green status.

The workspace inspection gate writes
`dist/benchmark/workspace-inspection.json`. Treat that report as transient
unless the workflow for the cited revision explicitly retains it as an
artifact.

Local outputs are transient unless the operator deliberately captures them.
Store them outside personal state, review them for secrets, and record their
digest before sharing. If the raw JSON omits required environment fields,
attach a sidecar manifest instead of inferring hardware or runner details.

## How to run the current benchmarks

From a clean checkout with the repository's declared Node.js and pnpm versions:

```bash
pnpm install --frozen-lockfile
pnpm benchmark:ci
pnpm benchmark:assurance
pnpm benchmark:recovery
pnpm benchmark:workspace-inspection
pnpm benchmark:memory-index
```

`benchmark:ci` already invokes the assurance, recovery, and workspace
inspection benchmarks after the enforced protocol gate. Running an individual
command remains useful when investigating its own scenario and report.

## Interpretation limits

- p50, p95, and maximum values describe only the collected sample. They are not
  confidence intervals.
- Hosted CI runners vary in CPU availability and system load. A single run is
  weak evidence for a cross-version comparison.
- Local microbenchmarks omit provider latency, network variability, user think
  time, and most real task work.
- Synthetic memory profiling does not establish semantic quality, privacy
  properties, or production-data behavior.
- Synthetic workspace inspection does not establish performance or race
  freedom for every host filesystem or repository shape.
- Runtime-plus-model evaluation is provider-, model-, policy-, configuration-,
  and scenario-dependent. Missing or mismatched metadata prevents a
  runtime-only conclusion.
- Results age as code, dependencies, providers, models, and hosted runners
  change.

Accordingly, do not claim that Ódinn Forge is universally faster, that one
model is universally better, or that a CI guardrail predicts a user's latency.
Publish the bounded result and its provenance instead.
