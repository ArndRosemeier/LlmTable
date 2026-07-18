import { useEffect, useRef, type RefObject } from "react";

/**
 * Keeps a scrollable chat container pinned to the bottom whenever deps change
 * (e.g. new messages), when content resizes, and when images finish loading.
 * Only scrolls the chat element itself — never scrollIntoView (avoids layout wobble).
 */
export function useStickChatToBottom(
  deps: ReadonlyArray<unknown>,
): {
  chatRef: RefObject<HTMLDivElement | null>;
  chatEndRef: RefObject<HTMLDivElement | null>;
} {
  const chatRef = useRef<HTMLDivElement>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = chatRef.current;
    if (!el) {
      return;
    }

    const stick = (): void => {
      el.scrollTop = el.scrollHeight;
    };

    stick();
    const outer = requestAnimationFrame(() => {
      requestAnimationFrame(stick);
    });

    const resizeObserver = new ResizeObserver(() => {
      stick();
    });
    resizeObserver.observe(el);
    for (const child of el.children) {
      resizeObserver.observe(child);
    }

    const mutationObserver = new MutationObserver(() => {
      stick();
      for (const child of el.children) {
        resizeObserver.observe(child);
      }
    });
    mutationObserver.observe(el, { childList: true, subtree: true, characterData: true });

    const onLoad = (): void => {
      stick();
    };
    el.addEventListener("load", onLoad, true);

    return () => {
      cancelAnimationFrame(outer);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      el.removeEventListener("load", onLoad, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- stick whenever caller deps change
  }, deps);

  return { chatRef, chatEndRef };
}
