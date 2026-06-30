/**
 * Brand icons for the "open in app" menu. VS Code and Windows Terminal were
 * dropped from simple-icons (Microsoft brand purge), so their official glyphs
 * are inlined here; Git Bash uses the git logo from simple-icons.
 */
import { siGit } from "simple-icons";

import { Si } from "@/components/common/tech-icon";

/** Official VS Code mark (formerly simple-icons `visualstudiocode`). */
export function VSCodeIcon({ size = 14 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="#007ACC" aria-label="VS Code">
      <path d="M23.15 2.587 18.21.21a1.494 1.494 0 0 0-1.705.29l-9.46 8.63-4.12-3.128a.999.999 0 0 0-1.276.057L.327 7.261A1 1 0 0 0 .326 8.74L3.899 12 .326 15.26a1 1 0 0 0 .001 1.479L1.65 17.94a.999.999 0 0 0 1.276.057l4.12-3.128 9.46 8.63a1.492 1.492 0 0 0 1.704.29l4.942-2.377A1.5 1.5 0 0 0 24 20.06V3.939a1.5 1.5 0 0 0-.85-1.352zm-5.146 14.861L10.826 12l7.178-5.448v10.896z" />
    </svg>
  );
}

/** Windows Terminal: dark rounded card with a white `>_` prompt. */
export function WinTerminalIcon({ size = 14 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-label="Terminal">
      <rect x="0.75" y="3" width="22.5" height="18" rx="2.8" fill="#37474F" />
      <path
        d="M5.2 8.2 9.4 12l-4.2 3.8"
        fill="none"
        stroke="#fff"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <line x1="11.5" y1="16.8" x2="18" y2="16.8" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

/** Windows-style yellow folder (File Explorer). */
export function ExplorerFolderIcon({ size = 14 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-label="File Explorer">
      <path
        d="M2 5.5A1.5 1.5 0 0 1 3.5 4h5.06c.4 0 .78.16 1.06.44L11.5 6.3h9A1.5 1.5 0 0 1 22 7.8v10.7a1.5 1.5 0 0 1-1.5 1.5h-17A1.5 1.5 0 0 1 2 18.5z"
        fill="#FFCA28"
      />
      <path d="M2 8.4h20v1.4H2z" fill="#FFB300" />
    </svg>
  );
}

/** Git Bash — the git mark in its official orange-red. */
export function GitBashIcon({ size = 14 }: { size?: number }) {
  return <Si icon={siGit} size={size} />;
}
