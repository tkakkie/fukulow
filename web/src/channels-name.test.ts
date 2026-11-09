import openapiRaw from '../../openapi.json?raw'
import { describe, expect, it } from 'vitest'
import { CHANNEL_NAME_MAX, channelNameTooLong } from './channels'

const samples: [string, string][] = [
  ['ASCII', 'a'],
  ['CJK', '漢'],
  ['4-byte', '😀'],
]

describe('channel name limit', () => {
  it('equals openapi.json maxLength', () => {
    const spec = JSON.parse(openapiRaw)
    expect(spec.components.schemas.CreateChannelRequest.properties.name.maxLength).toBe(CHANNEL_NAME_MAX)
  })
  for (const [label, ch] of samples) {
    it(`${label}: 127 and 128 pass, 129 fails`, () => {
      expect(channelNameTooLong(ch.repeat(127))).toBeNull()
      expect(channelNameTooLong(ch.repeat(128))).toBeNull()
      expect(channelNameTooLong(ch.repeat(129))).toMatch(/128/)
    })
  }
})
