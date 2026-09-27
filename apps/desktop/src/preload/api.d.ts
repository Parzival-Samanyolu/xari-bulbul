import type { HarnessApi } from '../shared/ipc'

declare global {
  interface Window {
    harness: HarnessApi
  }
}

export {}
