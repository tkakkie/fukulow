// Server-side read and close evidence for a target TCP proxy.
export type StallRecord = {
  reads: { at: number; bytes: number }[]; // bytes read from the server side
  pausedAt: number[]; resumedAt: number[];
  closes: { at: number; side: 'client' | 'upstream' }[];
};

/** Bytes read from the server side in [from, to). */
export const bytesBetween = (record: StallRecord, from: number, to: number) =>
  record.reads.filter(read => read.at >= from && read.at < to).reduce((sum, read) => sum + read.bytes, 0);
