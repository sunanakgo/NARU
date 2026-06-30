import { Columns2, Globe, Plus, Rows2 } from "lucide-react";
import type { IDockviewHeaderActionsProps } from "dockview-react";

import { ToolButton } from "@/components/common/tool-button";
import { sessionDevUrl } from "@/store/session-info";

const uid = () => crypto.randomUUID();

/**
 * Per-group header actions (top-right of each pane group). "+" and the globe
 * open a NEW tab in this group (terminal / browser) rather than overwriting;
 * split buttons create a new group beside it. Tabs can also be dragged/docked
 * directly — dockview handles the "window arrangement" gestures.
 */
export function GroupActions(props: IDockviewHeaderActionsProps) {
  const { containerApi, group } = props;

  // New shells should open where their sibling shell is (`cd` follows).
  const siblingTerminal = () => {
    const isTerm = (p: { params?: { kind?: string } } | undefined) =>
      p?.params?.kind === "terminal";
    const active = group.activePanel;
    if (isTerm(active)) return active?.id;
    return containerApi.panels.find((p) => isTerm(p))?.id;
  };

  const addTerminal = () =>
    containerApi.addPanel({
      id: uid(),
      component: "terminal",
      title: "shell",
      params: { kind: "terminal", inheritFrom: siblingTerminal() },
      position: { referenceGroup: group },
    });

  // Globe → the session's running dev server (first listening port), or
  // localhost:3000 when none is detected.
  const addBrowser = () =>
    void sessionDevUrl(siblingTerminal())
      .then((url) => {
        // The group may be gone by the time the URL resolves; addPanel would
        // then throw against a disposed api.
        try {
          containerApi.addPanel({
            id: uid(),
            component: "browser",
            title: "Browser",
            params: { kind: "browser", url },
            position: { referenceGroup: group },
          });
        } catch {
          /* group disposed mid-await */
        }
      })
      .catch(() => {});

  const split = (direction: "right" | "below") =>
    containerApi.addPanel({
      id: uid(),
      component: "terminal",
      title: "shell",
      params: { kind: "terminal", inheritFrom: siblingTerminal() },
      position: { referenceGroup: group, direction },
    });

  return (
    <div className="flex h-full items-center gap-px px-1">
      <ToolButton tip="새 터미널 탭" size="icon-xs" onClick={addTerminal}>
        <Plus />
      </ToolButton>
      <ToolButton tip="브라우저 탭 열기" size="icon-xs" onClick={addBrowser}>
        <Globe />
      </ToolButton>
      <ToolButton tip="오른쪽으로 분할" size="icon-xs" onClick={() => split("right")}>
        <Columns2 />
      </ToolButton>
      <ToolButton tip="아래로 분할" size="icon-xs" onClick={() => split("below")}>
        <Rows2 />
      </ToolButton>
    </div>
  );
}
