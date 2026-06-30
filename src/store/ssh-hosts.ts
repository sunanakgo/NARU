import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

import { kvStorage } from "@/lib/kv-storage";

/**
 * Saved SSH hosts (PLAN §"SSH/원격"). NARU is a multiplexer, so an "SSH session"
 * is just a pane that runs the system `ssh` — which means the user's existing
 * ssh config, keys and known_hosts all apply, with zero crypto in NARU. This
 * store is the connection manager; connecting opens a new terminal pane that
 * auto-runs the built `ssh` command line.
 */
export interface SshHost {
  id: string;
  label: string;
  host: string;
  user: string;
  /** Port; blank/22 omits `-p`. */
  port: string;
  /** Extra raw `ssh` args (e.g. `-A -J jump`). */
  extraArgs: string;
}

interface SshHostsState {
  hosts: SshHost[];
  add: () => string;
  update: (id: string, patch: Partial<SshHost>) => void;
  remove: (id: string) => void;
}

function newId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `h-${performance.now().toString(36)}`;
  }
}

/** Build the `ssh` command line for a host. */
export function sshCommand(h: SshHost): string {
  const target = h.user.trim() ? `${h.user.trim()}@${h.host.trim()}` : h.host.trim();
  const parts = ["ssh"];
  const port = h.port.trim();
  if (port && port !== "22") parts.push("-p", port);
  if (h.extraArgs.trim()) parts.push(h.extraArgs.trim());
  parts.push(target);
  return parts.join(" ");
}

/** A host is connectable once it has a hostname. */
export function isConnectable(h: SshHost): boolean {
  return h.host.trim().length > 0;
}

export const useSshHosts = create<SshHostsState>()(
  persist(
    (set) => ({
      hosts: [],
      add: () => {
        const host: SshHost = {
          id: newId(),
          label: "",
          host: "",
          user: "",
          port: "",
          extraArgs: "",
        };
        set((s) => ({ hosts: [...s.hosts, host] }));
        return host.id;
      },
      update: (id, patch) =>
        set((s) => ({
          hosts: s.hosts.map((h) => (h.id === id ? { ...h, ...patch } : h)),
        })),
      remove: (id) =>
        set((s) => ({ hosts: s.hosts.filter((h) => h.id !== id) })),
    }),
    {
      name: "naru-ssh-hosts",
      storage: createJSONStorage(() => kvStorage),
      version: 1,
    }
  )
);
