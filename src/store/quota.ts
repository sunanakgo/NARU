import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface QuotaWindow {
  used_percent: number;
  resets_at: string | null;
  resets_in_seconds: number | null;
}
export interface AgentQuota {
  five_hour: QuotaWindow | null;
  weekly: QuotaWindow | null;
}
interface QuotaReport {
  claude: AgentQuota | null;
  codex: AgentQuota | null;
}

const POLL_MS = 5 * 60_000; // backend caches 5min too — stays in lockstep

/**
 * Plan usage for the agent CLI running in this session. `null` unless `brand`
 * is claude/codex AND its quota endpoint yielded data (not logged in / API
 * change → null → chip hides). `refresh` busts the backend cache.
 */
export function useAgentQuota(
  brand: string | undefined
): [AgentQuota | null, () => void] {
  const [quota, setQuota] = useState<AgentQuota | null>(null);
  const isAgent = brand === "claude" || brand === "codex";

  useEffect(() => {
    if (!isAgent) {
      setQuota(null);
      return;
    }
    let cancelled = false;
    let retries = 0;
    const timers: number[] = [];

    const fetchOnce = (force: boolean) => {
      void invoke<QuotaReport>("agent_quota", { force })
        .then((r) => {
          if (cancelled) return;
          const q = r[brand as "claude" | "codex"] ?? null;
          setQuota(q);
          // The first read right after an agent launch (especially a `--resume`,
          // where claude rotates its token and 429s the usage endpoint) often
          // comes back empty. The optimistic→real brand transition does NOT
          // re-run this effect (brand stays "claude"), so without an explicit
          // retry the chip would stay hidden for the full 5-min poll. Retry a
          // few times, forcing past the short failure cache.
          if (!q && retries < 3) {
            retries++;
            timers.push(
              window.setTimeout(() => fetchOnce(true), retries === 1 ? 9000 : 25000)
            );
          }
        })
        .catch(() => {
          if (!cancelled) setQuota(null);
        });
    };

    fetchOnce(false);
    const poll = window.setInterval(() => fetchOnce(false), POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(poll);
      timers.forEach((t) => window.clearTimeout(t));
    };
  }, [isAgent, brand]);

  const refresh = useCallback(() => {
    void invoke<QuotaReport>("agent_quota", { force: true })
      .then((r) => setQuota(r[brand as "claude" | "codex"] ?? null))
      .catch(() => setQuota(null));
  }, [brand]);

  return [isAgent ? quota : null, refresh];
}
