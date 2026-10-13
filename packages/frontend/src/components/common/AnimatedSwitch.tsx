import { AnimatePresence } from "framer-motion";
import type { ReactNode } from "react";
import { AnimatedHeight } from "./AnimatedHeight";

/**
 * The motion of content that replaces other content (a step, a tab, a mode): spread it on the
 * keyed `motion.div` children of `AnimatedSwitch`.
 */
export const CONTENT_SWITCH_ANIMATION = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -4 },
  transition: { duration: 0.2, ease: [0.25, 0.1, 0.25, 1] as const },
};

/**
 * Switches content in place: the old content fades out while the new one fades in, both at once,
 * and the height follows the new content at the same time. Nothing waits for the old content to
 * leave (no `mode="wait"`): the leaving child is taken out of the flow (`popLayout`) so the new one
 * takes its place from the first frame.
 *
 * Children are keyed `motion.div`s (usually with `CONTENT_SWITCH_ANIMATION`); a new key is a switch.
 * `animateHeight={false}` for a container whose height does not follow its content (a sidebar).
 */
export function AnimatedSwitch({
  children,
  animateHeight = true,
}: {
  children: ReactNode;
  animateHeight?: boolean;
}) {
  // The leaving child is positioned against this box while it fades out.
  const content = (
    <div className="relative">
      <AnimatePresence initial={false} mode="popLayout">
        {children}
      </AnimatePresence>
    </div>
  );
  // AnimatedHeight bleeds 8px around its content (focus rings) with negative margins; the outer box
  // keeps those out of a space-y parent's own margins.
  return animateHeight ? (
    <div>
      <AnimatedHeight>{content}</AnimatedHeight>
    </div>
  ) : (
    content
  );
}
