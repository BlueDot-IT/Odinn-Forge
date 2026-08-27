type JsonSchema = Readonly<Record<string, unknown>>;

function freezeSchema<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) freezeSchema(child);
  }
  return value;
}

const EMAIL_READ_INPUT_SCHEMAS = freezeSchema({
  "email.accounts": { type: "object", properties: {}, additionalProperties: false },
  "email.search": {
    type: "object",
    properties: {
      accountId: { type: "string", minLength: 1, maxLength: 256 },
      query: { type: "string", minLength: 1, maxLength: 2_048 },
      limit: { type: "integer", minimum: 1, maximum: 100 },
      cursor: { type: "string", minLength: 1, maxLength: 4_096 }
    },
    required: ["accountId", "query"],
    additionalProperties: false
  },
  "email.read": {
    type: "object",
    properties: {
      accountId: { type: "string", minLength: 1, maxLength: 256 },
      messageId: { type: "string", minLength: 1, maxLength: 256 }
    },
    required: ["accountId", "messageId"],
    additionalProperties: false
  },
  "email.thread": {
    type: "object",
    properties: {
      accountId: { type: "string", minLength: 1, maxLength: 256 },
      threadId: { type: "string", minLength: 1, maxLength: 256 },
      limit: { type: "integer", minimum: 1, maximum: 100 }
    },
    required: ["accountId", "threadId"],
    additionalProperties: false
  }
} satisfies Record<string, JsonSchema>);

const CALENDAR_READ_INPUT_SCHEMAS = freezeSchema({
  "calendar.calendars": {
    type: "object",
    properties: { accountId: { type: "string", minLength: 1, maxLength: 256 } },
    required: ["accountId"],
    additionalProperties: false
  },
  "calendar.events": {
    type: "object",
    properties: {
      accountId: { type: "string", minLength: 1, maxLength: 256 },
      calendarId: { type: "string", minLength: 1, maxLength: 256 },
      start: { type: "string", minLength: 20, maxLength: 64 },
      end: { type: "string", minLength: 20, maxLength: 64 },
      limit: { type: "integer", minimum: 1, maximum: 100 }
    },
    required: ["accountId", "calendarId", "start", "end"],
    additionalProperties: false
  },
  "calendar.read": {
    type: "object",
    properties: {
      accountId: { type: "string", minLength: 1, maxLength: 256 },
      calendarId: { type: "string", minLength: 1, maxLength: 256 },
      eventId: { type: "string", minLength: 1, maxLength: 256 }
    },
    required: ["accountId", "calendarId", "eventId"],
    additionalProperties: false
  }
} satisfies Record<string, JsonSchema>);

const LIVE_ONLY_PROVIDER_INPUT_SCHEMAS: Readonly<Record<string, JsonSchema>> = Object.freeze({
  ...EMAIL_READ_INPUT_SCHEMAS,
  ...CALENDAR_READ_INPUT_SCHEMAS
});

/**
 * Return the immutable public request schema for a built-in live-only provider
 * tool. These contracts exist independently of integration activation so a
 * completed-run lookup cannot bypass live semantic validation.
 */
export function liveOnlyProviderInputSchema(toolName: unknown): JsonSchema | undefined {
  return typeof toolName === "string" ? LIVE_ONLY_PROVIDER_INPUT_SCHEMAS[toolName] : undefined;
}
