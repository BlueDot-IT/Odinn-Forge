# Provider capability metadata

Ódinn exposes an optional, in-memory provider capability contract from
`@odinn/kernel/provider-capabilities`. The main kernel export, provider runtime,
CLI, and Gateway do not import it. Existing configurations and inference paths
therefore behave exactly as before unless a caller explicitly loads this
subpath.

The contract answers whether one configured provider/model path can satisfy a
bounded set of requirements:

- `supported` means both the current transport can carry the capability and an
  explicit claim says the exact provider/model supports it.
- `unsupported` means the current adapter cannot carry the capability or an
  explicit claim says the provider/model does not support it.
- `unknown` means the adapter can carry the capability but Ódinn lacks evidence
  about the exact provider/model. Unknown is never treated as supported.

Each record preserves `transportStatus` separately from `providerStatus`. A
tested adapter contract therefore never masquerades as proof that a changing
remote service or model supports the feature.

Compatibility assessments return `compatible`, `incompatible`, or `unknown`.
They do not select a fallback provider. The caller must surface uncertainty,
request an explicit operator decision, or choose another already-authorized
route. This prevents silent changes to billing, data residency, authentication,
or security posture.

## Bounded metadata

Schema version 1 defines seven capability identifiers: text generation,
streaming, tool calling, structured output, image input, audio input, and
embeddings. Provider/model identifiers are limited to 128 UTF-8 bytes, notes to
512 UTF-8 bytes, and claims/requirements to the fixed capability count.
Unknown fields, duplicate claims, duplicate requirements, invalid timestamps,
and attempts to claim support for a transport-incompatible capability fail
closed.

Claims have explicit provenance:

- `operator-configured` records an operator assertion for the exact
  provider/model path.
- `runtime-observed` records an observation and requires a UTC timestamp.
- `unverified` means no provider/model claim was supplied. Ódinn generates the
  separate transport status from its tested adapter contract.

Claims require an exact `modelId`; provider-wide claims are rejected. Provenance
labels, notes, and timestamps are caller-declared, unauthenticated assertions,
not cryptographic proof. Runtime observations more than 60 seconds in the
future are rejected. Callers may supply a deterministic `now` value for tests
or a trusted integration clock, but that does not authenticate the claim.

Runtime observations are evidence, not permanent truth. Providers and models
can change, so callers remain responsible for freshness policy. The module does
not perform network discovery, read credentials, write state, emit telemetry,
or invoke a provider.

## Example

```ts
import {
  assessProviderCompatibility,
  createProviderCapabilityMetadata
} from "@odinn/kernel/provider-capabilities";

const metadata = createProviderCapabilityMetadata({
  providerId: "openrouter",
  modelId: "vendor/model",
  transport: "openai-chat-completions",
  claims: [{
    capability: "text-generation",
    status: "supported",
    source: "operator-configured"
  }, {
    capability: "tool-calling",
    status: "supported",
    source: "operator-configured"
  }]
});

const assessment = assessProviderCompatibility(metadata, [
  "text-generation",
  "tool-calling"
]);
```

No persistent-state migration or rollback action is required. Removing the
subpath and its callers restores the previous behavior because the active
runtime has no dependency on it.
