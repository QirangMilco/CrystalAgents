/**
 * AppSettingsPage
 *
 * Global app-level settings that apply across all workspaces.
 *
 * Settings:
 * - Notifications
 * - Network (proxy)
 * - About (version, updates)
 *
 * Note: AI settings (connections, model, thinking) have been moved to AiSettingsPage.
 * Note: Appearance settings (theme, font) have been moved to AppearanceSettingsPage.
 */

import { useState, useEffect, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { PanelHeader } from '@/components/app-shell/PanelHeader'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Button } from '@/components/ui/button'
import { HeaderMenu } from '@/components/ui/HeaderMenu'
import { routes } from '@/lib/navigate'
import { Spinner } from '@craft-agent/ui'
import type { DetailsPageMeta } from '@/lib/navigation-registry'
import type { NetworkProxySettings } from '../../../shared/types'

import {
  SettingsSection,
  SettingsCard,
  SettingsCardFooter,
  SettingsRow,
  SettingsToggle,
  SettingsInput,
} from '@/components/settings'
import { useUpdateChecker } from '@/hooks/useUpdateChecker'
import { useAppShellContext } from '@/context/AppShellContext'

export const meta: DetailsPageMeta = {
  navigator: 'settings',
  slug: 'app',
}

// ============================================
// Proxy form helpers
// ============================================

interface ProxyFormState {
  enabled: boolean
  httpProxy: string
  httpsProxy: string
  noProxy: string
}

const EMPTY_PROXY_FORM: ProxyFormState = {
  enabled: false,
  httpProxy: '',
  httpsProxy: '',
  noProxy: '',
}

function toProxyFormState(settings?: NetworkProxySettings): ProxyFormState {
  if (!settings) return EMPTY_PROXY_FORM
  return {
    enabled: settings.enabled,
    httpProxy: settings.httpProxy ?? '',
    httpsProxy: settings.httpsProxy ?? '',
    noProxy: settings.noProxy ?? '',
  }
}

function toNetworkProxySettings(form: ProxyFormState): NetworkProxySettings {
  return {
    enabled: form.enabled,
    httpProxy: form.httpProxy.trim() || undefined,
    httpsProxy: form.httpsProxy.trim() || undefined,
    noProxy: form.noProxy.trim() || undefined,
  }
}

function validateProxyUrl(url: string): string | undefined {
  if (!url.trim()) return undefined
  try {
    const parsed = new URL(url.trim())
    if (!['http:', 'https:', 'socks4:', 'socks5:'].includes(parsed.protocol)) {
      return 'proxyErrorProtocol'
    }
    return undefined
  } catch {
    return 'proxyErrorFormat'
  }
}

// ============================================
// Main Component
// ============================================

export default function AppSettingsPage() {
  const { t } = useTranslation()
  const { onRefreshWorkspaces, onRefreshSessions } = useAppShellContext()

  // Notifications state
  const [notificationsEnabled, setNotificationsEnabled] = useState(true)

  // Power state
  const [keepAwakeEnabled, setKeepAwakeEnabled] = useState(false)

  // Tools state
  const [browserToolEnabled, setBrowserToolEnabled] = useState(true)

  // Proxy state
  const [proxyForm, setProxyForm] = useState<ProxyFormState>(EMPTY_PROXY_FORM)
  const [savedProxyForm, setSavedProxyForm] = useState<ProxyFormState>(EMPTY_PROXY_FORM)
  const [proxyError, setProxyError] = useState<string | undefined>()
  const [isSavingProxy, setIsSavingProxy] = useState(false)

  // Auto-update state (Check Now / Update Ready only shown in Electron, not WebUI)
  const isElectron = window.electronAPI.getRuntimeEnvironment() === 'electron'
  const updateChecker = useUpdateChecker()
  const [isCheckingForUpdates, setIsCheckingForUpdates] = useState(false)

  // Manual import state (official Craft Agents -> current variant)
  const [isDetectingImportSource, setIsDetectingImportSource] = useState(false)
  const [isImportingOfficialData, setIsImportingOfficialData] = useState(false)
  const [importDetection, setImportDetection] = useState<{
    found: boolean
    sourcePath: string
    availableEntries: Array<{
      name: string
      path: string
      kind: 'file' | 'directory'
      exists: boolean
      description: string
    }>
  } | null>(null)
  const [importSourcePath, setImportSourcePath] = useState('')
  const [lastImportResult, setLastImportResult] = useState<{
    success: boolean
    sourcePath: string
    imported: string[]
    skipped: string[]
    warnings: string[]
    error?: string
    results: Array<{
      name: string
      status: 'imported' | 'skipped' | 'missing' | 'failed'
      detail: string
    }>
  } | null>(null)

  const handleCheckForUpdates = useCallback(async () => {
    setIsCheckingForUpdates(true)
    try {
      await updateChecker.checkForUpdates()
    } finally {
      setIsCheckingForUpdates(false)
    }
  }, [updateChecker])

  // Load settings on mount
  const loadSettings = useCallback(async () => {
    if (!window.electronAPI) return
    try {
      const [notificationsOn, keepAwakeOn, browserToolOn, proxySettings] = await Promise.all([
        window.electronAPI.getNotificationsEnabled(),
        window.electronAPI.getKeepAwakeWhileRunning(),
        window.electronAPI.getBrowserToolEnabled(),
        window.electronAPI.getNetworkProxySettings(),
      ])
      setNotificationsEnabled(notificationsOn)
      setKeepAwakeEnabled(keepAwakeOn)
      setBrowserToolEnabled(browserToolOn)
      const form = toProxyFormState(proxySettings)
      setProxyForm(form)
      setSavedProxyForm(form)
    } catch (error) {
      console.error('Failed to load settings:', error)
    }
  }, [])

  useEffect(() => {
    loadSettings()
  }, [])

  const detectImportSource = useCallback(async (sourcePath?: string) => {
    if (!window.electronAPI?.detectOfficialImportSource) return
    setIsDetectingImportSource(true)
    try {
      const detected = await window.electronAPI.detectOfficialImportSource(sourcePath)
      setImportDetection(detected)
      setImportSourcePath(detected.sourcePath)
    } catch (error) {
      console.error('Failed to detect import source:', error)
    } finally {
      setIsDetectingImportSource(false)
    }
  }, [])

  useEffect(() => {
    void detectImportSource()
  }, [detectImportSource])

  const handleNotificationsEnabledChange = useCallback(async (enabled: boolean) => {
    setNotificationsEnabled(enabled)
    await window.electronAPI.setNotificationsEnabled(enabled)
  }, [])

  const handleKeepAwakeEnabledChange = useCallback(async (enabled: boolean) => {
    setKeepAwakeEnabled(enabled)
    await window.electronAPI.setKeepAwakeWhileRunning(enabled)
  }, [])

  const handleBrowserToolEnabledChange = useCallback(async (enabled: boolean) => {
    setBrowserToolEnabled(enabled)
    await window.electronAPI.setBrowserToolEnabled(enabled)
  }, [])

  // Proxy handlers
  const isProxyDirty = useMemo(() => {
    return JSON.stringify(proxyForm) !== JSON.stringify(savedProxyForm)
  }, [proxyForm, savedProxyForm])

  const handleSaveProxy = useCallback(async () => {
    // Validate URLs
    const httpErr = validateProxyUrl(proxyForm.httpProxy)
    const httpsErr = validateProxyUrl(proxyForm.httpsProxy)
    if (httpErr || httpsErr) {
      setProxyError(httpErr || httpsErr)
      return
    }
    setProxyError(undefined)
    setIsSavingProxy(true)
    try {
      const settings = toNetworkProxySettings(proxyForm)
      await window.electronAPI.setNetworkProxySettings(settings)
      // Re-read persisted state to confirm
      const persisted = await window.electronAPI.getNetworkProxySettings()
      const form = toProxyFormState(persisted)
      setProxyForm(form)
      setSavedProxyForm(form)
    } catch (error) {
      setProxyError(error instanceof Error ? error.message : 'Failed to save')
    } finally {
      setIsSavingProxy(false)
    }
  }, [proxyForm])

  const handleResetProxy = useCallback(() => {
    setProxyForm(savedProxyForm)
    setProxyError(undefined)
  }, [savedProxyForm])

  const handleChooseImportFolder = useCallback(async () => {
    const path = await window.electronAPI.openFolderDialog()
    if (!path) return
    setImportSourcePath(path)
    await detectImportSource(path)
  }, [detectImportSource])

  const handleImportOfficialData = useCallback(async () => {
    if (!window.electronAPI?.importOfficialData) return

    const confirmed = window.confirm(t('settings.app.import.confirm'))
    if (!confirmed) return

    setIsImportingOfficialData(true)
    try {
      const sourcePath = importSourcePath.trim() || importDetection?.sourcePath
      const result = await window.electronAPI.importOfficialData({
        sourcePath,
      })
      setLastImportResult(result)

      if (result.success) {
        const importedSummary = result.results
          .filter(item => item.status === 'imported')
          .map(item => `${item.name}: ${item.detail}`)
          .join(' · ')

        toast.success(t('settings.app.import.success'), {
          description: importedSummary || t('settings.app.import.importedSummary', { count: result.imported.length }),
        })

        onRefreshWorkspaces?.()
        await onRefreshSessions?.()
        toast.info(t('settings.app.import.refreshDone'))
      } else {
        const failedSummary = result.results
          .map(item => `${item.name}: ${item.detail}`)
          .join(' · ')
        toast.error(t('settings.app.import.failed'), {
          description: failedSummary || result.error || t('toast.unknownError'),
        })
      }

      await detectImportSource(sourcePath)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      toast.error(t('settings.app.import.failed'), { description: message })
    } finally {
      setIsImportingOfficialData(false)
    }
  }, [detectImportSource, importDetection?.sourcePath, importSourcePath, t])

  return (
    <div className="h-full flex flex-col">
      <PanelHeader title={t("settings.app.title")} actions={<HeaderMenu route={routes.view.settings('app')} helpFeature="app-settings" />} />
      <div className="flex-1 min-h-0 mask-fade-y">
        <ScrollArea className="h-full">
          <div className="px-5 py-7 max-w-3xl mx-auto">
            <div className="space-y-8">
              {/* Notifications */}
              <SettingsSection title={t("settings.notifications.title")}>
                <SettingsCard>
                  <SettingsToggle
                    label={t("settings.notifications.desktopNotifications")}
                    description={t("settings.notifications.desktopNotificationsDesc")}
                    checked={notificationsEnabled}
                    onCheckedChange={handleNotificationsEnabledChange}
                  />
                </SettingsCard>
              </SettingsSection>

              {/* Power */}
              <SettingsSection title={t("settings.power.title")}>
                <SettingsCard>
                  <SettingsToggle
                    label={t("settings.power.keepScreenAwake")}
                    description={t("settings.power.keepScreenAwakeDesc")}
                    checked={keepAwakeEnabled}
                    onCheckedChange={handleKeepAwakeEnabledChange}
                  />
                </SettingsCard>
              </SettingsSection>

              {/* Tools */}
              <SettingsSection title={t("settings.tools.title")}>
                <SettingsCard>
                  <SettingsToggle
                    label={t("settings.tools.builtInBrowser")}
                    description={t("settings.tools.builtInBrowserDesc")}
                    checked={browserToolEnabled}
                    onCheckedChange={handleBrowserToolEnabledChange}
                  />
                </SettingsCard>
              </SettingsSection>

              {/* Network */}
              <SettingsSection title={t("settings.network.title")}>
                <SettingsCard>
                  <SettingsToggle
                    label={t("settings.network.httpProxy")}
                    description={t("settings.network.httpProxyDesc")}
                    checked={proxyForm.enabled}
                    onCheckedChange={(enabled) => setProxyForm(prev => ({ ...prev, enabled }))}
                  />
                  {proxyForm.enabled && (
                    <>
                      <SettingsInput
                        label={t("settings.network.httpProxyLabel")}
                        value={proxyForm.httpProxy}
                        onChange={(value) => setProxyForm(prev => ({ ...prev, httpProxy: value }))}
                        placeholder={t("settings.network.proxyPlaceholder")}
                        inCard
                      />
                      <SettingsInput
                        label={t("settings.network.httpsProxyLabel")}
                        value={proxyForm.httpsProxy}
                        onChange={(value) => setProxyForm(prev => ({ ...prev, httpsProxy: value }))}
                        placeholder={t("settings.network.proxyPlaceholder")}
                        inCard
                      />
                      <SettingsInput
                        label={t("settings.network.bypassRules")}
                        value={proxyForm.noProxy}
                        onChange={(value) => setProxyForm(prev => ({ ...prev, noProxy: value }))}
                        placeholder={t("settings.network.bypassPlaceholder")}
                        inCard
                      />
                    </>
                  )}
                  {(isProxyDirty || proxyError) && (
                    <SettingsCardFooter>
                      {proxyError && (
                        <span className="text-destructive text-sm mr-auto">{proxyError === 'proxyErrorProtocol' ? t("settings.network.proxyErrorProtocol") : proxyError === 'proxyErrorFormat' ? t("settings.network.proxyErrorFormat") : proxyError}</span>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={handleResetProxy}
                        disabled={!isProxyDirty || isSavingProxy}
                      >
                        {t("common.reset")}
                      </Button>
                      <Button
                        size="sm"
                        onClick={handleSaveProxy}
                        disabled={!isProxyDirty || isSavingProxy}
                      >
                        {isSavingProxy ? (
                          <>
                            <Spinner className="mr-1.5" />
                            {t("common.saving")}
                          </>
                        ) : (
                          t("common.save")
                        )}
                      </Button>
                    </SettingsCardFooter>
                  )}
                </SettingsCard>
              </SettingsSection>

              {/* Data Import */}
              <SettingsSection
                title={t("settings.app.import.sectionTitle")}
                description={t("settings.app.import.description")}
              >
                <SettingsCard>
                  <div className="px-3 py-3 space-y-4">
                    <div className="space-y-2">
                      <div className="text-sm font-medium">{t('settings.app.import.sourceLabel')}</div>
                      <input
                        value={importSourcePath}
                        onChange={(e) => setImportSourcePath(e.target.value)}
                        placeholder={t('settings.app.import.sourcePlaceholder')}
                        className="w-full h-9 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
                      />
                      <div className="text-xs text-muted-foreground">
                        {importDetection?.found ? t('settings.app.import.statusFound') : t('settings.app.import.statusMissing')}
                      </div>
                    </div>

                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void detectImportSource()}
                        disabled={isDetectingImportSource || isImportingOfficialData}
                      >
                        {isDetectingImportSource ? (
                          <>
                            <Spinner className="mr-1.5" />
                            {t('common.checking')}
                          </>
                        ) : t('settings.app.import.actionDetectDefault')}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void handleChooseImportFolder()}
                        disabled={isDetectingImportSource || isImportingOfficialData}
                      >
                        {t('settings.app.import.actionSelectFolder')}
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => void handleImportOfficialData()}
                        disabled={isImportingOfficialData || !importDetection?.found}
                      >
                        {isImportingOfficialData ? (
                          <>
                            <Spinner className="mr-1.5" />
                            {t('settings.app.import.importing')}
                          </>
                        ) : t('settings.app.import.actionImport')}
                      </Button>
                    </div>

                    <div className="space-y-2 rounded-lg border border-border/60 bg-muted/20 px-3 py-3">
                      <div className="text-sm font-medium">{t('settings.app.import.contentsTitle')}</div>
                      <ul className="space-y-1 text-xs text-muted-foreground">
                        {(importDetection?.availableEntries ?? []).map((entry) => (
                          <li key={entry.name}>
                            <span className="font-medium text-foreground">{entry.name}</span>
                            {' — '}
                            {entry.description}
                            {' · '}
                            {entry.exists ? t('settings.app.import.entryExists') : t('settings.app.import.entryMissing')}
                          </li>
                        ))}
                      </ul>
                    </div>

                    {lastImportResult && (
                      <div className="space-y-2 rounded-lg border border-border/60 bg-muted/20 px-3 py-3">
                        <div className="text-sm font-medium">{t('settings.app.import.resultTitle')}</div>
                        <ul className="space-y-1 text-xs text-muted-foreground">
                          {lastImportResult.results.map((item) => (
                            <li key={`${item.name}-${item.status}`}>
                              <span className="font-medium text-foreground">{item.name}</span>
                              {' · '}
                              {t(`settings.app.import.result.${item.status}`)}
                              {' · '}
                              {item.detail}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                </SettingsCard>
              </SettingsSection>

              {/* About */}
              <SettingsSection title={t("settings.about.title")}>
                <SettingsCard>
                  <SettingsRow label={t("settings.about.version")}>
                    <div className="flex items-center gap-2">
                      <span className="text-muted-foreground">
                        {updateChecker.updateInfo?.currentVersion ?? t("common.loading")}
                      </span>
                      {isElectron && updateChecker.isDownloading && updateChecker.updateInfo?.latestVersion && (
                        <div className="flex items-center gap-2 text-muted-foreground text-sm">
                          <Spinner className="w-3 h-3" />
                          <span>{t("settings.about.downloading", { version: updateChecker.updateInfo.latestVersion, percent: updateChecker.downloadProgress })}</span>
                        </div>
                      )}
                    </div>
                  </SettingsRow>
                  {isElectron && (
                    <SettingsRow label={t("settings.about.checkForUpdates")}>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handleCheckForUpdates}
                        disabled={isCheckingForUpdates}
                      >
                        {isCheckingForUpdates ? (
                          <>
                            <Spinner className="mr-1.5" />
                            {t("common.checking")}
                          </>
                        ) : (
                          t("settings.about.checkNow")
                        )}
                      </Button>
                    </SettingsRow>
                  )}
                  {isElectron && updateChecker.isReadyToInstall && updateChecker.updateInfo?.latestVersion && (
                    <SettingsRow label={t("settings.about.updateReady")}>
                      <Button
                        size="sm"
                        onClick={updateChecker.installUpdate}
                      >
                        {t("settings.about.restartToUpdate", { version: updateChecker.updateInfo.latestVersion })}
                      </Button>
                    </SettingsRow>
                  )}
                </SettingsCard>
              </SettingsSection>
            </div>
          </div>
        </ScrollArea>
      </div>
    </div>
  )
}
