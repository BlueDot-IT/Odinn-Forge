# Messaging channels

Messaging channels are an experimental interface. They connect external chat
networks to the stable authenticated loopback gateway without giving transport
adapters direct access to model providers, records, tools, or workspace files.

Telegram and Discord are the first reference adapters. Future adapters should
implement the same `ChannelAdapter` contract rather than duplicating
conversation logic.

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
- The router admits at most 8 pending messages per conversation and 100
  globally, rejecting excess work before it can invoke a model while
  preserving per-conversation serialization.
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

## Configure Discord

Create an application and bot in the Discord Developer Portal. Enable the
Message Content privileged Gateway intent on the Bot page, invite the bot with
View Channel, Send Messages, Read Message History, and Add Reactions
permissions, and keep its token in an environment variable.

Ódinn loads `.env` from the workspace root and then `.env` from the selected
state directory. State values override workspace-file values, while variables
already supplied by the parent process always win. Environment filenames and
variable names may appear in diagnostics, but credential values are never
written into channel configuration or command output. Restrict credential files
to the owning account (for example, `chmod 600 .odinn/.env`).

```sh
printf 'ODINN_DISCORD_BOT_TOKEN=...\\n' > .odinn/.env
chmod 600 .odinn/.env
odinn config channel add discord community \
  --token-env ODINN_DISCORD_BOT_TOKEN \
  --allowlist discord:123456789
odinn config channel enable community
odinn start
```

Discord server messages require an `@mention` by default, even in an
allowlisted channel. Direct messages do not. Use `--require-mention false` only
when the bot should process every message from an allowlisted server channel.
Accepted messages receive `👀` while processing, replaced by `✅` after a
successful reply or `❌` when processing fails. Reaction failures never block
message handling or replies.
Outbound replies disable Discord mention parsing so model-generated text cannot
unexpectedly ping users or roles.

Discord Gateway behavior follows the official
[Gateway documentation](https://docs.discord.com/developers/events/gateway),
and replies follow the official
[message resource](https://docs.discord.com/developers/resources/message).
