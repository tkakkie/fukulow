// Define the ordered case keys for receive measurements.
export const BULK_CASES = ['history_8x50', 'history_2x200', 'catchup_250', 'catchup_1000'] as const
export type BulkCase = typeof BULK_CASES[number]
export const A2_FRAMES = [250, 1000] as const
