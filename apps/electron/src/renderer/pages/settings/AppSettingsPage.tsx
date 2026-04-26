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
import { AlertCircle, CircleCheckBig, CircleDashed, CircleX, DatabaseZap, ExternalLink, FolderOpen } from 'lucide-react'
import { PanelHeader } from '@/components/app-shell/PanelHeader'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ImportDialogFooter } from '@/components/app-shell/ImportDialogFooter'
import { HeaderMenu } from '@/components/ui/HeaderMenu'
import { routes } from '@/lib/navigate'
import { Spinner } from '@craft-agent/ui'
import { cn } from '@/lib/utils'
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
import electronPackageJson from '../../../../package.json'

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

type OfficialImportDetection = {
  found: boolean
  sourcePath: string
  availableEntries: Array<{
    name: string
    path: string
    kind: 'file' | 'directory'
    exists: boolean
    description: string
  }>
}

type OfficialImportResult = {
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
}

type OfficialImportDialogPhase = 'preview' | 'result'

const CRYSTAL_REPOSITORY_URL = 'https://github.com/QirangMilco/CrystalAgents'
const UPSTREAM_REPOSITORY_URL = 'https://github.com/lukilabs/craft-agents-oss'
const UPSTREAM_VERSION = typeof electronPackageJson.upstreamVersion === 'string'
  ? electronPackageJson.upstreamVersion
  : undefined

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
  const [importDetection, setImportDetection] = useState<OfficialImportDetection | null>(null)
  const [importSourcePath, setImportSourcePath] = useState('')
  const [lastImportResult, setLastImportResult] = useState<OfficialImportResult | null>(null)
  const [officialImportDialogOpen, setOfficialImportDialogOpen] = useState(false)
  const [officialImportDialogPhase, setOfficialImportDialogPhase] = useState<OfficialImportDialogPhase>('preview')

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
    if (!window.electronAPI?.detectOfficialImportSource) return null
    setIsDetectingImportSource(true)
    try {
      const detected = await window.electronAPI.detectOfficialImportSource(sourcePath)
      setImportDetection(detected)
      setImportSourcePath(detected.sourcePath)
      return detected
    } catch (error) {
      console.error('Failed to detect import source:', error)
      toast.error(t('settings.app.import.failed'), {
        description: error instanceof Error ? error.message : String(error),
      })
      return null
    } finally {
      setIsDetectingImportSource(false)
    }
  }, [t])

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

  const openOfficialImportPreview = useCallback((detected: OfficialImportDetection) => {
    setImportDetection(detected)
    setImportSourcePath(detected.sourcePath)
    setLastImportResult(null)
    setOfficialImportDialogPhase('preview')
    setOfficialImportDialogOpen(true)
  }, [])

  const handleDetectDefaultAndPreview = useCallback(async () => {
    const detected = await detectImportSource()
    if (!detected) return
    openOfficialImportPreview(detected)
  }, [detectImportSource, openOfficialImportPreview])

  const handleChooseImportFolder = useCallback(async () => {
    const path = await window.electronAPI.openFolderDialog()
    if (!path) return
    const detected = await detectImportSource(path)
    if (!detected) return
    openOfficialImportPreview(detected)
  }, [detectImportSource, openOfficialImportPreview])

  const resetOfficialImportDialog = useCallback(() => {
    setOfficialImportDialogPhase('preview')
    setLastImportResult(null)
  }, [])

  const handleImportOfficialData = useCallback(async () => {
    if (!window.electronAPI?.importOfficialData || !importDetection) return

    setIsImportingOfficialData(true)
    try {
      const sourcePath = importDetection.sourcePath
      const result = await window.electronAPI.importOfficialData({
        sourcePath,
      })
      setLastImportResult(result)
      setOfficialImportDialogPhase('result')

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
  }, [detectImportSource, importDetection, onRefreshSessions, onRefreshWorkspaces, t])

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
              <SettingsSection title={t("settings.app.import.sectionTitle")}>
                <SettingsCard>
                  <SettingsRow
                    label={t("settings.app.import.sectionTitle")}
                    description={t("settings.app.import.description")}
                  >
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void handleDetectDefaultAndPreview()}
                      disabled={isDetectingImportSource || isImportingOfficialData}
                    >
                      {isDetectingImportSource ? (
                        <>
                          <Spinner className="mr-1.5" />
                          {t('common.checking')}
                        </>
                      ) : (
                        <>
                          <DatabaseZap className="mr-1.5 h-4 w-4" />
                          {t('session.workspaceRecordImportAutoMode')}
                        </>
                      )}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void handleChooseImportFolder()}
                      disabled={isDetectingImportSource || isImportingOfficialData}
                    >
                      <FolderOpen className="mr-1.5 h-4 w-4" />
                      {t('session.workspaceRecordImportManualMode')}
                    </Button>
                  </SettingsRow>
                </SettingsCard>
              </SettingsSection>

              {/* About */}
              <SettingsSection title={t("settings.about.title")}>
                <SettingsCard>
                  <SettingsRow label={t("settings.about.crystalVersion")}>
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
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 text-muted-foreground hover:text-foreground"
                        aria-label={t("settings.about.openCrystalRepository")}
                        title={t("settings.about.openCrystalRepository")}
                        onClick={() => window.electronAPI.openUrl(CRYSTAL_REPOSITORY_URL)}
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </SettingsRow>
                  <SettingsRow label={t("settings.about.upstreamVersion")}>
                    <div className="flex items-center gap-2">
                      <span className="text-muted-foreground">
                        {UPSTREAM_VERSION ?? t("common.unknown")}
                      </span>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 text-muted-foreground hover:text-foreground"
                        aria-label={t("settings.about.openUpstreamRepository")}
                        title={t("settings.about.openUpstreamRepository")}
                        onClick={() => window.electronAPI.openUrl(UPSTREAM_REPOSITORY_URL)}
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                      </Button>
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

      <Dialog open={officialImportDialogOpen} onOpenChange={(open) => {
        if (!isImportingOfficialData) {
          setOfficialImportDialogOpen(open)
          if (!open) resetOfficialImportDialog()
        }
      }}>
        <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <DatabaseZap className="h-4 w-4" />
              {officialImportDialogPhase === 'preview'
                ? t('session.workspaceRecordImportPreviewTitle')
                : t('session.workspaceRecordImportResultsTitle')}
            </DialogTitle>
            <DialogDescription>
              {officialImportDialogPhase === 'preview'
                ? t('session.workspaceRecordImportPreviewDesc')
                : t('session.workspaceRecordImportResultsDesc')}
            </DialogDescription>
          </DialogHeader>

          <div className="flex-1 overflow-y-auto space-y-3 pr-1">
            {importDetection && (
              <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-sm space-y-1">
                <div className="font-medium text-foreground">{t('session.workspaceRecordImportSourceLine', { path: importSourcePath })}</div>
                <div className="text-muted-foreground">
                  {importDetection.found ? t('settings.app.import.statusFound') : t('settings.app.import.statusMissing')}
                </div>
              </div>
            )}

            {officialImportDialogPhase === 'preview' ? (
              <div className="rounded-lg border border-border/60 overflow-hidden">
                <div className="px-3 py-3 border-b border-border/60">
                  <div className="font-medium text-sm">{t('settings.app.import.contentsTitle')}</div>
                  <div className="text-xs text-muted-foreground">
                    {t('session.workspaceRecordImportGroupCounts', {
                      total: importDetection?.availableEntries.length ?? 0,
                      importable: importDetection?.availableEntries.filter(entry => entry.exists).length ?? 0,
                      skipped: importDetection?.availableEntries.filter(entry => !entry.exists).length ?? 0,
                    })}
                  </div>
                </div>
                <div className="px-3 py-2 space-y-2 bg-muted/10">
                  {(importDetection?.availableEntries ?? []).map((entry) => (
                    <div key={entry.name} className="flex items-start justify-between gap-3 text-sm">
                      <div className="min-w-0 flex-1">
                        <div className="truncate">{entry.name}</div>
                        <div className="text-xs text-muted-foreground break-words">{entry.description}</div>
                      </div>
                      <div className="shrink-0 flex items-center gap-1 text-xs">
                        {entry.exists ? <CircleCheckBig className="h-3.5 w-3.5 text-success" /> : <AlertCircle className="h-3.5 w-3.5 text-muted-foreground" />}
                        <span className={cn(entry.exists ? 'text-success' : 'text-muted-foreground')}>
                          {entry.exists ? t('session.workspaceRecordImportStatusReady') : t('session.workspaceRecordImportStatusMissing')}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="rounded-lg border border-border/60 overflow-hidden">
                <div className="px-3 py-3 border-b border-border/60">
                  <div className="font-medium text-sm">{t('settings.app.import.resultTitle')}</div>
                  <div className="text-xs text-muted-foreground">
                    {t('session.workspaceRecordImportDoneDesc', {
                      imported: lastImportResult?.imported.length ?? 0,
                      skipped: lastImportResult?.skipped.length ?? 0,
                      failed: lastImportResult?.results.filter(item => item.status === 'failed').length ?? 0,
                    })}
                  </div>
                </div>
                <div className="px-3 py-2 space-y-2 bg-muted/10">
                  {(lastImportResult?.results ?? []).map((item) => (
                    <div key={`${item.name}-${item.status}`} className="flex items-start justify-between gap-3 text-sm">
                      <div className="min-w-0 flex-1">
                        <div className="truncate">{item.name}</div>
                        <div className="text-xs text-muted-foreground break-words">{item.detail}</div>
                      </div>
                      <div className="shrink-0 flex items-center gap-1 text-xs">
                        {item.status === 'imported' && <CircleCheckBig className="h-3.5 w-3.5 text-success" />}
                        {item.status === 'skipped' && <CircleDashed className="h-3.5 w-3.5 text-warning" />}
                        {item.status === 'failed' && <CircleX className="h-3.5 w-3.5 text-destructive" />}
                        {item.status === 'missing' && <AlertCircle className="h-3.5 w-3.5 text-muted-foreground" />}
                        <span className={cn(
                          item.status === 'imported' && 'text-success',
                          item.status === 'skipped' && 'text-warning',
                          item.status === 'failed' && 'text-destructive',
                          item.status === 'missing' && 'text-muted-foreground',
                        )}>
                          {t(`settings.app.import.result.${item.status}`)}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {officialImportDialogPhase === 'result' && lastImportResult?.warnings?.length ? (
              <div className="rounded-lg border border-warning/40 bg-warning/5 px-3 py-2 space-y-1">
                <div className="text-sm font-medium">{t('session.workspaceRecordImportWarningsTitle')}</div>
                {lastImportResult.warnings.map((warning, index) => (
                  <div key={index} className="text-xs text-muted-foreground break-words">{warning}</div>
                ))}
              </div>
            ) : null}
          </div>

          <ImportDialogFooter
            phase={officialImportDialogPhase}
            importing={isImportingOfficialData}
            canImport={!!importDetection?.found}
            cancelLabel={t('common.cancel')}
            confirmLabel={t('session.workspaceRecordImportConfirmButton')}
            closeLabel={t('common.close')}
            loadingIndicator={<Spinner className="mr-1.5" />}
            onCancel={() => { setOfficialImportDialogOpen(false); resetOfficialImportDialog() }}
            onConfirm={() => void handleImportOfficialData()}
            onClose={() => { setOfficialImportDialogOpen(false); resetOfficialImportDialog() }}
          />
        </DialogContent>
      </Dialog>
    </div>
  )
}
