# Norn Restore — Restore points

Norn Restore is Ódinn Forge's core restore-point service. The existing
`checkpoint` and `rewind` CLI commands, routes, and SDK names remain
compatibility identifiers. It snapshots selected local files before mutation
and stores content-addressed artifacts plus original existence, type, mode,
and digest metadata.

```bash
odinn checkpoint create <run-id> --path src,tests --label before-change
odinn checkpoint preview <snapshot-id> [--run <run-id>] [--capability-token <token>] [--state .odinn]
odinn checkpoint apply <snapshot-id> --run <run-id> [--capability-token <token>] [--state .odinn]
```

Snapshot paths must be unique and non-overlapping. Symlinks are rejected, and
snapshot file/byte budgets prevent unbounded capture. Before an applied
restore, Norn Restore automatically captures the current selected roots and
returns that recovery snapshot ID so the restore itself can be undone. External
effects are not silently reversed; they require a compensation handler or
remain a manual-resolution item.

For compatibility, `odinn rewind <snapshot-id>` continues to provide the
same preview/apply behavior through the governed runtime path.
