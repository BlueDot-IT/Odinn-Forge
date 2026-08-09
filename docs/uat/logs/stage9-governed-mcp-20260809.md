# Stage 9 governed MCP proof log

## Scope

- Repository: `BlueDot-IT/Odinn-Forge`
- Implementation commit before proof-record addition: `4584165`
- Feature: default-off, OCI-confined, admission-governed MCP activation with durable approval continuation and serialized test entry points.

## Exact validation commands and observed results

All test commands were run one at a time with a two-CPU affinity cap. Node's
test runner was explicitly configured with `--test-concurrency=1`.

```text
taskset -c 0-1 pnpm test:gateway
32 tests passed, 0 failed

taskset -c 0-1 node --test --test-concurrency=1 --test-reporter=spec \
  tests/mcp-runtime.test.ts tests/extensions.test.ts \
  tests/execution-admission.test.ts tests/capability-gatewatch.test.ts
37 tests passed, 0 failed

pnpm format:check
format contract passed

pnpm lint
repository lint passed; one pre-existing warning in
packages/kernel/src/differentiated-runtime.ts:552

pnpm typecheck
typecheck contract passed

git diff --check
passed
```

The new gateway regression is `gateway submits MCP invocations as durable
approval-gated jobs` in `tests/gateway.test.ts`.

## Explicit not-tested gaps

- The broad `pnpm test` run was intentionally stopped by the operator after
  211 tests passed; 58 remaining test files were not started.
- Remote CI and post-merge checks were not run locally.
- No production deployment or remote MCP activation was performed.
