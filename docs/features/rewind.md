# Odinn Forge Rewind / Norn Transactions

Rewind is a core advanced service. It snapshots selected local files before
mutation and stores content-addressed artifacts plus original existence, type,
mode, and digest metadata. The default CLI operation is a dry-run; `--apply`
performs an exact selected-root restoration.

```bash
odinn checkpoint create <run-id> --path src,tests --label before-change
odinn rewind <snapshot-id>
odinn rewind <snapshot-id> --apply
```

Snapshot paths must be unique and non-overlapping. Symlinks are rejected, and
snapshot file/byte budgets prevent unbounded capture. Before an applied
restore, Rewind automatically captures the current selected roots and returns
that recovery snapshot ID so the restore itself can be undone. External
effects are not silently reversed; they require a compensation handler or
remain a manual-resolution item.
