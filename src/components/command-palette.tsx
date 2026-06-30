import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Activity,
  BookText,
  Bot,
  Circle,
  Film,
  Folder,
  GitBranch,
  GitPullRequest,
  Globe,
  Plus,
  Search,
  Server,
  Settings,
  Square,
  SquareCode,
  SquareTerminal,
  Terminal,
} from "lucide-react";

import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { BrandIcon } from "@/components/sidebar/brand-icon";
import { useCommandPalette } from "@/store/command";
import { useGlobalSearch } from "@/store/global-search";
import { useWorkspace, type Tab } from "@/store/workspace";
import { useOverlay } from "@/store/overlay";
import { useOpenBrowser } from "@/store/pane-commands";
import { useWorkspaceCommand } from "@/store/workspace-command";
import { useCommandHistory } from "@/store/command-history";
import {
  useSnippets,
  snippetParams,
  resolveSnippet,
  type Snippet,
} from "@/store/snippets";
import { useSnippetRun } from "@/store/snippet-run";
import { useRecordings } from "@/store/recordings";
import { toggleRecording } from "@/terminal/recorder";
import { allTerminals } from "@/terminal/registry";
import { useSshHosts, sshCommand, isConnectable } from "@/store/ssh-hosts";
import {
  setOptimisticSessionBrand,
  useSessionInfo,
} from "@/store/session-info";
import { useDrawer } from "@/store/drawer";
import { useSettingsDialog } from "@/components/settings/settings-dialog";

interface ChangedFile {
  path: string;
  status: string;
  added: number;
  removed: number;
}

interface GitChanges {
  branch: string | null;
  files: ChangedFile[];
}

const activeTerminalId = (tab: Tab | undefined) => tab?.panelIds[0];
const isAgentBrand = (brand: string | undefined) =>
  brand === "claude" || brand === "codex" || brand === "opencode";

/**
 * Command palette (shadcn Command). Search/jump between sessions, run common
 * workspace actions, reopen ports, and replay recent commands.
 */
export function CommandPalette() {
  const open = useCommandPalette((s) => s.open);
  const setOpen = useCommandPalette((s) => s.setOpen);
  const tabs = useWorkspace((s) => s.tabs);
  const activeTabId = useWorkspace((s) => s.activeTabId);
  const setActiveTab = useWorkspace((s) => s.setActiveTab);
  const newTab = useWorkspace((s) => s.newTab);
  const recent = useCommandHistory((s) => s.recent);
  const snippets = useSnippets((s) => s.snippets);
  const sshHosts = useSshHosts((s) => s.hosts);
  const activeTab = tabs.find((tab) => tab.id === activeTabId);
  const activeId = activeTerminalId(activeTab);
  const recordingActive = useRecordings((s) =>
    activeId ? (s.active[activeId] ?? false) : false
  );
  const activeInfo = useSessionInfo(activeId, open);
  const agentActionsLocked = isAgentBrand(activeInfo?.brand);
  const [git, setGit] = useState<GitChanges | null>(null);

  useEffect(() => {
    if (!open) return;
    useOverlay.getState().inc();
    return () => useOverlay.getState().dec();
  }, [open]);

  useEffect(() => {
    if (!open || !activeInfo?.cwd) {
      setGit(null);
      return;
    }
    let alive = true;
    void invoke<GitChanges>("git_changes", { cwd: activeInfo.cwd })
      .then((changes) => {
        if (alive) setGit(changes);
      })
      .catch(() => {
        if (alive) setGit(null);
      });
    return () => {
      alive = false;
    };
  }, [open, activeInfo?.cwd]);

  const close = () => setOpen(false);

  const write = (id: string | undefined, data: string) => {
    if (!id) return;
    void invoke("pty_write", { id, data });
    close();
  };

  const openPort = (port: number) => {
    if (!activeTab) return;
    useOpenBrowser.getState().open(activeTab.id, `http://localhost:${port}`);
    close();
  };

  const runSnippet = (snippet: Snippet) => {
    // Templated snippets open the param dialog; plain ones run immediately.
    if (snippetParams(snippet.command).length > 0) {
      close();
      useSnippetRun.getState().open(snippet, activeId);
    } else {
      write(activeId, `${resolveSnippet(snippet.command, {})}\r`);
    }
  };

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput placeholder="세션, 명령, 포트, git 검색..." />
      <CommandList>
        <CommandEmpty>결과가 없습니다.</CommandEmpty>

        <CommandGroup heading="Sessions">
          {tabs.map((tab) => (
            <SessionItem
              key={tab.id}
              tab={tab}
              open={open}
              active={tab.id === activeTabId}
              onSelect={() => {
                setActiveTab(tab.id);
                close();
              }}
            />
          ))}
        </CommandGroup>

        <CommandGroup heading="Actions">
          <CommandItem
            value="new session"
            onSelect={() => {
              newTab();
              close();
            }}
          >
            <Plus />
            New session
          </CommandItem>
          <CommandItem
            value="new terminal shell pane"
            onSelect={() => {
              useWorkspaceCommand.getState().dispatch("newTerminal");
              close();
            }}
          >
            <Terminal />
            New terminal pane
          </CommandItem>
          <CommandItem
            value="new browser pane localhost web"
            onSelect={() => {
              useWorkspaceCommand.getState().dispatch("newBrowser");
              close();
            }}
          >
            <Globe />
            New browser pane
          </CommandItem>
          {(["claude", "codex", "opencode"] as const).map((agent) => (
            <CommandItem
              key={agent}
              value={`launch ${agent} agent`}
              disabled={agentActionsLocked}
              onSelect={() => {
                if (!activeId || agentActionsLocked) return;
                setOptimisticSessionBrand(activeId, agent);
                write(activeId, `${agent}\r`);
              }}
            >
              <BrandIcon brand={agent} />
              Launch {agent === "opencode" ? "OpenCode" : agent}
            </CommandItem>
          ))}
          <CommandItem
            value="global search 전체 검색 모든 세션 스크롤백 grep"
            onSelect={() => {
              close();
              useGlobalSearch.getState().setOpen(true);
            }}
          >
            <Search />
            전체 검색 (모든 세션)
          </CommandItem>
          <CommandItem
            value="process monitor 프로세스 모니터 kill port"
            onSelect={() => {
              useWorkspaceCommand.getState().dispatch("openProcMonitor");
              close();
            }}
          >
            <Activity />
            Process Monitor
          </CommandItem>
          <CommandItem
            value="runbook notebook 런북 노트북 실행 문서"
            onSelect={() => {
              useWorkspaceCommand.getState().dispatch("openRunbook");
              close();
            }}
          >
            <BookText />
            런북 / 노트북
          </CommandItem>
          <CommandItem
            value="record session 세션 녹화 시작 중지 asciinema"
            onSelect={() => {
              if (!activeId) return;
              const term = allTerminals().get(activeId);
              toggleRecording(
                activeId,
                activeTab?.title ?? "session",
                term?.cols ?? 80,
                term?.rows ?? 24
              );
              close();
            }}
          >
            {recordingActive ? (
              <Square className="text-t-red" />
            ) : (
              <Circle className="text-t-red" />
            )}
            {recordingActive ? "세션 녹화 중지" : "세션 녹화 시작"}
          </CommandItem>
          <CommandItem
            value="replay recordings 리플레이 녹화 보기 재생"
            onSelect={() => {
              useWorkspaceCommand.getState().dispatch("openReplay");
              close();
            }}
          >
            <Film />
            세션 리플레이
          </CommandItem>
          <CommandItem
            value="open settings preferences"
            onSelect={() => {
              close();
              useSettingsDialog.getState().setOpen(true);
            }}
          >
            <Settings />
            Open settings
          </CommandItem>
        </CommandGroup>

        {sshHosts.some(isConnectable) ? (
          <CommandGroup heading="SSH">
            {sshHosts.filter(isConnectable).map((host) => (
              <CommandItem
                key={host.id}
                value={`ssh ${host.label} ${host.user} ${host.host} 원격 접속`}
                onSelect={() => {
                  useWorkspaceCommand
                    .getState()
                    .dispatch("newTerminal", sshCommand(host));
                  close();
                }}
              >
                <Server />
                <span className="truncate">
                  {host.label || `${host.user ? host.user + "@" : ""}${host.host}`}
                </span>
                <span className="ml-auto max-w-48 truncate font-mono text-[11px] text-muted-foreground">
                  {host.host}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        ) : null}

        {snippets.length > 0 ? (
          <CommandGroup heading="Snippets">
            {snippets.map((snippet) => (
              <CommandItem
                key={snippet.id}
                value={`snippet ${snippet.name} ${snippet.command} ${snippet.description}`}
                onSelect={() => runSnippet(snippet)}
              >
                <SquareCode />
                <span className="truncate">
                  {snippet.name || snippet.command}
                </span>
                <span className="ml-auto max-w-48 truncate font-mono text-[11px] text-muted-foreground">
                  {snippet.command}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        ) : null}

        {activeInfo?.ports.length ? (
          <CommandGroup heading="Ports">
            {activeInfo.ports.slice(0, 8).map((port) => (
              <CommandItem
                key={port}
                value={`open localhost ${port} browser port`}
                onSelect={() => openPort(port)}
              >
                <Globe />
                localhost:{port}
              </CommandItem>
            ))}
          </CommandGroup>
        ) : null}

        {git?.branch && git.files.length > 0 ? (
          <CommandGroup heading={`Git · ${git.branch}`}>
            {git.files.slice(0, 10).map((file) => (
              <CommandItem
                key={file.path}
                value={`git ${file.status} ${file.path}`}
                onSelect={() => {
                  useDrawer.getState().openPanel("git");
                  close();
                }}
              >
                <GitPullRequest />
                <span className="w-4 shrink-0 font-mono text-xs">
                  {file.status}
                </span>
                <span className="truncate">{file.path}</span>
                {(file.added > 0 || file.removed > 0) && (
                  <span className="ml-auto shrink-0 font-mono text-[11px]">
                    <span className="text-t-green">+{file.added}</span>{" "}
                    <span className="text-t-red">-{file.removed}</span>
                  </span>
                )}
              </CommandItem>
            ))}
          </CommandGroup>
        ) : null}

        {recent.length > 0 ? (
          <CommandGroup heading="Recent Commands">
            {recent.slice(0, 8).map((item) => (
              <CommandItem
                key={item.id}
                value={`recent ${item.command} ${item.cwd ?? ""}`}
                onSelect={() => {
                  const tab = tabs.find((t) => t.panelIds.includes(item.sessionId));
                  if (tab) setActiveTab(tab.id);
                  write(item.sessionId, `${item.command}\r`);
                }}
              >
                <SquareTerminal />
                <span className="truncate font-mono">{item.command}</span>
                {item.cwd && (
                  <span className="ml-auto max-w-40 truncate text-xs text-muted-foreground">
                    {item.cwd}
                  </span>
                )}
              </CommandItem>
            ))}
          </CommandGroup>
        ) : null}
      </CommandList>
    </CommandDialog>
  );
}

function SessionItem({
  tab,
  open,
  active,
  onSelect,
}: {
  tab: Tab;
  open: boolean;
  active: boolean;
  onSelect: () => void;
}) {
  const info = useSessionInfo(tab.panelIds[0], open);
  const value = [
    tab.title,
    info?.brand,
    info?.cwd,
    info?.branch,
    ...(info?.ports ?? []).map((port) => `localhost:${port}`),
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <CommandItem value={value} onSelect={onSelect}>
      {info?.brand ? <BrandIcon brand={info.brand} /> : <Folder />}
      <span className="truncate">{tab.title}</span>
      {active && <span className="text-xs text-primary">active</span>}
      {info?.branch && (
        <span className="ml-auto flex max-w-32 items-center gap-1 truncate text-xs text-muted-foreground">
          <GitBranch className="size-3 shrink-0" />
          <span className="truncate">{info.branch}</span>
        </span>
      )}
      {info?.ports.length ? (
        <span className="shrink-0 text-xs text-sky-300">
          :{info.ports[0]}
        </span>
      ) : null}
      {!info?.brand && <Bot className="ml-auto opacity-0" />}
    </CommandItem>
  );
}
