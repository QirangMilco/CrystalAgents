import React from 'react'
import ReactDOM from 'react-dom/client'
import { init as sentryInit } from '@sentry/electron/renderer'
import * as Sentry from '@sentry/react'
import { captureConsoleIntegration } from '@sentry/react'
import { Provider as JotaiProvider, useAtomValue } from 'jotai'
import App from './App'
import { ThemeProvider } from './context/ThemeContext'
import { windowWorkspaceIdAtom } from './atoms/sessions'
import { Toaster } from '@/components/ui/sonner'
import { setupI18n, i18n } from '@craft-agent/shared/i18n'
import { initReactI18next } from 'react-i18next'
import LanguageDetector from 'i18next-browser-languagedetector'
import './index.css'

function emitRendererCrashLog(label: string, payload: Record<string, unknown>): void {
  if (typeof window === 'undefined' || !window.electronAPI?.debugLog) return

  const safePayload = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>
  void Promise.resolve(window.electronAPI.debugLog(label, safePayload)).catch(() => {})
}

const startupPathDebugEnabled = (window as Window & { process?: { env?: Record<string, string | undefined> } }).process?.env?.CRAFT_DEBUG_STARTUP_PATHS === '1'

function emitStartupPathLog(label: string, payload: Record<string, unknown>): void {
  if (!startupPathDebugEnabled) return
  emitRendererCrashLog(label, payload)
}

emitStartupPathLog('[startup-paths] renderer-main:start', {
  href: typeof window !== 'undefined' ? window.location.href : null,
  readyState: typeof document !== 'undefined' ? document.readyState : null,
})

// Initialize i18n before any React rendering
setupI18n([LanguageDetector, initReactI18next])

emitStartupPathLog('[startup-paths] renderer-main:i18n-ready', {
  resolvedLanguage: i18n.resolvedLanguage ?? null,
  language: i18n.language ?? null,
})

// Sync persisted renderer language to the main process on startup.
// Renderer uses browser localStorage detection; the main process does not,
// so without this bootstrap sync the server-side i18n instance falls back to English.
const startupLanguage = i18n.resolvedLanguage ?? i18n.language
if (startupLanguage) {
  emitStartupPathLog('[startup-paths] renderer-main:changeLanguage', {
    startupLanguage,
  })
  void window.electronAPI?.changeLanguage?.(startupLanguage)
}

// Known-harmless console messages that should NOT be sent to Sentry.
// These are dev-mode noise or expected warnings that aren't actionable.
const IGNORED_CONSOLE_PATTERNS = [
  // React StrictMode dev warnings about non-boolean DOM attributes
  'Received `true` for a non-boolean attribute',
  'Received `false` for a non-boolean attribute',
  // Duplicate Shiki theme registration (expected on HMR reload)
  'theme name already registered',
]

// Initialize Sentry in the renderer process using the dual-init pattern.
// Combines Electron IPC transport (sentryInit) with React error boundary support (sentryReactInit).
// DSN and config are inherited from the main process init.
//
// captureConsoleIntegration promotes console.error calls into Sentry events,
// giving Sentry the same rich context visible in DevTools without needing sourcemaps.
//
// NOTE: Source map upload is intentionally disabled — see main/index.ts for details.
sentryInit(
  {
    integrations: [captureConsoleIntegration({ levels: ['error'] })],

    beforeSend(event) {
      // Drop events matching known-harmless console patterns to avoid Sentry quota waste
      const message = event.message || event.exception?.values?.[0]?.value || ''
      if (IGNORED_CONSOLE_PATTERNS.some((pattern) => message.includes(pattern))) {
        return null
      }

      // Scrub sensitive data from breadcrumbs (mirrors main process scrubbing in main/index.ts)
      if (event.breadcrumbs) {
        for (const breadcrumb of event.breadcrumbs) {
          if (breadcrumb.data) {
            for (const key of Object.keys(breadcrumb.data)) {
              const lowerKey = key.toLowerCase()
              if (
                lowerKey.includes('token') ||
                lowerKey.includes('key') ||
                lowerKey.includes('secret') ||
                lowerKey.includes('password') ||
                lowerKey.includes('credential') ||
                lowerKey.includes('auth')
              ) {
                breadcrumb.data[key] = '[REDACTED]'
              }
            }
          }
        }
      }

      return event
    },
  },
  Sentry.init,
)

/**
 * Minimal fallback UI shown when the entire React tree crashes.
 * Sentry.ErrorBoundary captures the error and sends it to Sentry automatically.
 */
function CrashFallback() {
  React.useEffect(() => {
    emitRendererCrashLog('[renderer-crash] CrashFallback rendered', {
      href: typeof window !== 'undefined' ? window.location.href : null,
    })
  }, [])

  return (
    <div className="flex flex-col items-center justify-center h-screen font-sans text-foreground/50 gap-3">
      <p className="text-base font-medium">Something went wrong</p>
      <p className="text-[13px]">Please restart the app. The error has been reported.</p>
      <button
        onClick={() => window.location.reload()}
        className="mt-2 px-4 py-1.5 rounded-md bg-background shadow-minimal text-[13px] text-foreground/70 cursor-pointer"
      >
        Reload
      </button>
    </div>
  )
}

/**
 * Root component - loads workspace ID for theme context and renders App
 * App.tsx handles window mode detection internally (main vs tab-content)
 */
function Root() {
  // Shared atom — written by App on init & workspace switch, read here for ThemeProvider
  const workspaceId = useAtomValue(windowWorkspaceIdAtom)

  return (
    <ThemeProvider activeWorkspaceId={workspaceId}>
      <App />
      <Toaster />
    </ThemeProvider>
  )
}

if (typeof window !== 'undefined') {
  window.addEventListener('error', (event) => {
    emitRendererCrashLog('[renderer-crash] window.error', {
      message: event.message,
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
      errorName: event.error?.name ?? null,
      errorMessage: event.error?.message ?? null,
      errorStack: event.error?.stack ?? null,
    })
  })

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason
    emitRendererCrashLog('[renderer-crash] window.unhandledrejection', {
      reasonType: typeof reason,
      reasonName: reason?.name ?? null,
      reasonMessage: reason?.message ?? String(reason ?? ''),
      reasonStack: reason?.stack ?? null,
    })
  })
}

emitStartupPathLog('[startup-paths] renderer-main:before-render', {
  hasRoot: !!document.getElementById('root'),
})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Sentry.ErrorBoundary
      fallback={<CrashFallback />}
      onError={(error, componentStack, eventId) => {
        const normalizedError = error instanceof Error
          ? error
          : new Error(typeof error === 'string' ? error : JSON.stringify(error))

        emitRendererCrashLog('[renderer-crash] error-boundary', {
          eventId,
          errorName: normalizedError.name,
          errorMessage: normalizedError.message,
          errorStack: normalizedError.stack ?? null,
          componentStack,
        })
      }}
    >
      <JotaiProvider>
        <Root />
      </JotaiProvider>
    </Sentry.ErrorBoundary>
  </React.StrictMode>
)
