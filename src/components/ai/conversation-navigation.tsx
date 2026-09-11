import { useEffect, useRef, useState, type RefObject } from "react";
import * as Tooltip from "@radix-ui/react-tooltip";
import type { ConversationTurn } from "@shared/conversation";
import { useT } from "@/i18n/use-t";

interface IConversationNavigationProps {
  turns: ConversationTurn[];
  scrollRef: RefObject<HTMLDivElement>;
  onNavigate: () => void;
}

/** A compact outline of user turns, scoped to this tab's scroll container. */
export function ConversationNavigation({ turns, scrollRef, onNavigate }: IConversationNavigationProps) {
  const t = useT();
  const [activeId, setActiveId] = useState<string>();
  const navRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const container = scrollRef.current;
    if (!container || !turns.length) return;
    let frame = 0;
    const update = () => {
      const articles = Array.from(container.querySelectorAll<HTMLElement>("[data-conversation-turn]"));
      const top = container.getBoundingClientRect().top + 48;
      let current: HTMLElement | undefined = articles[0];
      for (const article of articles) {
        if (article.getBoundingClientRect().top > top) break;
        current = article;
      }
      if (container.scrollHeight > container.clientHeight && container.scrollHeight - container.scrollTop - container.clientHeight < 4) {
        current = articles.at(-1);
      }
      setActiveId(current?.dataset.conversationTurn);
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    };
    container.addEventListener("scroll", schedule, { passive: true });
    const observer = new ResizeObserver(schedule);
    observer.observe(container);
    if (container.firstElementChild) observer.observe(container.firstElementChild);
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      container.removeEventListener("scroll", schedule);
      observer.disconnect();
    };
  }, [scrollRef, turns]);

  useEffect(() => {
    const nav = navRef.current;
    const active = nav?.querySelector<HTMLElement>('[aria-current="location"]');
    if (!nav || !active) return;
    const bounds = nav.getBoundingClientRect();
    const item = active.getBoundingClientRect();
    if (item.top < bounds.top) nav.scrollTop -= bounds.top - item.top;
    else if (item.bottom > bounds.bottom) nav.scrollTop += item.bottom - bounds.bottom;
  }, [activeId]);

  if (!turns.length) return null;
  const jump = (id: string) => {
    const container = scrollRef.current;
    const article = Array.from(container?.querySelectorAll<HTMLElement>("[data-conversation-turn]") ?? [])
      .find(element => element.dataset.conversationTurn === id);
    if (!container || !article) return;
    onNavigate();
    container.scrollTop += article.getBoundingClientRect().top - container.getBoundingClientRect().top - 24;
    article.focus({ preventScroll: true });
    setActiveId(id);
  };

  return (
    <Tooltip.Provider delayDuration={150}>
      <nav ref={navRef} aria-label={t("conversation.navigation")} className="stela-conversation-navigation absolute right-1 top-1/2 max-h-[80%] w-8 -translate-y-1/2 overflow-y-auto overscroll-contain py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {turns.map((turn, index) => {
          const summary = turn.input.replace(/\s+/g, " ").trim() || t("conversation.turn", { number: index + 1 });
          const label = `${index + 1}. ${summary}`;
          const active = turn.id === activeId;
          return (
            <Tooltip.Root key={turn.id}>
              <Tooltip.Trigger asChild>
                <button type="button" aria-label={label} aria-current={active ? "location" : undefined} onClick={() => jump(turn.id)}
                  className="group flex h-6 w-full items-center justify-end rounded px-1.5 hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary">
                  <span className={`h-0.5 rounded-full transition-all ${active ? "w-5 bg-primary" : "w-3 bg-muted-foreground/30 group-hover:w-5 group-hover:bg-muted-foreground"}`} />
                </button>
              </Tooltip.Trigger>
              <Tooltip.Portal>
                <Tooltip.Content side="left" sideOffset={8} collisionPadding={12} className="stela-conversation-navigation-preview z-50 max-w-72 rounded-md border border-border bg-popover px-3 py-2 text-xs leading-5 text-popover-foreground shadow-md">
                  <span className="line-clamp-4 break-words">{label}</span>
                </Tooltip.Content>
              </Tooltip.Portal>
            </Tooltip.Root>
          );
        })}
      </nav>
    </Tooltip.Provider>
  );
}
