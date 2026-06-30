import ReactDOM from "react-dom/client";
import { TooltipProvider } from "@/components/ui/tooltip";
import { preloadKvStorage } from "@/lib/kv-storage";
// Self-hosted JetBrains Mono — CDN fonts are blocked by the production CSP
// (font-src 'self'), which silently fell back to a system font when bundled.
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/600.css";
import "@fontsource/jetbrains-mono/700.css";
// Self-hosted Korean monospace (Hangul = exactly 2 Latin cells). JetBrains
// Mono has no Hangul glyphs, and macOS ships NO Korean monospace font, so on
// Mac Hangul fell back to a proportional system font inside xterm's 2-cell
// slots — leaving a gap after every character. Bundling this guarantees a
// correct CJK cell width on every platform. Only the Korean subset is loaded
// (Latin stays JetBrains Mono via the font stack); 400 + 700 cover normal/bold.
import "@fontsource/nanum-gothic-coding/korean-400.css";
import "@fontsource/nanum-gothic-coding/korean-700.css";
import "dockview-react/dist/styles/dockview.css";
import "./index.css";

async function render() {
  const { default: App } = await import("./App");

  // NOTE: no React.StrictMode here. StrictMode double-invokes effects in dev,
  // which would spawn/destroy real PTY processes twice. Re-enable selectively
  // for non-side-effecting trees if desired.
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <TooltipProvider delayDuration={300}>
      <App />
    </TooltipProvider>
  );
}

// Disk-backed store state must be in memory BEFORE the store modules are
// evaluated (zustand persist hydrates synchronously from the kv cache) —
// hence the dynamic import of App after the preload.
//
// If the preload throws (localStorage blocked in privacy mode, dynamic import
// failure), we MUST still render — a blank window is worse than an empty kv
// cache, which simply means stores fall back to their defaults.
void preloadKvStorage()
  .catch((err) => {
    console.error("[main] preloadKvStorage failed; rendering anyway", err);
  })
  .then(render);
