import { AnimatePresence, motion } from "motion/react";

import { isAttention, type SessionStatus } from "@/store/status";

/**
 * cmux-style "notification ring" (PLAN §3/§5): a pane glows when its agent
 * needs attention (waiting on input, or a command errored). Pure overlay —
 * pointer-events-none so it never steals clicks from the terminal.
 */
export function NotificationRing({
  status,
  attention: attentionProp,
}: {
  status: SessionStatus;
  /** Override (unread model): pass false once the user has seen this state. */
  attention?: boolean;
}) {
  const attention = attentionProp ?? isAttention(status);
  const color =
    status === "error"
      ? "hsl(var(--t-red))"
      : status === "done"
        ? "hsl(var(--ok))"
        : "hsl(var(--wait))";

  return (
    <AnimatePresence>
      {attention && (
        <motion.div
          key="ring"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          // Only the bottom-left corner meets the workspace's rounded edge
          // (<main> is `rounded-l-2xl`; the pane content's other corners sit at
          // straight edges — below the dockview tab bar, or against the square
          // right/window edge). Match that 16px so the ring traces the curve
          // instead of cutting a 6px corner inside it.
          className="pointer-events-none absolute inset-0 z-20 rounded-bl-2xl"
          style={{ border: `1.5px solid ${color}` }}
        >
          <div
            className="absolute inset-0 rounded-bl-2xl"
            style={{
              boxShadow: `inset 0 0 18px 1px ${color}`,
              opacity: 0.28,
            }}
          />
        </motion.div>
      )}
    </AnimatePresence>
  );
}
