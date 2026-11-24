/** State the observer-read test page exposes as `globalThis.observerRead`; no imports, so both the page and the spec use it. */
export type ObserverReadProbe = {
  /** Message seqs that reached `presented` while the row window's IntersectionObserver callback was running. */
  observerSeqs: number[]
  /** Highest seq in `observerSeqs`: the test stand-in for the Unread controller's read_seq. */
  readSeq: number
  /** `presented` calls from any other caller (scroll handler, effects); recorded and never applied. */
  otherReports: number
  /** Every confirmed seq that has been in the DOM, in mount order. */
  everMounted: number[]
  scrollEnds: number
}
