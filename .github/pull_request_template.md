## Problem

Describe the specific problem and why it belongs in the current release scope.

## Implementation

Describe the bounded change. Keep each pull request to one coherent area.

## Compatibility impact

State whether this changes a stable interface, internal implementation detail,
experimental interface, provider-dependent behavior, platform-dependent
behavior, or unsupported behavior.

## State migration impact

State `None`, or document the previous schema, new schema, migration path,
backup behavior, failure behavior, rollback compatibility, and fixture
coverage.

## Security impact

Describe changes to permissions, secrets, network access, approvals, audit,
updates, backups, restore, or other trust boundaries. State `None` when
applicable.

## Validation

- [ ] Relevant unit and integration tests
- [ ] Compatibility and security boundary tests where behavior changed
- [ ] Cross-platform impact considered
- [ ] Documentation updated for user-visible behavior
- [ ] No unrelated formatting churn

Include exact commands and sanitized evidence.

## Rollback

Explain how to revert the application change and whether current persistent
state remains readable after rollback.
