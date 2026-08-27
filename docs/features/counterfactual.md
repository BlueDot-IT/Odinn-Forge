# Worldtree Paths — Scenario comparison

Worldtree Paths is Ódinn Forge's optional scenario-comparison plugin module.
The existing `counterfactual` CLI command, configuration key, gateway routes,
and SDK names remain compatibility identifiers. It recursively copies a
workspace into separate candidate directories outside the source workspace,
under a runtime-owned worktree root such as
`<state>/worktrees/<group>/<plan>`. If the configured state path overlaps the
source workspace, Ódinn Forge selects a disjoint owner-private sibling root
instead. Workspace, state, candidate, and recovery roots are bound to their
canonical physical identities before copying; symlinked aliases cannot bypass
state exclusion, and symbolic links are never copied. The candidates create independent run records, ledger relationships,
and plans. They are filesystem copies, not Git worktrees or operating-system
sandboxes. Generated and cache-heavy roots
(`.git`, `node_modules`, `dist`, `build`, `coverage`, `.next`, `.cache`,
`.turbo`, and `.pnpm-store`) are excluded. The source workspace is not modified
by branch creation.

```bash
odinn config experimental enable counterfactual --confirm-impact
odinn counterfactual run --source-run <run-id> --from <step-id> --plan-file plan-a.json --plan-file plan-b.json --execute
odinn counterfactual compare <group-id>
odinn counterfactual select <group-id> --run <candidate-run-id> --apply
```

An executable plan contains a bounded `tasks` array of ordinary Odinn Forge
task objects and may include a Runemark contract. Read-only tasks may set
`readOnly: true`; Ódinn Forge then issues a one-use, candidate-bound Rune Key.
Mutating tasks must carry an explicitly approved key. `--execute` runs each
candidate independently through the normal audited tool boundary, then runs
the candidate contract when present. Plans without `--execute` remain dry-run
branch creation only. Selection is also a dry-run unless `--apply` is supplied;
applying replaces only files outside `.git`, `.odinn`, and
`.odinn-worktrees`, with an owner-private source backup under the runtime
worktree recovery root. A verified rollback removes that backup. If rollback
cannot be verified, Ódinn retains the backup and a `recovery.json` manifest,
marks both the candidate and group `recovery-required`, and journals the stable
recovery path for operator handling. Irreversible
external actions remain approval-gated and are not silently made safe by
branching.
