import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { authenticatedFetch } from "../../../../utils/api";
import { SettingsCard } from "../../shared/view";
import type { AboutSectionsProps } from ".";

type Download = {
  state: "idle" | "downloading" | "downloaded" | "failed" | "cancelled" | "installerLaunched";
  progress?: number;
  verified?: boolean;
  filePath?: string | null;
  reason?: string | null;
  release?: { tagName: string };
};
const buttonClass = "rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground";

export default function DesktopAboutSections({ title, versionInfo, checkingVersion }: AboutSectionsProps) {
  const { t } = useTranslation("settings");
  const [download, setDownload] = useState<Download | null>(null);
  const [pending, setPending] = useState<"download" | "cancel" | "install" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusFailed, setStatusFailed] = useState(false);
  const downloading = download?.state === "downloading";
  const downloaded = download?.state === "downloaded" && download.verified === true;
  const launched = download?.state === "installerLaunched";

  // The server owns the job; reopening About recovers it without starting again.
  // Retry transient failures, including when the initial status is unknown.
  useEffect(() => {
    if (download && !downloading) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const response = await authenticatedFetch("/api/update/desktop/download/status", { suppressServerErrorToast: true });
        if (!response.ok) throw new Error("statusFailed");
        const payload = await response.json();
        if (!payload.download?.state) throw new Error("statusFailed");
        if (!active) return;
        setDownload(payload.download);
        setStatusFailed(false);
        if (payload.download.state !== "downloading") return;
      } catch {
        if (!active) return;
        setStatusFailed(true);
      }
      if (active) timer = setTimeout(poll, 1000);
    };
    void poll();
    return () => { active = false; clearTimeout(timer); };
  }, [download === null, downloading]);

  const act = async (action: "download" | "cancel" | "install") => {
    if (pending) return;
    setPending(action);
    setError(null);
    try {
      const endpoint = action === "cancel" ? "download/cancel" : action;
      const response = await authenticatedFetch(`/api/update/desktop/${endpoint}`, {
        method: "POST",
        body: JSON.stringify(action === "install" ? { filePath: download?.filePath } : {}),
        suppressServerErrorToast: true,
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.reason || `${action}Failed`);
      if (action === "install") {
        if (!payload.launched) throw new Error("installFailed");
        setDownload((previous) => previous && { ...previous, state: "installerLaunched" });
      } else {
        setDownload(payload.download ?? null);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : `${action}Failed`);
      // The request may have reached the server. Recover its authoritative state.
      setDownload(null);
    } finally {
      setPending(null);
    }
  };

  const reason = statusFailed ? "statusFailed" : error || download?.reason || versionInfo.desktopReason;
  const status = launched ? "installerLaunched" : downloaded ? "downloaded" : downloading || pending === "download" ? "downloading"
    : checkingVersion ? "checking" : reason && reason !== "cancelled" ? "unavailable"
      : versionInfo.checkUnavailable ? "unavailable" : versionInfo.hasUpdate ? "updateAvailable" : "upToDate";
  const downloadDisabled = pending !== null || !download || downloading || checkingVersion
    || versionInfo.checkUnavailable || versionInfo.canDownload !== true;
  const progress = Math.round(Math.max(0, Math.min(1, download?.progress || 0)) * 100);

  return (
    <div className="space-y-8">
      <h2 className="text-2xl font-semibold text-foreground">{title}</h2>
      <SettingsCard className="overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-4 px-5 py-4 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{t("settingsPage.about.versionStatus")}</span>
            <span className="rounded-md border border-border bg-muted px-2 py-0.5" role="status">
              {t(`settingsPage.about.desktopUpdate.status.${status}`)}
            </span>
          </div>
          <div className="flex items-center gap-3">
            {launched ? null : downloaded ? (
              <button className={buttonClass} disabled={pending !== null} onClick={() => void act("install")}>
                {t(`settingsPage.about.desktopUpdate.${pending === "install" ? "installing" : "install"}`)}
              </button>
            ) : (
              <button className={buttonClass} disabled={downloadDisabled} onClick={() => void act("download")}>
                {t(`settingsPage.about.desktopUpdate.${downloading || pending === "download" ? "downloading" : "download"}`)}
              </button>
            )}
            {downloading && (
              <button className="text-sm text-muted-foreground hover:text-foreground disabled:opacity-50" disabled={pending !== null} onClick={() => void act("cancel")}>
                {t("settingsPage.about.desktopUpdate.cancel")}
              </button>
            )}
          </div>
        </div>
        <div className="space-y-3 border-t border-border px-5 py-4 text-sm text-muted-foreground">
          <div className="flex flex-wrap gap-x-6 gap-y-1">
            <span>{t("settingsPage.about.currentVersion")} {versionInfo.currentVersion}</span>
            <span>{t("settingsPage.about.latestVersion")} {versionInfo.latestVersion || "-"}</span>
            {versionInfo.latestPublishedAt && <span>{t("settingsPage.about.latestReleaseTime")} {new Date(versionInfo.latestPublishedAt).toLocaleString()}</span>}
          </div>
          {downloading && <div className="flex items-center gap-3">
            <progress className="h-2 w-full accent-blue-600" max={100} value={progress} aria-label={t("settingsPage.about.desktopUpdate.progress")} />
            <span>{progress}%</span>
          </div>}
          {download?.release && (downloaded || launched) && <p>{t("settingsPage.about.desktopUpdate.installerVersion")} {download.release.tagName}</p>}
          <p role={reason ? "alert" : undefined}>
            {t(`settingsPage.about.desktopUpdate.reasons.${reason || (launched ? "installerLaunched" : downloaded ? "downloaded" : "standard")}`, {
              defaultValue: t("settingsPage.about.desktopUpdate.reasons.failed"),
            })}
          </p>
        </div>
      </SettingsCard>
    </div>
  );
}
