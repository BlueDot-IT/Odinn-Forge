# Surface matrix

This matrix applies the terms from the authoritative
[v1 compatibility policy](v1-compatibility.md).

| Surface | Classification | Boundary |
| --- | --- | --- |
| CLI startup and documented core commands | **Stable v1 interface** | Command names, option meanings, and automation-relevant success or failure behavior follow the compatibility policy. Human-readable wording may evolve. |
| Local onboarding and configuration loading or validation | **Stable v1 interface** | Documented configuration fields and security meanings remain compatible. File formatting and derived values are internal. |
| Loopback gateway and documented local console behavior | **Stable v1 interface** | Documented routes, authentication, origin checks, and user workflows are stable. HTML structure, CSS, and undocumented routes are internal implementation details. |
| Projects, sessions, messages, goals, and memory | **Stable v1 interface** | Documented records and user workflows receive compatible schema migrations. Physical store layout is internal. |
| Tasks, durable jobs, cron jobs, approvals, restart recovery, and uncertain-outcome recovery | **Stable v1 interface** | Safe work with a complete durable input recovers after restart. Inputs removed by persistence redaction require resubmission. Approval outcomes settle their originating job, and unknown external outcomes remain blocked for review rather than being silently replayed. |
| Durable workflow definitions and `/workflows` | **Experimental interface** | Explicitly disabled by default. Versioned workflow definitions, serialized step leases, admission-backed dispatch, bounded recovery, and effectful `needs-review` classification are supported within the Stage 10 subset. |
| Authenticated event watches, heartbeat candidates, and `/events/ingest` | **Experimental interface** | Explicitly disabled by default. Sources require operator-owned authentication digests and monotonic cursors; candidates never grant execution authority and dispatch remains subject to durable jobs and admission. |
| Project context and scoped memory retrieval | **Experimental interface** | Explicitly disabled by default. Project/session scope, bounded ranking, provenance, freshness binding, and digest-only projections are supported; recalled text is untrusted context data. |
| Audited tool execution, diagnostics, and audit verification | **Stable v1 interface** | Documented event meaning, integrity verification, redaction, and correlation behavior are stable. Journal encoding is internal. |
| Bounded workspace inspection (`workspace.list`, `workspace.stat`, `workspace.search`, `workspace.read`, `workspace.diff`, and compatible `workspace.readText`) | **Stable v1 interface** | Portable relative-path confinement, sensitive-file filtering, bounds, deterministic traversal, cursor binding, content-free durable evidence, and cancellation are stable. Filesystem identity and race detection are platform-dependent; no atomic macOS/Windows ABA guarantee or hostile-code containment is claimed. |
| Public web reads, isolated browser operation, and browser mutation approval | **Stable v1 interface** | Network policy, private-network blocking, redirect validation, separate browser data, approval, and recovery boundaries remain enforced. Site availability is provider-dependent behavior; rendering can be platform-dependent behavior. |
| Installation, update, rollback, backup, restore, uninstall, and state migration | **Stable v1 interface** | Built releases verify identity, preserve recoverable state, and reject incompatible application or state combinations. Version-directory and pointer layout is internal. |
| OpenAI / ChatGPT, OpenRouter, Ollama, and custom OpenAI-compatible endpoints | **Stable v1 interface** | The first-class paths and generic adapter receive stable configuration, normalized inference, response parsing, redaction, retry, model selection, diagnostics, and onboarding contracts. |
| Compatible provider presets | **Provider-dependent behavior** | Preset metadata and the shared adapter are maintained, but continuous live-service operation is not guaranteed. |
| Provider paths labeled Experimental | **Experimental interface** | Specialized OAuth, device, or CLI paths may change outside the normal v1 provider promise. |
| Live provider services, accounts, models, quotas, prices, rate limits, and OAuth flows | **Provider-dependent behavior** | External services can change independently. A local protocol test does not prove a live service or account. |
| Browser engines, local model servers, local CLI adapters, filesystem semantics, and host process behavior | **Platform-dependent behavior** | Availability and exact behavior depend on the operating system and installed software. |
| Kernel module layout, private package exports, storage filenames, console DOM, CSS, and undocumented routes | **Internal implementation detail** | These may change during compatible refactoring. Repository packages marked `private` are not public SDKs. |
| Execution envelopes, attempts, cancellation controls, runtime jobs, leases, graph/node state, and mutation journals | **Internal implementation detail** | Envelope schema v4, job/recovery schema v5, graph schema v7, and checkpoint/mutation schema v6 are active behind the stable task surfaces. Physical table layout remains internal; execution admission, audit correlation, idempotency, restart classification, uncertain-outcome, and digest-bound mutation behavior remain compatibility obligations. |
| Runemark, Gatewatch, Norn Restore, Norn Governance, and Raven Route | **Core advanced service; experimental interface** | Available without feature flags and integrated with the runtime. Existing Proof, Sentinel, Rewind, and Darwin technical identifiers remain compatible, while their advanced CLI/gateway contracts remain outside the stable public-SDK promise. |
| Saga Archive, Rune Key, and Worldtree Paths | **Optional plugin module; experimental interface** | Disabled by default and loaded through the internal runtime plugin boundary. Existing Capsule, Capability Token, and Counterfactual technical identifiers remain compatible; their surfaces and state remain outside normal v1 compatibility guarantees. |
| Agent SDK packages, Skill SDK packages, third-party extensions, and MCP packages | **Experimental interface** | Discovery and registration do not execute code or grant trust. Review, integrity checks, explicit enablement, grants, and policy remain required. |
| Messaging channel adapters and channel session bindings | **Experimental interface** | Adapters must use the authenticated gateway and cannot bypass session, policy, audit, approval, or tool-execution boundaries. |
| Multi-user hosting and unconfined process execution | **Experimental interface** | These require explicit operator choices and remain outside the stable local single-user promise. |
| Full replay or rollback of external effects or nondeterministic provider behavior | **Unsupported behavior** | External outcomes can be delayed, partial, repeated, or unknowable. |
| Hostile-code containment by forked workers or hostile-user OS isolation through remote hosting | **Unsupported behavior** | Use separate operating-system users, containers, or machines for mutually hostile code or users. |
| Bypassing approval, policy, audit, verified updates, or state compatibility checks | **Unsupported behavior** | Safety and compatibility checks are part of the supported contract. |

## Three hard limits

- Forked workers are crash containment, not a security sandbox.
- Remote hosting is application-level tenant isolation, not hostile-user OS isolation.
- External effects and nondeterministic provider behavior are outside full replay/rollback guarantees.

Workspace inspection is read-only application enforcement. The planned Stage
4 sandbox remains the hard boundary for untrusted execution.

When a surface is not covered by the compatibility policy or this matrix, treat
it as **Unsupported behavior** until the documentation explicitly says
otherwise.
