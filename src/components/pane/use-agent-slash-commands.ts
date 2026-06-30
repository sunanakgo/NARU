import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import { AGENT_SLASH, type SlashCmd } from "@/components/pane/input-bar-model";

export function useAgentSlashCommands(
  brand: string | undefined,
  cwd: string | null
): SlashCmd[] | undefined {
  const [customCmds, setCustomCmds] = useState<SlashCmd[]>([]);

  useEffect(() => {
    if (!brand || !AGENT_SLASH[brand]) {
      setCustomCmds([]);
      return;
    }
    let alive = true;
    void invoke<{ name: string; desc: string; source: string }[]>(
      "agent_commands",
      { brand, cwd }
    )
      .then((list) => {
        if (!alive) return;
        setCustomCmds(
          list.map((c) => ({
            name: "/" + c.name,
            desc:
              (c.desc || "커스텀 명령") +
              (c.source === "project" ? " · 프로젝트" : " · 사용자"),
            custom: true,
          }))
        );
      })
      .catch(() => alive && setCustomCmds([]));
    return () => {
      alive = false;
    };
  }, [brand, cwd]);

  const builtin = brand ? AGENT_SLASH[brand] : undefined;
  if (!builtin) return undefined;
  if (customCmds.length === 0) return builtin;

  // Custom commands shadow same-named builtins, merged alphabetically.
  const names = new Set(customCmds.map((c) => c.name.toLowerCase()));
  return [
    ...customCmds,
    ...builtin.filter((c) => !names.has(c.name.toLowerCase())),
  ].sort((a, b) => a.name.localeCompare(b.name));
}

