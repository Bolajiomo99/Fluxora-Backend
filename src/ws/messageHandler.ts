import { z } from 'zod';
import type { StreamEventReplayFilter } from '../db/types.js';
import { STELLAR_PUBLIC_KEY_REGEX } from '../validation/schemas.js';

const MAX_FILTER_VALUE_LENGTH = 256;

const streamIdSchema = z.string().trim().min(1).max(MAX_FILTER_VALUE_LENGTH);
const recipientAddressSchema = z
  .string()
  .trim()
  .regex(STELLAR_PUBLIC_KEY_REGEX, 'recipient_address must be a valid Stellar public key');

const subscriptionFilterSchema = z.object({
  stream_id: streamIdSchema.optional(),
  streamId: streamIdSchema.optional(),
  recipient_address: recipientAddressSchema.optional(),
  recipientAddress: recipientAddressSchema.optional(),
}).passthrough();

const subscriptionMessageSchema = z.object({
  type: z.enum(['subscribe', 'unsubscribe']),
  stream_id: streamIdSchema.optional(),
  streamId: streamIdSchema.optional(),
  recipient_address: recipientAddressSchema.optional(),
  recipientAddress: recipientAddressSchema.optional(),
  filter: subscriptionFilterSchema.optional(),
}).passthrough();

const replayMessageSchema = z.object({
  type: z.literal('replay'),
  afterEventId: z.string().trim().min(1).optional(),
  fromLedger: z.number().int().nonnegative().optional(),
  toledger: z.number().int().nonnegative().optional(),
  contractId: z.string().trim().min(1).max(MAX_FILTER_VALUE_LENGTH).optional(),
  topic: z.string().trim().min(1).max(MAX_FILTER_VALUE_LENGTH).optional(),
  limit: z.number().int().positive().max(1000).optional(),
}).passthrough();

export interface SubscriptionFilter {
  streamId?: string;
  recipientAddress?: string;
}

export type WsClientMessage =
  | { type: 'subscribe'; filter: SubscriptionFilter }
  | { type: 'unsubscribe'; filter: SubscriptionFilter }
  | { type: 'replay'; filter: StreamEventReplayFilter };

export type WsMessageParseResult =
  | { ok: true; message: WsClientMessage }
  | { ok: false; code: 'UNKNOWN_TYPE' | 'INVALID_MESSAGE'; message: string };

export type HandshakeSubscriptionParseResult =
  | { ok: true; filter: SubscriptionFilter | null }
  | { ok: false; message: string };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function firstConsistentValue(values: Array<string | undefined>, field: string): string | undefined {
  const defined = values.filter((value): value is string => value !== undefined);
  if (defined.length === 0) return undefined;

  const [first] = defined;
  if (defined.some((value) => value !== first)) {
    throw new Error(`${field} aliases must not contain conflicting values`);
  }

  return first;
}

function normalizeSubscriptionFilter(
  value: z.infer<typeof subscriptionMessageSchema>,
): SubscriptionFilter {
  const streamId = firstConsistentValue(
    [
      value.stream_id,
      value.streamId,
      value.filter?.stream_id,
      value.filter?.streamId,
    ],
    'stream_id',
  );

  const recipientAddress = firstConsistentValue(
    [
      value.recipient_address,
      value.recipientAddress,
      value.filter?.recipient_address,
      value.filter?.recipientAddress,
    ],
    'recipient_address',
  );

  if (streamId !== undefined && recipientAddress !== undefined) {
    throw new Error('subscription filter accepts either stream_id or recipient_address, not both');
  }

  if (streamId !== undefined) return { streamId };
  if (recipientAddress !== undefined) return { recipientAddress };

  if (value.filter !== undefined) return {};

  throw new Error('subscribe and unsubscribe messages require stream_id, recipient_address, or an explicit empty filter');
}

function normalizeReplayFilter(value: z.infer<typeof replayMessageSchema>): StreamEventReplayFilter {
  return {
    ...(value.afterEventId !== undefined ? { afterEventId: value.afterEventId } : {}),
    ...(value.fromLedger !== undefined ? { fromLedger: value.fromLedger } : {}),
    ...(value.toledger !== undefined ? { toledger: value.toledger } : {}),
    ...(value.contractId !== undefined ? { contractId: value.contractId } : {}),
    ...(value.topic !== undefined ? { topic: value.topic } : {}),
    ...(value.limit !== undefined ? { limit: value.limit } : {}),
  };
}

function validationMessage(issues: z.ZodIssue[]): string {
  return issues[0]?.message ?? 'Invalid WebSocket message';
}

export function parseWsClientMessage(raw: unknown): WsMessageParseResult {
  if (!isObject(raw)) {
    return { ok: false, code: 'INVALID_MESSAGE', message: 'Message must be a JSON object' };
  }

  if (typeof raw.type !== 'string') {
    return { ok: false, code: 'INVALID_MESSAGE', message: 'type must be a string' };
  }

  if (raw.type === 'subscribe' || raw.type === 'unsubscribe') {
    const result = subscriptionMessageSchema.safeParse(raw);
    if (!result.success) {
      return { ok: false, code: 'INVALID_MESSAGE', message: validationMessage(result.error.issues) };
    }

    try {
      return {
        ok: true,
        message: {
          type: result.data.type,
          filter: normalizeSubscriptionFilter(result.data),
        },
      };
    } catch (error) {
      return {
        ok: false,
        code: 'INVALID_MESSAGE',
        message: error instanceof Error ? error.message : 'Invalid subscription filter',
      };
    }
  }

  if (raw.type === 'replay') {
    const result = replayMessageSchema.safeParse(raw);
    if (!result.success) {
      return { ok: false, code: 'INVALID_MESSAGE', message: validationMessage(result.error.issues) };
    }

    return {
      ok: true,
      message: {
        type: 'replay',
        filter: normalizeReplayFilter(result.data),
      },
    };
  }

  return { ok: false, code: 'UNKNOWN_TYPE', message: `Unknown message type: ${raw.type}` };
}

export function parseHandshakeSubscriptionFilter(url: string): HandshakeSubscriptionParseResult {
  const params = new URL(url, 'ws://localhost').searchParams;
  const streamId = params.get('stream_id') ?? params.get('streamId');
  const recipientAddress = params.get('recipient_address') ?? params.get('recipientAddress');

  if (streamId === null && recipientAddress === null) {
    return { ok: true, filter: null };
  }

  const input: Record<string, unknown> = {
    type: 'subscribe',
  };
  if (streamId !== null) input['stream_id'] = streamId;
  if (recipientAddress !== null) input['recipient_address'] = recipientAddress;

  const result = parseWsClientMessage(input);
  if (!result.ok) {
    return { ok: false, message: result.message };
  }

  if (result.message.type !== 'subscribe') {
    return { ok: false, message: 'Handshake filter must be a subscribe filter' };
  }

  return { ok: true, filter: result.message.filter };
}
