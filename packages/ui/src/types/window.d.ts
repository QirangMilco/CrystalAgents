export {}

declare global {
  interface Window {
    electronAPI?: {
      debugLog?: (...args: unknown[]) => void | Promise<void>
    }
    process?: {
      env?: {
        CRAFT_DEBUG_STREAMING_STEPS?: string
        CRAFT_DEBUG_TOOL_TITLES?: string
        NODE_ENV?: string
        [key: string]: string | undefined
      }
    }
  }
}
