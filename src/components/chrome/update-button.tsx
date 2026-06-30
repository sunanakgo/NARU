import { Download, Loader2, RotateCw } from "lucide-react";

import { cn } from "@/lib/utils";
import { ToolButton } from "@/components/common/tool-button";
import { useUpdater } from "@/store/updater";

/**
 * Titlebar self-update affordance, mounted at the LEFT of the chrome. Hidden
 * until a newer release is detected; clicking downloads the signed installer,
 * runs it, and relaunches into the new version.
 *
 *   available    → download icon (click to start)
 *   downloading  → spinner + percent ring (busy)
 *   installing   → spinner (installer running, relaunch imminent)
 *   error        → retry icon (click to try again)
 */
export function UpdateButton() {
  const phase = useUpdater((s) => s.phase);
  const version = useUpdater((s) => s.version);
  const progress = useUpdater((s) => s.progress);
  const downloadAndInstall = useUpdater((s) => s.downloadAndInstall);

  // Nothing to show unless an update is in play.
  if (phase !== "available" && phase !== "downloading" && phase !== "installing" && phase !== "error") {
    return null;
  }

  const busy = phase === "downloading" || phase === "installing";
  const pct =
    phase === "downloading" && progress != null
      ? ` ${Math.round(progress * 100)}%`
      : "";

  const tip =
    phase === "available"
      ? `업데이트 설치 (v${version})`
      : phase === "downloading"
        ? `업데이트 다운로드 중${pct}`
        : phase === "installing"
          ? "업데이트 설치 중…"
          : "업데이트 실패 — 다시 시도";

  return (
    <ToolButton
      tip={tip}
      className={cn(
        "relative h-7 w-8",
        phase === "available" &&
          "text-primary hover:text-primary animate-pulse",
        phase === "error" && "text-destructive hover:text-destructive"
      )}
      disabled={busy}
      onClick={() => void downloadAndInstall()}
    >
      {busy ? (
        <Loader2 className="animate-spin" />
      ) : phase === "error" ? (
        <RotateCw />
      ) : (
        <Download />
      )}
    </ToolButton>
  );
}
