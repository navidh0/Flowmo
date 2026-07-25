import type { FlowdoApi } from '@shared/types'

declare global {
  interface Window {
    flowdo: FlowdoApi
  }
}

export {}
