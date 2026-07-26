# Messaging channels

Messaging channels are an experimental interface. They connect external chat
networks to the stable authenticated loopback gateway without giving transport
adapters direct access to model providers, records, tools, or workspace files.

The first reference adapter is Telegram. Future adapters should implement the
same `ChannelAdapter` contract rather than duplicating conversation logic.

## Architecture

An adapter normalizes network events into `InboundChannelMessage` values. The
channel router checks an explicit allowlist, rejects duplicate deliveries,
serializes work within each conversation, invokes a transport-neutral handler,
and sends the reply through the originating adapter.

`GatewayChannelHandler` binds each external conversation to one local Ódinn
session. It uses documented bearer-authenticated gateway routes to append
messages and invoke the audited agent runtime. Binding state is local,
owner-only, and written atomically.

## Security defaults

- An empty allowlist denies every inbound sender.
- Bot credentials and the gateway bearer token are inputs, not channel state.
- External identifiers are opaque strings.
- Adapters cannot invoke tools or providers directly.
- Every account, conversation, and thread receives a distinct session binding.
- Telegram uses long polling, avoiding a public inbound webhook.

## Configure Telegram

Create a bot with Telegram's BotFather, place its token in an environment
variable, and configure an allowlist. Never put the token in `config.json`.

```sh
export ODINN_TELEGRAM_BOT_TOKEN="..."
odinn config channel add telegram personal \
  --token-env ODINN_TELEGRAM_BOT_TOKEN \
  --allowlist telegram:123456789
odinn config channel enable personal
odinn start
```

Allowlist entries can identify a sender (`telegram:<user-id>`) or an entire
conversation (`telegram:<chat-id>`). An empty allowlist denies everyone.

Use `odinn config channel list`, `odinn status`, `odinn doctor`, or
`GET /channels` to inspect credential availability and runtime state without
displaying the credential. Channels can also be edited under Messaging
channels in the local console configuration page. Configuration changes take
effect after the gateway restarts.

The operator workflow remains an experimental interface and is outside the v1
compatibility promise.
