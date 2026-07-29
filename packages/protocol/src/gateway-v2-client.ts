import {
  GATEWAY_PROTOCOL_VERSION,
  GatewayValidationError,
  validateAuthorizedGatewayEvent,
  validateGatewayEvent,
  validateGatewayRequest,
  validateGatewayResponse,
  type GatewayEventFrame,
  type GatewayEventDiscovery,
  type GatewayJsonValue,
  type GatewayRequestFrame,
  type GatewayResponseFrame
} from "./gateway-v2.ts";

export type GatewayV2Exchange = (request: GatewayRequestFrame) => Promise<unknown>;
export type GatewayV2EventAuthorization = {
  events: readonly GatewayEventDiscovery[];
  grantedScopes: readonly string[];
};

export class GatewayV2Client {
  readonly #exchange: GatewayV2Exchange;
  #nextRequestId = 1;
  #lastEventSequence = -1;

  constructor(exchange: GatewayV2Exchange) {
    this.#exchange = exchange;
  }

  async request(
    method: string,
    params?: GatewayJsonValue,
    options: { idempotencyKey?: string; traceparent?: string } = {}
  ): Promise<GatewayJsonValue> {
    const id = `request-${this.#nextRequestId++}`;
    const request: GatewayRequestFrame = {
      v: GATEWAY_PROTOCOL_VERSION,
      type: "request",
      id,
      method
    };
    if (params !== undefined) request.params = params;
    if (options.idempotencyKey !== undefined) request.idempotencyKey = options.idempotencyKey;
    if (options.traceparent !== undefined) request.traceparent = options.traceparent;

    const outbound = validateGatewayRequest(request);
    const response: GatewayResponseFrame = validateGatewayResponse(await this.#exchange(outbound));
    if (response.id !== id) throw new GatewayValidationError("RESPONSE_ID_MISMATCH", "response id does not match request id");
    if (response.error) {
      throw new GatewayValidationError(
        response.error.code,
        response.error.message,
        response.error.retryable,
        response.error.retryAfterMs,
        response.error.details
      );
    }
    return response.result as GatewayJsonValue;
  }

  /**
   * Without authorization metadata, input must already have passed the
   * authenticated transport's validateAuthorizedGatewayEvent boundary.
   */
  acceptEvent(input: unknown, authorization?: GatewayV2EventAuthorization): GatewayEventFrame {
    const event = authorization
      ? validateAuthorizedGatewayEvent(input, {
          ...authorization,
          previousSequence: this.#lastEventSequence
        })
      : validateGatewayEvent(input, { previousSequence: this.#lastEventSequence });
    this.#lastEventSequence = event.sequence;
    return event;
  }

  get replayCursor(): string | undefined {
    return this.#lastEventSequence < 0 ? undefined : `v2:${this.#lastEventSequence}`;
  }
}
