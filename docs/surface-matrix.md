# Surface matrix

This matrix applies the terms from the authoritative
[v1 compatibility policy](v1-compatibility.md).

| Surface | Classification | Boundary |
| --- | --- | --- |
| CLI startup and documented core commands | **Stable v1 interface** | Command names, option meanings, and automation-relevant success or failure behavior follow the compatibility policy. Human-readable wording may evolve. |
| Local onboarding and configuration loading or validation | **Stable v1 interface** | Documented configuration fields and security meanings remain compatible. File formatting and derived values are internal. |
| Loopback gateway and documented local console behavior | **Stable v1 interface** | Documented routes, authentication, origin checks, and user workflows are stable. HTML structure, CSS, and undocumented routes are internal implementation details. |
| Projects, sessions, messages, goals, and memory | **Stable v1 interface** | Documented records and user workflows receive compatible schema migrations. Physical store layout is internal. |
| Tasks, durable jobs, cron jobs, approvals, restart recovery, and uncertain-outcome recovery | **Stable v1 interface** | Safe work recovers after restart. Unknown external outcomes remain blocked for review rather than being silently replayed. |
| Audited tool execution, diagnostics, and audit verification | **Stable v1 interface** | Documented event meaning, integrity verification, redaction, and correlation behavior are stable. Journal encoding is internal. |
| Public web reads, isolated browser operation, and browser mutation approval | **Stable v1 interface** | Network policy, private-network blocking, redirect validation, separate browser data, approval, and recovery boundaries remain enforced. Site availability is provider-dependent behavior; rendering can be platform-dependent behavior. |
| Installation, update, rollback, backup, restore, uninstall, and state migration | **Stable v1 interface** | Built releases verify identity, preserve recoverable state, and reject incompatible application or state combinations. Version-directory and pointer layout is internal. |
| OpenAI / ChatGPT, OpenRouter, Ollama, and custom OpenAI-compatible endpoints | **Stable v1 interface** | The first-class paths and generic adapter receive stable configuration, normalized inference, response parsing, redaction, retry, model selection, diagnostics, and onboarding contracts. |
| Compatible provider presets | **Provider-dependent behavior** | Preset metadata and the shared adapter are maintained, but continuous live-service operation is not guaranteed. |
| Provider paths labeled Experimental | **Experimental interface** | Specialized OAuth, device, or CLI paths may change outside the normal v1 provider promise. |
| Live provider services, accounts, models, quotas, prices, rate limits, and OAuth flows | **Provider-dependent behavior** | External services can change independently. A local protocol test does not prove a live service or account. |
| Browser engines, local model servers, local CLI adapters, filesystem semantics, and host process behavior | **Platform-dependent behavior** | Availability and exact behavior depend on the operating system and installed software. |
| Kernel module layout, private package exports, storage filenames, console DOM, CSS, and undocumented routes | **Internal implementation detail** | These may change during compatible refactoring. Repository packages marked `private` are not public SDKs. |
| Runemark, Gatewatch, Norn Restore, and Raven Route | **Core advanced service; experimental interface** | Available without feature flags and integrated with the runtime. Existing Proof, Sentinel, Rewind, and Darwin technical identifiers remain compatible, while their advanced CLI/gateway contracts remain outside the stable public-SDK promise. |
| Saga Archive, Rune Key, and Worldtree Paths | **Optional plugin module; experimental interface** | Disabled by default and loaded through the internal runtime plugin boundary. Existing Capsule, Capability Token, and Counterfactual technical identifiers remain compatible; their surfaces and state remain outside normal v1 compatibility guarantees. |
| Agent SDK packages, Skill SDK packages, third-party extensions, and MCP packages | **Experimental interface** | Discovery and registration do not execute code or grant trust. Review, integrity checks, explicit enablement, grants, and policy remain required. |
| Multi-user hosting and unconfined process execution | **Experimental interface** | These require explicit operator choices and remain outside the stable local single-user promise. |
| Full replay or rollback of external effects or nondeterministic provider behavior | **Unsupported behavior** | External outcomes can be delayed, partial, repeated, or unknowable. |
| Hostile-code containment by forked workers or hostile-user OS isolation through remote hosting | **Unsupported behavior** | Use separate operating-system users, containers, or machines for mutually hostile code or users. |
| Bypassing approval, policy, audit, verified updates, or state compatibility checks | **Unsupported behavior** | Safety and compatibility checks are part of the supported contract. |

## Three hard limits

- Forked workers are crash containment, not a security sandbox.
- Remote hosting is application-level tenant isolation, not hostile-user OS isolation.
- External effects and nondeterministic provider behavior are outside full replay/rollback guarantees.

When a surface is not covered by the compatibility policy or this matrix, treat
it as **Unsupported behavior** until the documentation explicitly says
otherwise.
