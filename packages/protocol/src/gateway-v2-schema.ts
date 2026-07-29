export const GATEWAY_V2_JSON_SCHEMA = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://odinn.dev/schema/gateway-v2.schema.json",
  "title": "Odinn Gateway Protocol v2 Frame",
  "oneOf": [
    { "$ref": "#/$defs/request" },
    { "$ref": "#/$defs/response" },
    { "$ref": "#/$defs/event" }
  ],
  "$defs": {
    "traceparent": {
      "type": "string",
      "pattern": "^00-(?!0{32})[0-9a-f]{32}-(?!0{16})[0-9a-f]{16}-[0-9a-f]{2}$"
    },
    "identifier": {
      "type": "string",
      "pattern": "^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$"
    },
    "error": {
      "type": "object",
      "additionalProperties": false,
      "required": ["code", "message", "retryable"],
      "allOf": [
        {
          "if": { "properties": { "retryable": { "const": false } }, "required": ["retryable"] },
          "then": { "not": { "required": ["retryAfterMs"] } }
        }
      ],
      "properties": {
        "code": { "type": "string", "pattern": "^[A-Z][A-Z0-9_]{0,63}$" },
        "message": { "type": "string", "minLength": 1, "maxLength": 4096 },
        "retryable": { "type": "boolean" },
        "retryAfterMs": { "type": "integer", "minimum": 0, "maximum": 9007199254740991 },
        "details": {}
      }
    },
    "request": {
      "type": "object",
      "additionalProperties": false,
      "required": ["v", "type", "id", "method"],
      "properties": {
        "v": { "const": 2 },
        "type": { "const": "request" },
        "id": { "$ref": "#/$defs/identifier" },
        "method": { "$ref": "#/$defs/identifier" },
        "params": {},
        "idempotencyKey": {
          "type": "string",
          "minLength": 8,
          "maxLength": 128,
          "pattern": "^[!-~]{8,128}$"
        },
        "traceparent": { "$ref": "#/$defs/traceparent" }
      }
    },
    "response": {
      "type": "object",
      "additionalProperties": false,
      "required": ["v", "type", "id"],
      "oneOf": [
        { "required": ["result"], "not": { "required": ["error"] } },
        { "required": ["error"], "not": { "required": ["result"] } }
      ],
      "properties": {
        "v": { "const": 2 },
        "type": { "const": "response" },
        "id": { "$ref": "#/$defs/identifier" },
        "result": {},
        "error": { "$ref": "#/$defs/error" },
        "traceparent": { "$ref": "#/$defs/traceparent" }
      }
    },
    "event": {
      "type": "object",
      "additionalProperties": false,
      "required": ["v", "type", "event", "sequence", "cursor"],
      "properties": {
        "v": { "const": 2 },
        "type": { "const": "event" },
        "event": { "$ref": "#/$defs/identifier" },
        "sequence": { "type": "integer", "minimum": 0, "maximum": 999999999999999 },
        "cursor": { "type": "string", "pattern": "^v2:(0|[1-9][0-9]{0,14})$" },
        "data": {},
        "traceparent": { "$ref": "#/$defs/traceparent" }
      }
    }
  }
} as const;

export function serializeGatewayV2JsonSchema(): string {
  return `${JSON.stringify(GATEWAY_V2_JSON_SCHEMA, null, 2)}\n`;
}
