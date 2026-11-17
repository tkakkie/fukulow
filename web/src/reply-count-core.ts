/** Count protocol intents/views, not REST shapes. HTTP batches stay in the controller. */
export type CountTicket = { root: string; generation: number }
export type CountInput =
  | { type: 'track'; roots: string[] }
  | { type: 'reset' }
  | { type: 'begin'; tickets: CountTicket[] }
  | { type: 'failed'; tickets: CountTicket[] }
  | { type: 'install'; ticket: CountTicket; watermark: number; count: number }
  | { type: 'create'; root: string; id: string; seq: number }
  | { type: 'invalidate'; root: string; seq: number }
  | { type: 'seed'; root: string; seq: number }
export type CountView = { counts: Record<string, number | null>; needed: CountTicket[]; tickets: CountTicket[] }
export type CountCore = { step(input: CountInput): CountView; free(): void }
