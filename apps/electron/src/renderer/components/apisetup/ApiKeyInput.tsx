/**
 * ApiKeyInput - Reusable API key entry form control
 *
 * Renders a password input for the API key, a preset selector for Base URL,
 * and an optional Model override field.
 *
 * Does NOT include layout wrappers or action buttons — the parent
 * controls placement via the form ID ("api-key-form") for submit binding.
 *
 * Used in: Onboarding CredentialsStep, Settings API dialog
 */

import { useState, useEffect, useCallback, useRef } from "react"
import { useTranslation } from "react-i18next"
import { Command as CommandPrimitive } from "cmdk"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
} from "@/components/ui/styled-dropdown"
import { cn } from "@/lib/utils"
import { Check, ChevronDown, Eye, EyeOff, Loader2, Plus, RefreshCw, Trash2 } from "lucide-react"
import { pickTierDefaults, resolveTierModels, type PiModelInfo } from "./tier-models"
import {
  deriveDefaultModelsUrl,
  resolvePiAuthProviderForSubmit,
  resolvePresetStateForBaseUrlChange,
  type PresetKey,
} from "./submit-helpers"

import type { CustomEndpointApi, CustomEndpointConfig } from '@config/llm-connections'
import type { ModelDefinition } from '@config/models'

export type ApiKeyStatus = 'idle' | 'validating' | 'success' | 'error'

export type { CustomEndpointApi }

type SubmitModel = string | ModelDefinition

type CustomModelRow = {
  id: string
  contextWindow: string
}

export interface ApiKeySubmitData {
  apiKey: string
  baseUrl?: string
  connectionDefaultModel?: string
  miniModel?: string
  models?: SubmitModel[]
  contextWindow?: number
  piAuthProvider?: string
  modelSelectionMode?: 'automaticallySyncedFromProvider' | 'userDefined3Tier'
  /** Custom endpoint protocol — set when user configures an arbitrary API endpoint */
  customEndpoint?: CustomEndpointConfig
  /** IAM credentials for Pi+Bedrock (piAuthProvider='amazon-bedrock') setup */
  iamCredentials?: {
    accessKeyId: string
    secretAccessKey: string
    sessionToken?: string
  }
  /** AWS region for Pi+Bedrock */
  awsRegion?: string
  /** Bedrock authentication method — determines auth type for Pi+Bedrock connections */
  bedrockAuthMethod?: 'iam_credentials' | 'environment'
}

export interface ApiKeyInputProps {
  /** Current validation status */
  status: ApiKeyStatus
  /** Error message to display when status is 'error' */
  errorMessage?: string
  /** Called when the form is submitted with the key and optional endpoint config */
  onSubmit: (data: ApiKeySubmitData) => void
  /** Form ID for external submit button binding (default: "api-key-form") */
  formId?: string
  /** Disable the input (e.g. during validation) */
  disabled?: boolean
  /** Provider type determines which presets and placeholders to show */
  providerType?: 'anthropic' | 'openai' | 'pi' | 'google' | 'pi_api_key'
  /** Existing connection slug when editing; used only for secure main-process key reuse. */
  existingConnectionSlug?: string
  /** Pre-fill values when editing an existing connection */
  initialValues?: {
    apiKey?: string
    baseUrl?: string
    connectionDefaultModel?: string
    miniModel?: string
    activePreset?: string
    models?: SubmitModel[]
    contextWindow?: number
    /** Pre-fill the protocol toggle for custom endpoints */
    customApi?: CustomEndpointApi
    modelsUrl?: string
  }
}

interface Preset {
  key: PresetKey
  label: string
  url: string
  placeholder?: string
}

// Anthropic provider presets - for Claude Code backend
// Also used by Pi API key flow (same providers, routed via Pi SDK)
const ANTHROPIC_PRESETS: Preset[] = [
  { key: 'anthropic', label: 'Anthropic', url: 'https://api.anthropic.com', placeholder: 'sk-ant-...' },
  { key: 'openai', label: 'OpenAI', url: 'https://api.openai.com/v1', placeholder: 'sk-...' },
  { key: 'openai-eu', label: 'OpenAI EU', url: 'https://eu.api.openai.com/v1', placeholder: 'sk-...' },
  { key: 'openai-us', label: 'OpenAI US', url: 'https://us.api.openai.com/v1', placeholder: 'sk-...' },
  { key: 'google', label: 'Google AI Studio', url: 'https://generativelanguage.googleapis.com/v1beta', placeholder: 'AIza...' },
  { key: 'openrouter', label: 'OpenRouter', url: 'https://openrouter.ai/api/v1', placeholder: 'sk-or-...' },
  { key: 'azure-openai-responses', label: 'Azure OpenAI', url: '', placeholder: 'Paste your key here...' },
  { key: 'amazon-bedrock', label: 'Amazon Bedrock', url: 'https://bedrock-runtime.us-east-1.amazonaws.com', placeholder: 'AKIA...' },
  { key: 'groq', label: 'Groq', url: 'https://api.groq.com/openai/v1', placeholder: 'gsk_...' },
  { key: 'mistral', label: 'Mistral', url: 'https://api.mistral.ai/v1', placeholder: 'Paste your key here...' },
  { key: 'deepseek', label: 'DeepSeek', url: 'https://api.deepseek.com', placeholder: 'sk-...' },
  { key: 'xai', label: 'xAI (Grok)', url: 'https://api.x.ai/v1', placeholder: 'xai-...' },
  { key: 'cerebras', label: 'Cerebras', url: 'https://api.cerebras.ai/v1', placeholder: 'csk-...' },
  { key: 'zai', label: 'z.ai (GLM)', url: 'https://api.z.ai/api/coding/paas/v4', placeholder: 'Paste your key here...' },
  { key: 'huggingface', label: 'Hugging Face', url: 'https://router.huggingface.co/v1', placeholder: 'hf_...' },
  { key: 'minimax-global', label: 'Minimax Global', url: 'https://api.minimax.io/anthropic', placeholder: 'Paste your key here...' },
  { key: 'minimax-cn', label: 'Minimax CN', url: 'https://api.minimaxi.com/anthropic', placeholder: 'Paste your key here...' },
  { key: 'kimi-coding', label: 'Kimi (Coding)', url: 'https://api.kimi.com/coding', placeholder: 'sk-kimi-...' },
  { key: 'vercel-ai-gateway', label: 'Vercel AI Gateway', url: 'https://ai-gateway.vercel.sh', placeholder: 'Paste your key here...' },
  { key: 'custom', label: 'Custom', url: '', placeholder: 'Paste your key here...' },
]

// OpenAI provider presets - for Codex backend
// Only direct OpenAI is supported; 3PP providers (OpenRouter, Vercel, Ollama) should be
// configured via the Anthropic/Claude connection which routes through the Claude Agent SDK.
const OPENAI_PRESETS: Preset[] = [
  { key: 'openai', label: 'OpenAI', url: '' },
]

// Pi provider presets - unified API for 20+ LLM providers
const PI_PRESETS: Preset[] = [
  { key: 'pi', label: 'Craft Agents Backend (Direct)', url: '' },
  { key: 'openrouter', label: 'OpenRouter', url: 'https://openrouter.ai/api' },
  { key: 'custom', label: 'Custom', url: '' },
]

// Google AI Studio preset - single endpoint, no custom URL needed
const GOOGLE_PRESETS: Preset[] = [
  { key: 'google', label: 'Google AI Studio', url: '' },
]

/** Presets that require the Pi SDK for authentication — hidden in Anthropic API Key mode */
const PI_ONLY_PRESET_KEYS: ReadonlySet<string> = new Set(['minimax-global', 'minimax-cn'])

const COMPAT_ANTHROPIC_DEFAULTS = 'claude-opus-4-7, claude-sonnet-4-6, claude-haiku-4-5'
const COMPAT_OPENAI_DEFAULTS = 'openai/gpt-5.2-codex, openai/gpt-5.1-codex-mini'
const COMPAT_MINIMAX_DEFAULTS = 'MiniMax-M2.5, MiniMax-M2.5-highspeed'
const COMPAT_KIMI_DEFAULTS = 'k2p5, kimi-k2-thinking'

function getPresetsForProvider(providerType: 'anthropic' | 'openai' | 'pi' | 'google' | 'pi_api_key'): Preset[] {
  if (providerType === 'pi_api_key') return ANTHROPIC_PRESETS
  if (providerType === 'google') return GOOGLE_PRESETS
  if (providerType === 'pi') return PI_PRESETS
  if (providerType === 'openai') return OPENAI_PRESETS
  // Anthropic mode: exclude presets that only work via Pi SDK
  return ANTHROPIC_PRESETS.filter(p => !PI_ONLY_PRESET_KEYS.has(p.key))
}

function getPresetForUrl(url: string, presets: Preset[]): PresetKey {
  const match = presets.find(p => p.key !== 'custom' && p.url === url)
  return match?.key ?? 'custom'
}

function parseModelList(value: string): SubmitModel[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const match = entry.match(/^(.+?)\s*@\s*(\d+)$/)
      if (!match?.[1] || !match?.[2]) return entry
      return {
        id: match[1].trim(),
        contextWindow: Number(match[2]),
      } satisfies ModelDefinition
    })
}

function getSubmitModelId(model: SubmitModel | undefined): string | undefined {
  return typeof model === 'string' ? model : model?.id
}

function submitModelToRow(model: SubmitModel): CustomModelRow {
  return typeof model === 'string'
    ? { id: model, contextWindow: '' }
    : { id: model.id, contextWindow: model.contextWindow ? String(model.contextWindow) : '' }
}

function rowToSubmitModel(row: CustomModelRow): SubmitModel | null {
  const id = row.id.trim()
  if (!id) return null
  const contextWindow = Number(row.contextWindow.trim())
  if (Number.isFinite(contextWindow) && contextWindow > 0) {
    return { id, contextWindow: Math.round(contextWindow) }
  }
  return id
}

function rowsToSubmitModels(rows: CustomModelRow[]): SubmitModel[] {
  return rows
    .map(rowToSubmitModel)
    .filter((model): model is SubmitModel => model != null)
}

function buildInitialCustomModelRows(initialValues?: ApiKeyInputProps['initialValues']): CustomModelRow[] {
  if (initialValues?.models?.length) {
    return initialValues.models.map(submitModelToRow)
  }
  const parsed = parseModelList(initialValues?.connectionDefaultModel ?? '')
  return parsed.length > 0 ? parsed.map(submitModelToRow) : [{ id: '', contextWindow: '' }]
}

function normalizeCustomApi(api?: string): CustomEndpointApi {
  if (api === 'anthropic-messages') return 'anthropic-messages'
  if (api === 'openai-responses') return 'openai-responses'
  return 'openai-completions'
}

function isMaskedApiKey(value?: string): boolean {
  return !!value && value.includes('••')
}

async function fetchCustomEndpointModels(params: {
  baseUrl: string
  apiKey: string
  customApi: CustomEndpointApi
  modelsUrl?: string
  existingConnectionSlug?: string
}): Promise<string[]> {
  const endpoint = params.modelsUrl?.trim() || deriveDefaultModelsUrl(params.baseUrl, params.customApi)
  const headers: Record<string, string> = {
    Accept: 'application/json',
  }
  if (params.apiKey.trim()) {
    headers.Authorization = `Bearer ${params.apiKey.trim()}`
  }
  if (params.customApi === 'anthropic-messages') {
    headers['anthropic-version'] = '2023-06-01'
  }

  debugFetchModels('[fetch-models] request', {
    customApi: params.customApi,
    method: 'GET',
    endpoint,
    headers: {
      ...headers,
      ...(headers.Authorization ? { Authorization: redactAuthorizationHeader(headers.Authorization) } : {}),
    },
    hasApiKey: !!params.apiKey.trim(),
  })

  let payload: unknown
  try {
    payload = await window.electronAPI.fetchCustomEndpointModels({
      customApi: params.customApi,
      baseUrl: params.baseUrl,
      apiKey: params.apiKey,
      modelsUrl: params.modelsUrl,
      existingConnectionSlug: params.existingConnectionSlug,
    })
  } catch (error) {
    debugFetchModels('[fetch-models] proxy-error', {
      customApi: params.customApi,
      endpoint,
      error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error),
    })
    throw error
  }

  debugFetchModels('[fetch-models] response', {
    customApi: params.customApi,
    endpoint,
    payload,
  })
  const payloadRecord = payload && typeof payload === 'object' ? payload as { data?: unknown; models?: unknown } : null
  const entries = Array.isArray(payloadRecord?.data)
    ? payloadRecord.data
    : Array.isArray(payloadRecord?.models)
      ? payloadRecord.models
      : Array.isArray(payload)
        ? payload
        : []

  return entries
    .map((entry: unknown) => {
      if (typeof entry === 'string') return entry
      if (entry && typeof entry === 'object' && 'id' in entry && typeof (entry as { id?: unknown }).id === 'string') {
        return (entry as { id: string }).id
      }
      if (entry && typeof entry === 'object' && 'name' in entry && typeof (entry as { name?: unknown }).name === 'string') {
        return (entry as { name: string }).name
      }
      return null
    })
    .filter((id: string | null): id is string => !!id)
}

function getFetchCustomModelsErrorMessage(error: unknown, t: (key: string, options?: Record<string, unknown>) => string): string {
  if (error instanceof Error) {
    if (error.message === 'network') {
      return t('apiSetup.fetchModelsNetworkError')
    }
    if (error.message.startsWith('http:')) {
      const status = Number(error.message.slice(5))
      if (!Number.isNaN(status)) {
        return t('apiSetup.fetchModelsHttpError', { status })
      }
    }
  }
  return t('apiSetup.fetchModelsUnknownError')
}

function isFetchModelsDebugEnabled(): boolean {
  return (window as Window & { process?: { env?: Record<string, string | undefined> } }).process?.env?.CRAFT_DEBUG_FETCH_MODELS === '1'
}

function redactAuthorizationHeader(value: string): string {
  if (!value.trim()) return value
  const bearerPrefix = 'Bearer '
  if (!value.startsWith(bearerPrefix)) return '[redacted]'
  const token = value.slice(bearerPrefix.length)
  if (token.length <= 8) return `${bearerPrefix}[redacted]`
  return `${bearerPrefix}${token.slice(0, 4)}…${token.slice(-4)}`
}

function debugFetchModels(label: string, payload: Record<string, unknown>): void {
  if (!isFetchModelsDebugEnabled()) return
  void Promise.resolve(window.electronAPI.debugLog(label, payload)).catch(() => {})
}

// ============================================================
// Pi model tier selection (for providers with many models)
// ============================================================

export function ApiKeyInput({
  status,
  errorMessage,
  onSubmit,
  formId = "api-key-form",
  disabled,
  providerType = 'anthropic',
  existingConnectionSlug,
  initialValues,
}: ApiKeyInputProps) {
  // Get presets based on provider type
  const presets = getPresetsForProvider(providerType)
  const defaultPreset = presets[0]

  // Compute initial preset: explicit (Pi piAuthProvider), derived from URL, or default
  const initialPreset = initialValues?.activePreset
    ?? (initialValues?.baseUrl ? getPresetForUrl(initialValues.baseUrl, presets) : defaultPreset.key)

  const { t } = useTranslation()
  const initialApiKey = isMaskedApiKey(initialValues?.apiKey) ? '' : (initialValues?.apiKey ?? '')
  const [apiKey, setApiKey] = useState(initialApiKey)
  const [showValue, setShowValue] = useState(false)
  const [baseUrl, setBaseUrl] = useState(initialValues?.baseUrl ?? defaultPreset.url)
  const [activePreset, setActivePreset] = useState<PresetKey>(initialPreset)
  const [lastNonCustomPreset, setLastNonCustomPreset] = useState<PresetKey | null>(
    initialPreset !== 'custom' ? initialPreset : defaultPreset.key
  )
  const [connectionDefaultModel, setConnectionDefaultModel] = useState(initialValues?.connectionDefaultModel ?? '')
  const [customModelRows, setCustomModelRows] = useState<CustomModelRow[]>(() => buildInitialCustomModelRows(initialValues))
  const [contextWindowInput, setContextWindowInput] = useState(initialValues?.contextWindow ? String(initialValues.contextWindow) : '')
  const [customApi, setCustomApi] = useState<CustomEndpointApi>(normalizeCustomApi(initialValues?.customApi))
  const [isModelsUrlManuallyEdited, setIsModelsUrlManuallyEdited] = useState(!!initialValues?.modelsUrl?.trim())
  const [modelsUrl, setModelsUrl] = useState(() => initialValues?.modelsUrl?.trim() || deriveDefaultModelsUrl(initialValues?.baseUrl ?? defaultPreset.url, normalizeCustomApi(initialValues?.customApi)))
  const [modelError, setModelError] = useState<string | null>(null)
  const [customModelsLoading, setCustomModelsLoading] = useState(false)

  // Bedrock auth state
  const [bedrockAuthMethod, setBedrockAuthMethod] = useState<'iam_credentials' | 'environment'>('iam_credentials')
  const [awsAccessKeyId, setAwsAccessKeyId] = useState('')
  const [awsSecretAccessKey, setAwsSecretAccessKey] = useState('')
  const [awsSessionToken, setAwsSessionToken] = useState('')
  const [awsRegion, setAwsRegion] = useState('us-east-1')

  // Pi model tier state (for providers with many models like OpenRouter, Vercel)
  const [piModels, setPiModels] = useState<PiModelInfo[]>([])
  const [piModelsLoading, setPiModelsLoading] = useState(false)
  const [bestModel, setBestModel] = useState('')
  const [defaultModel, setDefaultModel] = useState('')
  const [cheapModel, setCheapModel] = useState('')
  const [openTier, setOpenTier] = useState<string | null>(null)
  const [tierFilter, setTierFilter] = useState('')
  const [tierDropdownPosition, setTierDropdownPosition] = useState<{ top: number; left: number; width: number } | null>(null)
  const tierFilterInputRef = useRef<HTMLInputElement>(null)
  const hydratedTierProviderRef = useRef<string | null>(null)

  const isDisabled = disabled || status === 'validating'

  const isPiApiKeyFlow = providerType === 'pi_api_key'
  const isBedrock = activePreset === 'amazon-bedrock'
  // Hide endpoint/model fields for providers with well-known endpoints handled by the SDK
  const DEFAULT_ENDPOINT_PROVIDERS = new Set(['anthropic', 'openai', 'pi', 'google'])
  const isDefaultProviderPreset = DEFAULT_ENDPOINT_PROVIDERS.has(activePreset)

  // Provider-specific placeholders from the active preset
  const activePresetObj = presets.find(p => p.key === activePreset)
  const apiKeyPlaceholder = activePresetObj?.placeholder
    ?? (providerType === 'google' ? 'AIza...'
    : providerType === 'pi' ? 'pi-...'
    : providerType === 'openai' ? 'sk-...'
    : 'Paste your key here...')

  // Fetch Pi SDK models when a provider is selected in pi_api_key flow.
  // Returns all models sorted by cost (expensive-first) for the searchable tier dropdowns.
  const loadPiModels = useCallback(async (provider: string) => {
    if (!isPiApiKeyFlow || !provider || provider === 'custom' || DEFAULT_ENDPOINT_PROVIDERS.has(provider)) {
      setPiModels([])
      return
    }
    setPiModelsLoading(true)
    try {
      const result = await window.electronAPI.getPiProviderModels(provider)
      setPiModels(result.models)

      if (hydratedTierProviderRef.current !== provider) {
        const tiers = resolveTierModels(result.models, provider === initialPreset ? initialValues?.models : undefined)
        setBestModel(tiers.best)
        setDefaultModel(tiers.default_)
        setCheapModel(tiers.cheap)
        hydratedTierProviderRef.current = provider
      }
    } catch (err) {
      console.error('[ApiKeyInput] Failed to load models for', provider, err)
      setPiModels([])
    } finally {
      setPiModelsLoading(false)
    }
  }, [isPiApiKeyFlow])

  useEffect(() => {
    loadPiModels(activePreset)
  }, [activePreset, loadPiModels])

  useEffect(() => {
    if (isModelsUrlManuallyEdited) return
    setModelsUrl(deriveDefaultModelsUrl(baseUrl, customApi))
  }, [baseUrl, customApi, isModelsUrlManuallyEdited])

  // Whether to show 3 tier dropdowns instead of text input
  const hasPiModels = isPiApiKeyFlow && piModels.length > 0 && !isDefaultProviderPreset && activePreset !== 'custom' && !isBedrock

  const handleFetchCustomModels = useCallback(async () => {
    const trimmedBaseUrl = baseUrl.trim()
    if (!trimmedBaseUrl) {
      setModelError(t('apiSetup.fetchModelsBaseUrlRequired'))
      return
    }

    setCustomModelsLoading(true)
    setModelError(null)
    try {
      const models = await fetchCustomEndpointModels({
        baseUrl: trimmedBaseUrl,
        apiKey,
        customApi,
        modelsUrl,
        existingConnectionSlug,
      })
      if (models.length === 0) {
        debugFetchModels('[fetch-models] parsed-models', {
          customApi,
          baseUrl: trimmedBaseUrl,
          modelCount: 0,
          models: [],
        })
        setModelError(t('apiSetup.fetchModelsEmpty'))
        return
      }
      debugFetchModels('[fetch-models] parsed-models', {
        customApi,
        baseUrl: trimmedBaseUrl,
        modelCount: models.length,
        models,
      })
      setCustomModelRows(models.map((id) => ({ id, contextWindow: '' })))
      setConnectionDefaultModel(models[0] ?? '')
    } catch (error) {
      debugFetchModels('[fetch-models] final-error', {
        customApi,
        baseUrl: trimmedBaseUrl,
        error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error),
      })
      setModelError(getFetchCustomModelsErrorMessage(error, t))
    } finally {
      setCustomModelsLoading(false)
    }
  }, [apiKey, baseUrl, customApi, existingConnectionSlug, modelsUrl, t])

  const handlePresetSelect = (preset: Preset) => {
    setActivePreset(preset.key)
    if (preset.key !== 'custom') {
      setLastNonCustomPreset(preset.key)
    }
    if (preset.key === 'custom') {
      setBaseUrl('')
    } else {
      setBaseUrl(preset.url)
    }
    setIsModelsUrlManuallyEdited(false)
    setModelError(null)
    // Pre-fill recommended model for Ollama; clear for all others
    // (Default provider presets hide the field entirely, others default to provider model IDs when empty)
    if (preset.key === 'ollama') {
      setConnectionDefaultModel('qwen3-coder')
    } else if (preset.key === 'openrouter' || preset.key === 'vercel-ai-gateway') {
      setConnectionDefaultModel(providerType === 'openai' ? COMPAT_OPENAI_DEFAULTS : COMPAT_ANTHROPIC_DEFAULTS)
    } else if (preset.key === 'minimax-global' || preset.key === 'minimax-cn') {
      setConnectionDefaultModel(COMPAT_MINIMAX_DEFAULTS)
    } else if (preset.key === 'kimi-coding') {
      setConnectionDefaultModel(COMPAT_KIMI_DEFAULTS)
    } else if (preset.key === 'custom') {
      setConnectionDefaultModel(providerType === 'openai' ? COMPAT_OPENAI_DEFAULTS : COMPAT_ANTHROPIC_DEFAULTS)
    } else {
      setConnectionDefaultModel('')
    }
  }

  const handleBaseUrlChange = (value: string) => {
    setBaseUrl(value)
    const presetKey = getPresetForUrl(value, presets)
    const currentPresetObj = presets.find(p => p.key === activePreset)
    const nextPresetState = resolvePresetStateForBaseUrlChange({
      matchedPreset: presetKey,
      activePreset,
      activePresetHasEmptyUrl: currentPresetObj?.url === '',
      lastNonCustomPreset,
    })
    setActivePreset(nextPresetState.activePreset)
    setLastNonCustomPreset(nextPresetState.lastNonCustomPreset)
    setModelError(null)
    if (!connectionDefaultModel.trim()) {
      if (presetKey === 'ollama') {
        setConnectionDefaultModel('qwen3-coder')
      } else if (presetKey === 'minimax-global' || presetKey === 'minimax-cn') {
        setConnectionDefaultModel(COMPAT_MINIMAX_DEFAULTS)
      } else if (presetKey === 'kimi-coding') {
        setConnectionDefaultModel(COMPAT_KIMI_DEFAULTS)
      } else if (presetKey === 'openrouter' || presetKey === 'vercel-ai-gateway' || presetKey === 'custom') {
        setConnectionDefaultModel(providerType === 'openai' ? COMPAT_OPENAI_DEFAULTS : COMPAT_ANTHROPIC_DEFAULTS)
      }
    }
  }

  const parseContextWindowInput = () => {
    const trimmed = contextWindowInput.trim().replace(/,/g, '')
    if (!trimmed) return undefined
    const parsed = Number(trimmed)
    return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : undefined
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()

    const configuredContextWindow = parseContextWindowInput()

    const effectivePiAuthProvider = isPiApiKeyFlow
      ? resolvePiAuthProviderForSubmit(activePreset, lastNonCustomPreset)
      : undefined

    // Pi API key flow with tier dropdowns — submit selected models
    if (hasPiModels) {
      if (!bestModel || !defaultModel || !cheapModel) {
        setModelError(t('apiSetup.modelTier.selectAllRequired'))
        return
      }
      const modelInfoById = new Map(piModels.map(model => [model.id, model]))
      const models: SubmitModel[] = [bestModel, defaultModel, cheapModel].map(modelId => {
        const modelInfo = modelInfoById.get(modelId)
        if (!modelInfo) return modelId
        return {
          id: modelInfo.id,
          name: modelInfo.name,
          shortName: modelInfo.name,
          description: '',
          provider: 'pi',
          contextWindow: modelInfo.contextWindow,
          supportsThinking: modelInfo.reasoning,
        }
      })
      onSubmit({
        apiKey: apiKey.trim(),
        baseUrl: baseUrl.trim() || undefined,
        connectionDefaultModel: bestModel,
        miniModel: cheapModel,
        models,
        contextWindow: configuredContextWindow,
        piAuthProvider: effectivePiAuthProvider,
        modelSelectionMode: 'userDefined3Tier',
      })
      return
    }

    // Bedrock — routes through Pi SDK with piAuthProvider='amazon-bedrock'.
    // Submit with auth method and optional IAM credentials.
    if (isBedrock) {
      if (bedrockAuthMethod === 'iam_credentials' && !awsAccessKeyId.trim()) {
        setModelError(t('apiSetup.bedrock.accessKeyRequired'))
        return
      }
      if (bedrockAuthMethod === 'iam_credentials' && !awsSecretAccessKey.trim()) {
        setModelError(t('apiSetup.bedrock.secretKeyRequired'))
        return
      }
      const parsedModels = parseModelList(connectionDefaultModel)
      onSubmit({
        apiKey: '',
        piAuthProvider: effectivePiAuthProvider,
        bedrockAuthMethod,
        awsRegion: awsRegion.trim() || 'us-east-1',
        ...(bedrockAuthMethod === 'iam_credentials' ? {
          iamCredentials: {
            accessKeyId: awsAccessKeyId.trim(),
            secretAccessKey: awsSecretAccessKey.trim(),
            ...(awsSessionToken.trim() ? { sessionToken: awsSessionToken.trim() } : {}),
          },
        } : {}),
        connectionDefaultModel: getSubmitModelId(parsedModels[0]),
        models: parsedModels.length > 0 ? parsedModels : undefined,
        contextWindow: configuredContextWindow,
      })
      return
    }

    const effectiveBaseUrl = baseUrl.trim()

    const parsedModels = isDefaultProviderPreset ? parseModelList(connectionDefaultModel) : rowsToSubmitModels(customModelRows)

    const isUsingDefaultEndpoint = isDefaultProviderPreset || !effectiveBaseUrl
    const requiresModel = !isDefaultProviderPreset && !!effectiveBaseUrl
    if (requiresModel && parsedModels.length === 0) {
      setModelError(t('apiSetup.defaultModelRequired'))
      return
    }

    // Include custom endpoint protocol when user configured a custom base URL
    const isCustomEndpoint = activePreset === 'custom' && !!effectiveBaseUrl
    const trimmedModelsUrl = modelsUrl.trim()
    const defaultModelsUrl = deriveDefaultModelsUrl(effectiveBaseUrl, normalizeCustomApi(customApi))
    const customEndpoint = isCustomEndpoint ? {
      api: normalizeCustomApi(customApi),
      ...(trimmedModelsUrl && trimmedModelsUrl !== defaultModelsUrl ? { modelsUrl: trimmedModelsUrl } : {}),
    } : undefined
    const resolvedPiAuthProvider = isCustomEndpoint
      ? (customApi === 'anthropic-messages' ? 'anthropic' : 'openai')
      : effectivePiAuthProvider

    onSubmit({
      apiKey: apiKey.trim(),
      baseUrl: isUsingDefaultEndpoint ? undefined : effectiveBaseUrl,
      connectionDefaultModel: getSubmitModelId(parsedModels[0]),
      models: parsedModels.length > 0 ? parsedModels : undefined,
      contextWindow: configuredContextWindow,
      piAuthProvider: resolvedPiAuthProvider,
      modelSelectionMode: isPiApiKeyFlow
        ? (parsedModels.length > 0 ? 'userDefined3Tier' : 'automaticallySyncedFromProvider')
        : undefined,
      customEndpoint,
    })
  }

  const tierConfigs = [
    { label: t('apiSetup.modelTier.best'), desc: t('apiSetup.modelTier.bestDesc'), value: bestModel, onChange: setBestModel },
    { label: t('apiSetup.modelTier.balanced'), desc: t('apiSetup.modelTier.balancedDesc'), value: defaultModel, onChange: setDefaultModel },
    { label: t('apiSetup.modelTier.fast'), desc: t('apiSetup.modelTier.fastDesc'), value: cheapModel, onChange: setCheapModel },
  ]
  const activeTierConfig = openTier ? tierConfigs.find(t => t.label === openTier) : null
  const canFetchCustomModels = activePreset === 'custom' && !isDefaultProviderPreset && !isBedrock

  return (
    <form id={formId} onSubmit={handleSubmit} className="space-y-6">
      {/* API Key — hidden for Bedrock (uses IAM/Environment auth) */}
      {!isBedrock && (<div className="space-y-2">
        <Label htmlFor="api-key">API Key</Label>
        <div className={cn(
          "relative rounded-md shadow-minimal transition-colors",
          "bg-foreground-2 focus-within:bg-background"
        )}>
          <Input
            id="api-key"
            type={showValue ? 'text' : 'password'}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={initialValues?.apiKey ? t('apiSetup.apiKeyKeepExistingPlaceholder') : apiKeyPlaceholder}
            className={cn(
              "pr-10 border-0 bg-transparent shadow-none",
              status === 'error' && "focus-visible:ring-destructive"
            )}
            disabled={isDisabled}
            autoFocus
          />
          <button
            type="button"
            onClick={() => setShowValue(!showValue)}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            tabIndex={-1}
          >
            {showValue ? (
              <EyeOff className="size-4" />
            ) : (
              <Eye className="size-4" />
            )}
          </button>
        </div>
      </div>)}

      {/* Endpoint/Provider Preset Selector - hidden when only one preset (e.g. Codex/OpenAI direct) */}
      {presets.length > 1 && (
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label htmlFor="base-url">Endpoint</Label>
          <DropdownMenu>
            <DropdownMenuTrigger
              disabled={isDisabled}
              className="flex h-6 items-center gap-1 rounded-[6px] bg-background shadow-minimal pl-2.5 pr-2 text-[12px] font-medium text-foreground/50 hover:bg-foreground/5 hover:text-foreground focus:outline-none"
            >
              {presets.find(p => p.key === activePreset)?.label}
              <ChevronDown className="size-2.5 opacity-50" />
            </DropdownMenuTrigger>
            <StyledDropdownMenuContent align="end" className="z-floating-menu">
              {presets.map((preset) => (
                <StyledDropdownMenuItem
                  key={preset.key}
                  onClick={() => handlePresetSelect(preset)}
                  className="justify-between"
                >
                  {preset.label}
                  <Check className={cn("size-3", activePreset === preset.key ? "opacity-100" : "opacity-0")} />
                </StyledDropdownMenuItem>
              ))}
            </StyledDropdownMenuContent>
          </DropdownMenu>
        </div>
        {/* Base URL input - hidden for default provider presets (Anthropic/OpenAI) and Bedrock */}
        {!isDefaultProviderPreset && !isBedrock && (
          <div className={cn(
            "rounded-md shadow-minimal transition-colors",
            "bg-foreground-2 focus-within:bg-background"
          )}>
            <Input
              id="base-url"
              type="text"
              value={baseUrl}
              onChange={(e) => handleBaseUrlChange(e.target.value)}
              placeholder="https://your-api-endpoint.com"
              className="border-0 bg-transparent shadow-none"
              disabled={isDisabled}
            />
          </div>
        )}
      </div>
      )}

      {/* Protocol Toggle — visible as soon as Custom preset is selected */}
      {activePreset === 'custom' && !isDefaultProviderPreset && (
        <div className="space-y-2">
          <Label>Protocol</Label>
          <div className={cn(
            "flex rounded-md shadow-minimal overflow-hidden",
            "bg-foreground-2",
            isDisabled && "opacity-50 pointer-events-none"
          )}>
            {([
              { value: 'openai-completions' as const, label: 'OpenAI Chat Completions' },
              { value: 'openai-responses' as const, label: 'OpenAI Responses' },
              { value: 'anthropic-messages' as const, label: 'Anthropic Messages' },
            ]).map(({ value, label }) => (
              <button
                key={value}
                type="button"
                disabled={isDisabled}
                onClick={() => setCustomApi(value)}
                className={cn(
                  "flex-1 py-1.5 text-[12px] font-medium transition-colors",
                  customApi === value
                    ? "bg-background text-foreground shadow-minimal"
                    : "text-foreground/50 hover:text-foreground/70"
                )}
              >
                {label}
              </button>
            ))}
          </div>
          <p className="text-xs text-foreground/30">
            Most third-party APIs (Ollama, vLLM, DashScope) use OpenAI Compatible.
          </p>
        </div>
      )}

      {/* Bedrock Auth Section */}
      {isBedrock && (
        <>
          {/* Auth Method Toggle */}
          <div className="space-y-2">
            <Label>Authentication</Label>
            <div className={cn(
              "flex rounded-md shadow-minimal overflow-hidden",
              "bg-foreground-2",
              isDisabled && "opacity-50 pointer-events-none"
            )}>
              {([
                { value: 'iam_credentials' as const, label: 'IAM Credentials' },
                { value: 'environment' as const, label: 'Environment (AWS CLI)' },
              ]).map(({ value, label }) => (
                <button
                  key={value}
                  type="button"
                  disabled={isDisabled}
                  onClick={() => setBedrockAuthMethod(value)}
                  className={cn(
                    "flex-1 py-1.5 text-[12px] font-medium transition-colors",
                    bedrockAuthMethod === value
                      ? "bg-background text-foreground shadow-minimal"
                      : "text-foreground/50 hover:text-foreground/70"
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* IAM Credential Fields */}
          {bedrockAuthMethod === 'iam_credentials' && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="aws-access-key-id" className="text-muted-foreground font-normal text-xs">
                  Access Key ID
                </Label>
                <div className={cn("rounded-md shadow-minimal transition-colors", "bg-foreground-2 focus-within:bg-background")}>
                  <Input
                    id="aws-access-key-id"
                    type="text"
                    value={awsAccessKeyId}
                    onChange={(e) => setAwsAccessKeyId(e.target.value)}
                    placeholder="AKIA..."
                    className="border-0 bg-transparent shadow-none"
                    disabled={isDisabled}
                    autoFocus
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="aws-secret-key" className="text-muted-foreground font-normal text-xs">
                  Secret Access Key
                </Label>
                <div className={cn("relative rounded-md shadow-minimal transition-colors", "bg-foreground-2 focus-within:bg-background")}>
                  <Input
                    id="aws-secret-key"
                    type={showValue ? 'text' : 'password'}
                    value={awsSecretAccessKey}
                    onChange={(e) => setAwsSecretAccessKey(e.target.value)}
                    placeholder={t("apiSetup.secretAccessKey")}
                    className="pr-10 border-0 bg-transparent shadow-none"
                    disabled={isDisabled}
                  />
                  <button
                    type="button"
                    onClick={() => setShowValue(!showValue)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    tabIndex={-1}
                  >
                    {showValue ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                  </button>
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="aws-session-token" className="text-muted-foreground font-normal text-xs">
                  Session Token <span className="text-foreground/30">· optional</span>
                </Label>
                <div className={cn("rounded-md shadow-minimal transition-colors", "bg-foreground-2 focus-within:bg-background")}>
                  <Input
                    id="aws-session-token"
                    type="text"
                    value={awsSessionToken}
                    onChange={(e) => setAwsSessionToken(e.target.value)}
                    placeholder={t("apiSetup.temporaryCredentials")}
                    className="border-0 bg-transparent shadow-none"
                    disabled={isDisabled}
                  />
                </div>
              </div>
            </div>
          )}

          {/* Environment info */}
          {bedrockAuthMethod === 'environment' && (
            <div className="rounded-md bg-foreground-2 p-3">
              <p className="text-xs text-foreground/50">
                Uses your existing AWS credential chain — <code className="text-foreground/70">~/.aws/credentials</code>, <code className="text-foreground/70">AWS_PROFILE</code>, IAM roles, SSO sessions, and environment variables.
              </p>
            </div>
          )}

          {/* AWS Region */}
          <div className="space-y-1.5">
            <Label htmlFor="aws-region" className="text-muted-foreground font-normal text-xs">
              AWS Region
            </Label>
            <div className={cn("rounded-md shadow-minimal transition-colors", "bg-foreground-2 focus-within:bg-background")}>
              <Input
                id="aws-region"
                type="text"
                value={awsRegion}
                onChange={(e) => setAwsRegion(e.target.value)}
                placeholder="us-east-1"
                className="border-0 bg-transparent shadow-none"
                disabled={isDisabled}
              />
            </div>
          </div>
        </>
      )}

      {/* Model Selection — 3 tier dropdowns for Pi providers, text input for custom/compat */}
      {hasPiModels ? (
        <div className="space-y-3">
          {piModelsLoading ? (
            <div className="flex items-center gap-2 py-3 text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              <span className="text-xs">{t("apiSetup.loadingModels")}</span>
            </div>
          ) : (
            <>
              {tierConfigs.map(({ label, desc, value }) => (
                <div key={label} className="space-y-1.5">
                  <Label className="text-muted-foreground font-normal text-xs">
                    {label}{' '}
                    <span className="text-foreground/30">· {desc}</span>
                  </Label>
                  <button
                    type="button"
                    disabled={isDisabled}
                    onClick={(e) => {
                      if (openTier === label) {
                        setOpenTier(null)
                        setTierFilter('')
                      } else {
                        const rect = e.currentTarget.getBoundingClientRect()
                        setTierDropdownPosition({ top: rect.bottom + 4, left: rect.left, width: rect.width })
                        setOpenTier(label)
                        setTierFilter('')
                        setTimeout(() => tierFilterInputRef.current?.focus(), 0)
                      }
                    }}
                    className={cn(
                      "flex h-9 w-full items-center justify-between rounded-md px-3 text-sm",
                      "bg-foreground-2 shadow-minimal transition-colors",
                      "hover:bg-background focus:outline-none focus:bg-background",
                      isDisabled && "opacity-50 pointer-events-none"
                    )}
                  >
                    <span className="truncate text-foreground">
                      {piModels.find(m => m.id === value)?.name ?? 'Select model...'}
                    </span>
                    <ChevronDown className="size-3 opacity-50 shrink-0" />
                  </button>
                </div>
              ))}
              {activeTierConfig && tierDropdownPosition && (
                <>
                  <div
                    className="fixed inset-0 z-floating-backdrop"
                    onClick={() => { setOpenTier(null); setTierFilter('') }}
                  />
                  <div
                    className="fixed z-floating-menu min-w-[200px] overflow-hidden rounded-[8px] bg-background text-foreground shadow-modal-small"
                    style={{
                      top: tierDropdownPosition.top,
                      left: tierDropdownPosition.left,
                      width: tierDropdownPosition.width,
                    }}
                  >
                    <CommandPrimitive
                      className="min-w-[200px]"
                      shouldFilter={false}
                    >
                      <div className="border-b border-border/50 px-3 py-2">
                        <CommandPrimitive.Input
                          ref={tierFilterInputRef}
                          value={tierFilter}
                          onValueChange={setTierFilter}
                          placeholder={t("apiSetup.searchModels")}
                          autoFocus
                          className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground placeholder:select-none"
                        />
                      </div>
                      <CommandPrimitive.List className="max-h-[240px] overflow-y-auto p-1">
                        {piModels
                          .filter(m => m.name.toLowerCase().includes(tierFilter.toLowerCase()))
                          .map((model) => (
                            <CommandPrimitive.Item
                              key={model.id}
                              value={model.id}
                              onSelect={() => {
                                activeTierConfig.onChange(model.id)
                                setOpenTier(null)
                                setTierFilter('')
                              }}
                              className={cn(
                                "flex cursor-pointer select-none items-center justify-between gap-3 rounded-[6px] px-3 py-2 text-[13px]",
                                "outline-none data-[selected=true]:bg-foreground/5"
                              )}
                            >
                              <div className="flex items-center gap-2 min-w-0">
                                <span className="truncate">{model.name}</span>
                                {model.reasoning && (
                                  <span className="text-[10px] text-foreground/30 shrink-0">reasoning</span>
                                )}
                              </div>
                              <Check className={cn("size-3 shrink-0", activeTierConfig.value === model.id ? "opacity-100" : "opacity-0")} />
                            </CommandPrimitive.Item>
                          ))}
                      </CommandPrimitive.List>
                    </CommandPrimitive>
                  </div>
                </>
              )}
              {modelError && (
                <p className="text-xs text-destructive">{modelError}</p>
              )}
            </>
          )}
        </div>
      ) : !isDefaultProviderPreset && (
        <div className="space-y-2">
          {canFetchCustomModels && (
            <div className="space-y-2">
              <Label htmlFor="models-url" className="text-muted-foreground font-normal">
                {t('apiSetup.modelsUrl')}
              </Label>
              <div className={cn(
                "rounded-md shadow-minimal transition-colors",
                "bg-foreground-2 focus-within:bg-background"
              )}>
                <Input
                  id="models-url"
                  type="text"
                  value={modelsUrl}
                  onChange={(e) => {
                    setModelsUrl(e.target.value)
                    setIsModelsUrlManuallyEdited(true)
                    setModelError(null)
                  }}
                  placeholder={deriveDefaultModelsUrl(baseUrl, customApi) || t('apiSetup.modelsUrlPlaceholder')}
                  className="border-0 bg-transparent shadow-none"
                  disabled={isDisabled || !baseUrl.trim()}
                />
              </div>
              <p className="text-xs text-foreground/30">
                {t('apiSetup.modelsUrlHelpText')}
              </p>
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="connection-context-window" className="text-muted-foreground font-normal">
              {t('apiSetup.contextWindow')}
            </Label>
            <div className={cn(
              "rounded-md shadow-minimal transition-colors",
              "bg-foreground-2 focus-within:bg-background"
            )}>
              <Input
                id="connection-context-window"
                type="number"
                value={contextWindowInput}
                onChange={(e) => setContextWindowInput(e.target.value)}
                placeholder="131072"
                min={1}
                step={1024}
                className="border-0 bg-transparent shadow-none"
                disabled={isDisabled}
              />
            </div>
            <p className="text-xs text-foreground/30">
              {t('apiSetup.contextWindowHelpText')}
            </p>
          </div>
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor="connection-default-model" className="text-muted-foreground font-normal">
              {isDefaultProviderPreset || isBedrock ? t('apiSetup.defaultModel') : t('apiSetup.modelList')}{' '}
              <span className="text-foreground/30">
                · {!isBedrock && baseUrl.trim() ? t('apiSetup.required') : t('apiSetup.optional')}
              </span>
            </Label>
            {canFetchCustomModels && (
              <button
                type="button"
                onClick={handleFetchCustomModels}
                disabled={isDisabled || customModelsLoading || !baseUrl.trim()}
                className="flex h-6 items-center gap-1 rounded-[6px] bg-background shadow-minimal px-2 text-[12px] font-medium text-foreground/50 hover:bg-foreground/5 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
              >
                {customModelsLoading ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
                {t('apiSetup.fetchModels')}
              </button>
            )}
          </div>
          {isDefaultProviderPreset || isBedrock ? (
            <div className={cn(
              "rounded-md shadow-minimal transition-colors",
              "bg-foreground-2 focus-within:bg-background",
              modelError && "ring-1 ring-destructive/40"
            )}>
              <Input
                id="connection-default-model"
                type="text"
                value={connectionDefaultModel}
                onChange={(e) => {
                  setConnectionDefaultModel(e.target.value)
                  setModelError(null)
                }}
                placeholder={t('apiSetup.defaultModelPlaceholder')}
                className="border-0 bg-transparent shadow-none"
                disabled={isDisabled}
              />
            </div>
          ) : (
            <div className="space-y-2">
              {customModelRows.map((row, index) => (
                <div key={index} className="grid grid-cols-[1fr_140px_auto] gap-2 items-center">
                  <div className={cn(
                    "rounded-md shadow-minimal transition-colors",
                    "bg-foreground-2 focus-within:bg-background",
                    modelError && index === 0 && "ring-1 ring-destructive/40"
                  )}>
                    <Input
                      type="text"
                      value={row.id}
                      onChange={(e) => {
                        setCustomModelRows(prev => prev.map((item, itemIndex) => itemIndex === index ? { ...item, id: e.target.value } : item))
                        setModelError(null)
                      }}
                      placeholder={t('apiSetup.modelIdPlaceholder')}
                      className="border-0 bg-transparent shadow-none"
                      disabled={isDisabled}
                    />
                  </div>
                  <div className="rounded-md shadow-minimal transition-colors bg-foreground-2 focus-within:bg-background">
                    <Input
                      type="number"
                      value={row.contextWindow}
                      onChange={(e) => setCustomModelRows(prev => prev.map((item, itemIndex) => itemIndex === index ? { ...item, contextWindow: e.target.value } : item))}
                      placeholder={contextWindowInput.trim() || '131072'}
                      min={1}
                      step={1024}
                      className="border-0 bg-transparent shadow-none"
                      disabled={isDisabled}
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => setCustomModelRows(prev => prev.length > 1 ? prev.filter((_, itemIndex) => itemIndex !== index) : [{ id: '', contextWindow: '' }])}
                    disabled={isDisabled}
                    className="flex h-9 w-9 items-center justify-center rounded-md bg-background shadow-minimal text-foreground/40 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-50"
                    aria-label={t('apiSetup.removeModel')}
                  >
                    <Trash2 className="size-4" />
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={() => setCustomModelRows(prev => [...prev, { id: '', contextWindow: '' }])}
                disabled={isDisabled}
                className="flex h-8 items-center gap-1.5 rounded-md bg-background shadow-minimal px-2 text-xs font-medium text-foreground/50 hover:bg-foreground/5 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Plus className="size-3.5" />
                {t('apiSetup.addModel')}
              </button>
            </div>
          )}
          {modelError && (
            <p className="text-xs text-destructive">{modelError}</p>
          )}
          {(isDefaultProviderPreset || isBedrock) && (
            <p className="text-xs text-foreground/30">
              {t('apiSetup.defaultModelHelpText')}
            </p>
          )}
          {(activePreset === 'custom' || !activePreset) && (
            <p className="text-xs text-foreground/30">
              {t('apiSetup.customEndpointModelHelpText')}
            </p>
          )}
        </div>
      )}

      {/* Error message */}
      {status === 'error' && errorMessage && (
        <p className="text-sm text-destructive">{errorMessage}</p>
      )}
    </form>
  )
}
