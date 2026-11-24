/** State the observer-read test page exposes as `globalThis.observerRead`; no imports, so both the page and the spec use it. */
export type ObserverReadProbe = {
  /** Every seq the stand-in has applied as presented: all reporters until `stop()`, then the observer callback only. */
  presented: number[]
  /** Seqs applied after `stop()`; all of them came from inside the row window's IntersectionObserver callback. */
  afterStop: number[]
  /** Seqs of rows that were intersecting targets of an observer callback whose report was applied after `stop()`. */
  firedAfterStop: number[]
  /** The production Unread rule (`sequenceToSubmit`) over `presented`: the stand-in for the visit's read_seq. */
  readSeq: number
  /** `presented` calls after `stop()` from any other caller (scroll handler, effects); counted and never applied. */
  otherReports: number
  /** Every confirmed seq that has been in the DOM, in mount order. */
  everMounted: number[]
  /** Native `scroll` / `scrollend` events on the Timeline scroller. */
  scrolls: number
  scrollEnds: number
  /** Set by `stop()`: the state when scrolling had stopped. */
  stopped: { mounted: number[]; scrolls: number; scrollEnds: number; readSeq: number } | null
}
