import {
  APPLICATION_CONTRACT_VERSION,
  type ExecutionRequestV1
} from "../contracts.ts";
import { finish } from "./canonical-json.ts";
import { executionContext } from "./execution-context.ts";
import {
  enumValue,
  exactObject,
  identifier,
  jsonValue,
  reference,
  versionAndKind
} from "./json-safety.ts";

export function validateExecutionRequestV1(input: unknown): ExecutionRequestV1 {
  const value = exactObject(input, "execution request", [
    "version", "kind", "requestId", "context", "operation", "input", "responseMode", "idempotencyKey", "approvalReference"
  ]);
  versionAndKind(value, "execution-request");
  const operation = exactObject(value.operation, "operation", ["kind", "id"]);
  const request: ExecutionRequestV1 = {
    version: APPLICATION_CONTRACT_VERSION,
    kind: "execution-request",
    requestId: identifier(value.requestId, "requestId"),
    context: executionContext(value.context),
    operation: {
      kind: enumValue(operation.kind, "operation.kind", ["query", "tool", "agent", "skill", "mcp-tool", "workflow-node"]),
      id: identifier(operation.id, "operation.id")
    },
    input: jsonValue(value.input, "input"),
    responseMode: enumValue(value.responseMode, "responseMode", ["sync", "async", "stream"]),
    ...(value.idempotencyKey === undefined ? {} : { idempotencyKey: identifier(value.idempotencyKey, "idempotencyKey") }),
    ...(value.approvalReference === undefined ? {} : { approvalReference: reference(value.approvalReference, "approvalReference") })
  };
  return finish(request);
}
