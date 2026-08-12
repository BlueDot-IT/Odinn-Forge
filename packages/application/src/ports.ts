import type {
  ChannelDeliveryReceiptV1,
  ExecutionRequestV1,
  ExecutionResultV1,
  OutboundEnvelopeV1
} from "./contracts.ts";

/** Runtime-only controls are never serialized into application contracts. */
export interface ApplicationInvocationOptions {
  readonly signal?: AbortSignal;
}

export interface ExecutionPort {
  execute(request: ExecutionRequestV1, options?: ApplicationInvocationOptions): Promise<ExecutionResultV1>;
}

export interface ChannelPort {
  deliver(envelope: OutboundEnvelopeV1, options?: ApplicationInvocationOptions): Promise<ChannelDeliveryReceiptV1>;
}
