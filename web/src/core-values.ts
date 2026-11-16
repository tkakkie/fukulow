import type { Input } from './protocol-types'
export const createValues = () => ({
  coreId: (id: string) => id,
  coreInput: (input: Input) => input,
  coreOutput: <T>(output: T): T => output,
})
