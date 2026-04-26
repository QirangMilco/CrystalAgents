import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import type { CustomEndpointApi } from '@craft-agent/shared/config/llm-connections'
import type { RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from './handler-deps'

export const GUI_HANDLED_CHANNELS = [
  RPC_CHANNELS.power.SET_KEEP_AWAKE,
  RPC_CHANNELS.settings.SET_NETWORK_PROXY,
  RPC_CHANNELS.settings.FETCH_CUSTOM_ENDPOINT_MODELS,
] as const

function joinUrl(baseUrl: string, path: string): string {
  const normalizedBase = baseUrl.replace(/\/+$/, '')
  const normalizedPath = path.replace(/^\/+/, '')
  return `${normalizedBase}/${normalizedPath}`
}

function redactAuthorizationHeader(value: string): string {
  if (!value.trim()) return value
  const bearerPrefix = 'Bearer '
  if (!value.startsWith(bearerPrefix)) return '[redacted]'
  const token = value.slice(bearerPrefix.length)
  if (token.length <= 8) return `${bearerPrefix}[redacted]`
  return `${bearerPrefix}${token.slice(0, 4)}…${token.slice(-4)}`
}

// ============================================================
// GUI-only settings (require Electron-specific APIs)
// ============================================================

export function registerSettingsGuiHandlers(server: RpcServer, deps: HandlerDeps): void {
  // Set keep awake while running setting (requires Electron power-manager)
  server.handle(RPC_CHANNELS.power.SET_KEEP_AWAKE, async (_ctx, enabled: boolean) => {
    const { setKeepAwakeWhileRunning } = await import('@craft-agent/shared/config/storage')
    const { setKeepAwakeSetting } = await import('../power-manager')
    // Save to config
    setKeepAwakeWhileRunning(enabled)
    // Update the power manager's cached value and power state
    setKeepAwakeSetting(enabled)
  })

  // Set network proxy settings (requires Electron session proxy)
  server.handle(RPC_CHANNELS.settings.SET_NETWORK_PROXY, async (_ctx, settings: import('@craft-agent/shared/config/types').NetworkProxySettings) => {
    const { updateConfiguredProxySettings } = await import('../network-proxy')
    await updateConfiguredProxySettings(settings)
  })

  // Manually fetch custom endpoint models via main-process proxy to avoid renderer CORS/network restrictions.
  server.handle(
    RPC_CHANNELS.settings.FETCH_CUSTOM_ENDPOINT_MODELS,
    async (_ctx, params: { customApi: CustomEndpointApi; baseUrl: string; apiKey?: string; modelsUrl?: string; existingConnectionSlug?: string }) => {
      const endpoint = params.modelsUrl?.trim()
        || (params.customApi === 'anthropic-messages'
          ? joinUrl(params.baseUrl, '/v1/models')
          : joinUrl(params.baseUrl, '/models'))

      const credentialApiKey = params.apiKey?.trim()
        ? params.apiKey.trim()
        : params.existingConnectionSlug
          ? await (await import('@craft-agent/shared/credentials')).getCredentialManager().getLlmApiKey(params.existingConnectionSlug)
          : null

      const headers: Record<string, string> = {
        Accept: 'application/json',
      }
      if (credentialApiKey?.trim()) {
        headers.Authorization = `Bearer ${credentialApiKey.trim()}`
      }
      if (params.customApi === 'anthropic-messages') {
        headers['anthropic-version'] = '2023-06-01'
      }

      deps.platform.logger.info('[fetch-models-proxy] request', {
        customApi: params.customApi,
        method: 'GET',
        endpoint,
        headers: {
          ...headers,
          ...(headers.Authorization ? { Authorization: redactAuthorizationHeader(headers.Authorization) } : {}),
        },
        hasApiKey: !!credentialApiKey?.trim(),
        usedStoredApiKey: !params.apiKey?.trim() && !!credentialApiKey?.trim(),
        existingConnectionSlug: params.existingConnectionSlug ?? null,
        usedCustomModelsUrl: !!params.modelsUrl?.trim(),
      })

      let response: Response
      try {
        response = await fetch(endpoint, { headers })
      } catch (error) {
        deps.platform.logger.warn('[fetch-models-proxy] network-error', {
          customApi: params.customApi,
          endpoint,
          error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error),
        })
        throw new Error('network')
      }

      if (!response.ok) {
        deps.platform.logger.warn('[fetch-models-proxy] http-error', {
          customApi: params.customApi,
          endpoint,
          status: response.status,
          statusText: response.statusText,
        })
        throw new Error(`http:${response.status}`)
      }

      const payload = await response.json()
      deps.platform.logger.info('[fetch-models-proxy] response', {
        customApi: params.customApi,
        endpoint,
        status: response.status,
        payload,
      })
      return payload
    },
  )
}
