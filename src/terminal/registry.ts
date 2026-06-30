import type { Terminal } from "@xterm/xterm";

/**
 * Live registry of every mounted session terminal, keyed by pane id. All
 * sessions stay mounted (inactive ones are just `visibility:hidden`), so this
 * gives global features — notably cross-pane search (PLAN §"글로벌 검색") — a
 * way to reach every pane's xterm buffer, including background ones. Production
 * counterpart to the dev-only `window.__naruTerms` E2E hook.
 */
const registry = new Map<string, Terminal>();

export function registerTerminal(id: string, term: Terminal): void {
  registry.set(id, term);
}

export function unregisterTerminal(id: string): void {
  registry.delete(id);
}

export function allTerminals(): ReadonlyMap<string, Terminal> {
  return registry;
}
