import type { MoveChainResponse } from '../../web/src/api-schema.d.ts';

export function moveAcknowledged(ack: MoveChainResponse | undefined, operation: string, root: string, topic: string,
  expected: number, generation: string) {
  if (!ack) return false;
  const event = ack.move_seq;
  return typeof event === 'number' && Number.isSafeInteger(event) && event > expected && ack.operation_version === event &&
    ack.chain_version === event && ack.operation_id === operation && ack.root_id === root &&
    ack.destination_topic_id === topic && ack.topic_id === topic && ack.history_generation === generation;
}
