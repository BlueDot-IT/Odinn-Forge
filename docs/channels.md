# Messaging channels

Messaging channels are an experimental plugin interface. They connect external chat
networks to the stable authenticated loopback gateway without giving transport
adapters direct access to model providers, records, tools, or workspace files.

Telegram and Discord are the first production adapters. Future adapters
register a `ChannelPlugin` and implement the shared `ChannelAdapter` contract
rather than duplicating account, conversation, lifecycle, or policy logic.

## Architecture

An adapter normalizes network events into `InboundChannelMessage` values. The
channel router checks the account policy, atomically claims each delivery,
serializes work within each conversation, enforces bounded global concurrency,
retries transient failures with bounded backoff, invokes a transport-neutral
handler, and sends the reply through the originating adapter. Committed
delivery identifiers survive restarts; abandoned claims become retryable.

`GatewayChannelHandler` binds each external conversation to one local Ódinn
session. It uses documented bearer-authenticated gateway routes to append
messages and submit an audited agent run through a durable `/jobs` receipt. The
execution key is derived from the channel, account, conversation, thread, and
inbound message ID. A dropped connection therefore reconciles the existing
queued, running, completed, or restart-uncertain job instead of submitting a
second run. Result delivery is a separate retry phase: a failed adapter send
does not rerun the model. Binding and deduplication state are local,
owner-only, and written atomically.

Channel execution audit records use explicit states: `accepted`, `running`,
`reconciled`, `completed`, `uncertain` after a restart-quarantined outcome, and
`delivery-failed` when the terminal adapter delivery cannot be completed.
`uncertain` is fail-closed: the router never silently re-executes that run.

### Channel state persistence and recovery

Binding and deduplication files retain schema version `1` and use the shared
secure JSON mutation primitive from `@odinn/store-file`. Each complete
read/validate/mutate/replace operation is guarded by a token-owned lock at
`<state-file>.lock`. Lock acquisition is bounded and fail-closed; a stale lock
is not reclaimed automatically because an operator must first verify that no
Odinn process still owns it.

State files and their immediate parent are validated as owner-only regular
paths. Corrupt schemas, invalid entries, symbolic-link state files or parents,
and insecure permissions are rejected before mutation. Writes use a temporary
file followed by atomic POSIX replacement or the existing Windows
`File.Replace` rollback path, so an interrupted write leaves the prior valid
state or the complete replacement. A failed mutation returns its original
error and does not poison later operations; retrying is safe after the cause
is corrected.

A successful lock owner releases only after its open handle confirms the
original token and file identity. The handle's device and inode are compared
with a fresh `lstat` of the lock path immediately before unlinking, so a path
replaced by another owner is left untouched. Waiters never reclaim or delete a
lock. An active lock remains fail-closed evidence after a process crash: verify
that no Odinn process is using the store before manually removing the lock.

## Security defaults

- An empty allowlist denies every inbound sender unless an explicit open
  account policy is configured.
- Bot credentials and the gateway bearer token are inputs, not channel state.
- External identifiers are opaque strings.
- Adapters cannot invoke tools or providers directly.
- Every account, conversation, and thread receives a distinct session binding.
- The router admits at most 8 pending messages per conversation and 100
  globally, rejecting excess work before it can invoke a model while
  preserving per-conversation serialization.
- Each sender may start at most 30 model-backed messages per 60-second
  admission window. Sender-window state is capped at 2,000 entries;
  new senders are rejected while that bounded state is full.
- Telegram uses grammY long polling, avoiding a public inbound webhook.
- Discord uses `discord.js` Gateway resume, reconnect, and REST rate-limit
  handling.
- External metadata is wrapped in an explicit untrusted-context envelope
  before it enters model history.
- Bot-authored Discord messages are rejected by default, with optional
  mention-only handling and a per-sender loop circuit breaker.

## Configure Telegram

Create a bot with Telegram's BotFather, place its token in an environment
variable, and configure an allowlist. Never put the token in `config.json`.

```sh
export ODINN_TELEGRAM_BOT_TOKEN="..."
odinn config channel add telegram personal \
  --token-env ODINN_TELEGRAM_BOT_TOKEN \
  --allowlist telegram:123456789 \
  --require-mention true
odinn config channel enable personal
odinn start
```

Allowlist entries can identify a sender (`telegram:<user-id>`) or an entire
conversation (`telegram:<chat-id>`). An empty allowlist denies everyone.
Telegram supports text and attachment ingress, media egress, forum topics,
typing indicators, reactions, reply markup buttons, message edits/deletion,
streaming drafts, and callback-query routing. Native `/odinn` registration is
opt-in with `--native-commands true`.

Use `odinn config channel list`, `odinn status`, `odinn doctor`, or
`GET /channels` to inspect credential availability and runtime state without
displaying the credential. Channels can also be edited under Messaging
channels in the local console configuration page. Configuration changes take
effect after the gateway restarts.

The operator workflow remains an experimental interface and is outside the v1
compatibility promise.

## Configure Discord

Create an application and bot in the Discord Developer Portal. Enable the
Message Content privileged Gateway intent on the Bot page. Invite the bot with
View Channel, Send Messages, Read Message History, Add Reactions, Use External
Emoji, Attach Files, Embed Links, and Create Public Threads as needed. Keep its
token in an environment variable.

Ódinn loads credential-oriented variables from `.env` in the workspace root and
then loads `.env` from the explicitly selected state directory. The default
state directory is the operator-owned `~/.odinn`; a repository-local `.odinn`
directory is not selected implicitly. State values override workspace-file
values, while variables already supplied by the parent process always win.
Environment filenames and variable names may appear in diagnostics, but
credential values are never written into channel configuration or command
output. Restrict credential files to the owning account (for example,
`chmod 600 ~/.odinn/.env`).

```sh
printf 'ODINN_DISCORD_BOT_TOKEN=...\\n' > ~/.odinn/.env
chmod 600 ~/.odinn/.env
odinn config channel add discord community \
  --token-env ODINN_DISCORD_BOT_TOKEN \
  --allowlist discord:123456789 \
  --dm-policy allowlist \
  --group-policy allowlist \
  --require-mention true
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
unexpectedly ping users or roles. Replies can stream into a single edited
message, carry attachments and buttons, and remain in the originating thread.

Discord accounts support:

- separate `disabled`, `allowlist`, and `open` policies for direct and server
  messages;
- per-guild and per-channel mention rules plus user and role allowlists;
- attachments, replies, typing, reactions, edits, deletion, threads, native
  polls, buttons/select interactions, and optional `/odinn` registration;
- Gateway health, reconnect count, last-event time, REST/Gateway latency, and
  bot identity in credential-safe diagnostics;
- bot-loop suppression and configurable acknowledgement emoji.

Advanced guild rules are edited in the local console or directly in
`config.json`. The shape is:

```json
{
  "channels": {
    "community": {
      "type": "discord",
      "enabled": true,
      "tokenEnv": "ODINN_DISCORD_BOT_TOKEN",
      "dmPolicy": "allowlist",
      "groupPolicy": "allowlist",
      "requireMention": true,
      "allowBots": false,
      "historyLimit": 40,
      "nativeCommands": false,
      "nativeCommandName": "odinn",
      "allowlist": ["discord:123456789"],
      "guilds": {
        "111111111111111111": {
          "requireMention": true,
          "users": ["123456789"],
          "roles": ["222222222222222222"],
          "channels": {
            "333333333333333333": {
              "enabled": true,
              "requireMention": true,
              "users": [],
              "roles": []
            }
          }
        }
      }
    }
  }
}
```

When a guild contains a `channels` map, unlisted channels are denied. Native
command registration is disabled by default because it changes the bot
application's command registry.

## Discord agent actions

The enabled Discord account also exposes audited agent tools for channel and
message reads, sending, editing, deletion, reactions, pins, polls, thread
creation/list/replies, and message search. Read-only tools execute directly.
Every Discord mutation is bound to an exact account, run, tool name, and input
and consumes a one-time approval before any Discord request is made. Individual
tools can be disabled under `plugins.entries.discord.config.tools`.

The Discord adapter owns these tool schemas, Discord identifiers, account
selection, payload construction, and REST behavior. `@odinn/runtime` composes
the definitions into the CLI, gateway, and isolated workers. The kernel sees
only the shared channel-tool contract and remains authoritative for policy,
capability intersection, one-time approval consumption, audit, and uncertain
outcomes. A configured agent-tool account does not require the inbound Discord
Gateway adapter to be running.

## Runtime status

`odinn config channel list`, `odinn status`, `odinn doctor`, and
`GET /channels` report the normalized plugin capabilities and lifecycle state:
`stopped`, `starting`, `connected`, `degraded`, or `failed`. Status includes
safe timing and reconnect data, never token values. The supervisor probes live
accounts every 30 seconds and isolates failures by account.

Discord Gateway behavior follows the official
[Gateway documentation](https://docs.discord.com/developers/events/gateway),
and replies follow the official
[message resource](https://docs.discord.com/developers/resources/message).

## Configure Slack

Slack uses the official Bolt SDK in Socket Mode, so no public webhook is
required. Create a Slack app with a bot token (`xoxb-...`) and an app-level
Socket Mode token (`xapp-...`). Subscribe to message events, enable
interactivity, and add a `/odinn` slash command if native command handling is
desired.

```sh
odinn config channel add slack work \
  --token-env ODINN_SLACK_BOT_TOKEN \
  --app-token-env ODINN_SLACK_APP_TOKEN \
  --allowlist slack:U123456789 \
  --require-mention true \
  --native-command-name /odinn
odinn config channel enable work
```

Slack supports DMs, channels, threads, mentions, Socket Mode reconnects,
reactions, files, Block Kit buttons, edits/deletion, slash-command ingress,
streaming drafts, and credential-safe `auth.test` health probes. Bot and
subtype events are rejected before routing.

## Configure Microsoft Teams

Teams uses the official Bot Framework `CloudAdapter`. It requires an externally
reachable HTTPS route terminating at:

```text
/channels/webhook/teams/<account-name>
```

The route is exempt from Ódinn control-plane bearer authentication because Bot
Framework performs its own JWT validation. It is still isolated from every
other gateway route. Put the app password in `--token-env`, the application ID
in `--app-id-env`, and optionally restrict a single-tenant bot with
`--tenant-id-env`.

```sh
odinn config channel add teams work \
  --token-env ODINN_TEAMS_APP_PASSWORD \
  --app-id-env ODINN_TEAMS_APP_ID \
  --tenant-id-env ODINN_TEAMS_TENANT_ID \
  --allowlist teams:AAD_USER_OR_CONVERSATION_ID \
  --require-mention true
odinn config channel enable work
```

Teams supports personal chats, channels, reply chains, attachments, typing,
suggested-action buttons, edits/deletion, and streaming drafts. Conversation
references are learned only from authenticated inbound activities; proactive
delivery cannot escape into an unknown conversation.

## Configure WhatsApp Business

WhatsApp uses Meta's Cloud API and an HMAC-verified webhook:

```text
/channels/webhook/whatsapp/<account-name>
```

Configure this URL in the Meta app, using the value referenced by
`--verify-token-env` as its verification token. POST bodies must carry a valid
`X-Hub-Signature-256` generated from the app secret before they are parsed or
routed.

```sh
odinn config channel add whatsapp business \
  --token-env ODINN_WHATSAPP_ACCESS_TOKEN \
  --app-secret-env ODINN_WHATSAPP_APP_SECRET \
  --verify-token-env ODINN_WHATSAPP_VERIFY_TOKEN \
  --phone-number-id 123456789012345 \
  --api-version v23.0 \
  --allowlist whatsapp:15551234567
odinn config channel enable business
```

WhatsApp supports direct text, media identifiers/links, replies, reactions,
and interactive reply buttons. It does not claim unsupported message editing
or arbitrary group-chat behavior. The Graph API version is explicit in
configuration so operators can advance it deliberately.

For Teams and WhatsApp, expose only the exact webhook path through a trusted
TLS reverse proxy. Keep the console and all control-plane routes private.
