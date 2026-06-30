import { ClaudeCode, Codex, Gemini, OpenCode } from "@lobehub/icons";
import { Bot, SquareTerminal } from "lucide-react";

const CODEX_BLUE = "#7A9DFF";

/**
 * Brand icon for the agent running in a session, using @lobehub/icons for
 * accurate logos (Claude Code / Codex / OpenCode / Gemini). Falls back to a
 * `>_` terminal mark for a plain shell.
 */
export function BrandIcon({
  brand,
  size = 16,
}: {
  brand: string;
  size?: number;
}) {
  switch (brand) {
    case "claude":
      return <ClaudeCode.Color size={size} />;
    case "codex":
      return (
        <span style={{ color: CODEX_BLUE }} className="inline-grid">
          <Codex size={size} />
        </span>
      );
    case "opencode":
      return (
        <span style={{ color: "#2dd4bf" }} className="inline-grid">
          <OpenCode size={size} />
        </span>
      );
    case "gemini":
      return <Gemini.Color size={size} />;
    case "aider":
      return <Bot size={size} />;
    default:
      return <SquareTerminal size={size} />;
  }
}
