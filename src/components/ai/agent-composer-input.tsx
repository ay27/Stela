import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type { EditorState } from "@milkdown/prose/state";
import { EditorView } from "@milkdown/prose/view";

import type { AgentMessageContent, AgentMessageResource } from "@shared/types";
import {
  AGENT_RESOURCE_NODE,
  agentComposerClipboardText,
  agentComposerResourceById,
  agentComposerStateToMessage,
  agentComposerSuggestionKey,
  agentComposerSuggestionRangeKey,
  handleAgentComposerSuggestionKey,
  insertAgentComposerHardBreak,
  insertAgentComposerResourceTransaction,
  isAgentComposerEmpty,
  placeAgentComposerSuggestions,
  replaceAgentComposerSelectionWithText,
  setAgentComposerSuggestionCandidates,
  type AgentComposerSuggestionRange,
} from "@/lib/agent-composer";
import { cn } from "@/lib/utils";

import { shouldSubmitPrompt } from "./prompt-input-keyboard";
import "./agent-composer-input.css";

export interface AgentComposerInputHandle {
  focus: () => void;
}

export interface AgentComposerInputProps {
  placeholder?: string;
  state: EditorState;
  disabled?: boolean;
  submitEnabled?: boolean;
  className?: string;
  minHeightPx?: number;
  getResourceCandidates: (query: string) => Promise<AgentMessageResource[]>;
  onChange?: (state: EditorState, isEmpty: boolean) => void;
  onSubmit?: (message: AgentMessageContent) => void;
  onCancel?: () => void;
  onOpenResource?: (resource: AgentMessageResource) => void;
}

interface ComposerCallbacks {
  disabled: boolean;
  submitEnabled: boolean;
  onChange?: AgentComposerInputProps["onChange"];
  onSubmit?: AgentComposerInputProps["onSubmit"];
  onCancel?: AgentComposerInputProps["onCancel"];
  onOpenResource?: AgentComposerInputProps["onOpenResource"];
}

interface SuggestionPosition {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
  placement: "above" | "below";
}

export const AgentComposerInput = forwardRef<AgentComposerInputHandle, AgentComposerInputProps>(
  function AgentComposerInput(
    {
      placeholder,
      state,
      disabled = false,
      submitEnabled = true,
      className,
      minHeightPx = 28,
      getResourceCandidates,
      onChange,
      onSubmit,
      onCancel,
      onOpenResource,
    },
    ref,
  ) {
    const hostRef = useRef<HTMLDivElement>(null);
    const viewRef = useRef<EditorView | null>(null);
    const callbacksRef = useRef<ComposerCallbacks>({ disabled, submitEnabled });
    const [suggestionPosition, setSuggestionPosition] = useState<SuggestionPosition | null>(null);
    callbacksRef.current = {
      disabled,
      submitEnabled,
      onChange,
      onSubmit,
      onCancel,
      onOpenResource,
    };

    const syncDomState = useCallback((view: EditorView) => {
      view.dom.toggleAttribute("data-empty", isAgentComposerEmpty(view.state));
      if (placeholder) view.dom.setAttribute("data-placeholder", placeholder);
      else view.dom.removeAttribute("data-placeholder");
    }, [placeholder]);

    useLayoutEffect(() => {
      const host = hostRef.current;
      if (!host) return;
      const view = new EditorView(host, {
        state,
        editable: () => !callbacksRef.current.disabled,
        attributes: {
          class: "stela-agent-composer__editor",
          role: "textbox",
          "aria-multiline": "true",
        },
        dispatchTransaction: (transaction) => {
          const next = view.state.apply(transaction);
          view.updateState(next);
          syncDomState(view);
          callbacksRef.current.onChange?.(next, isAgentComposerEmpty(next));
        },
        handleKeyDown: (currentView, event) => {
          const suggestion = agentComposerSuggestionKey.getState(currentView.state);
          if (suggestion?.active && ["ArrowDown", "ArrowUp", "Enter", "Escape"].includes(event.key)) {
            const acceptedCandidate = event.key === "Enter"
              ? suggestion.candidates[suggestion.selectedIndex]
              : undefined;
            const transaction = handleAgentComposerSuggestionKey(currentView.state, event.key);
            if (transaction) currentView.dispatch(transaction);
            if (acceptedCandidate) setSuggestionPosition(null);
            return true;
          }
          if (shouldSubmitPrompt(event, currentView.composing)) {
            if (callbacksRef.current.submitEnabled && !isAgentComposerEmpty(currentView.state)) {
              callbacksRef.current.onSubmit?.(agentComposerStateToMessage(currentView.state));
            }
            return true;
          }
          if (event.key === "Enter" && event.shiftKey && !event.isComposing && !currentView.composing) {
            currentView.dispatch(insertAgentComposerHardBreak(currentView.state));
            return true;
          }
          if (event.key === "Escape" && callbacksRef.current.onCancel) {
            callbacksRef.current.onCancel();
            return true;
          }
          return false;
        },
        handlePaste: (currentView, event) => {
          const text = event.clipboardData?.getData("text/plain");
          if (text === undefined) return false;
          event.preventDefault();
          currentView.dispatch(replaceAgentComposerSelectionWithText(currentView.state, text));
          return true;
        },
        handleDrop: (currentView, event) => {
          const text = event.dataTransfer?.getData("text/plain");
          if (!text) return false;
          event.preventDefault();
          currentView.dispatch(replaceAgentComposerSelectionWithText(currentView.state, text));
          return true;
        },
        handleClickOn: (currentView, _pos, node, _nodePos, event, direct) => {
          if (!direct || node.type.name !== AGENT_RESOURCE_NODE) return false;
          const resource = agentComposerResourceById(currentView.state, node.attrs.resourceId as string);
          if (!resource || !callbacksRef.current.onOpenResource) return false;
          event.preventDefault();
          callbacksRef.current.onOpenResource(resource);
          return true;
        },
        clipboardTextSerializer: agentComposerClipboardText,
      });
      viewRef.current = view;
      syncDomState(view);
      return () => {
        viewRef.current = null;
        view.destroy();
      };
    }, []);

    useEffect(() => {
      const view = viewRef.current;
      if (!view) return;
      if (view.state !== state) view.updateState(state);
      view.setProps({ editable: () => !disabled });
      syncDomState(view);
    }, [disabled, state, syncDomState]);

    useImperativeHandle(ref, () => ({
      focus: () => viewRef.current?.focus(),
    }), []);

    const suggestion = agentComposerSuggestionKey.getState(state);
    const activeSuggestion = suggestion?.active ?? null;
    const activeSuggestionKey = activeSuggestion
      ? agentComposerSuggestionRangeKey(activeSuggestion)
      : null;

    useEffect(() => {
      if (!activeSuggestion || !activeSuggestionKey || disabled) return;
      let cancelled = false;
      const timer = window.setTimeout(() => {
        void getResourceCandidates(activeSuggestion.query)
          .then((candidates) => {
            if (cancelled) return;
            const view = viewRef.current;
            if (!view) return;
            const transaction = setAgentComposerSuggestionCandidates(
              view.state,
              activeSuggestion,
              candidates.slice(0, 24),
            );
            if (transaction) view.dispatch(transaction);
          })
          .catch(() => {
            if (cancelled) return;
            const view = viewRef.current;
            if (!view) return;
            const transaction = setAgentComposerSuggestionCandidates(view.state, activeSuggestion, []);
            if (transaction) view.dispatch(transaction);
          });
      }, 40);
      return () => {
        cancelled = true;
        window.clearTimeout(timer);
      };
    }, [activeSuggestionKey, disabled, getResourceCandidates]);

    const updateSuggestionPosition = useCallback(() => {
      const view = viewRef.current;
      const active = agentComposerSuggestionKey.getState(view?.state ?? state)?.active;
      if (!view || !active) {
        setSuggestionPosition(null);
        return;
      }
      try {
        const coords = view.coordsAtPos(active.from);
        const viewport = window.visualViewport;
        setSuggestionPosition(placeAgentComposerSuggestions({
          anchorTop: coords.top,
          anchorBottom: coords.bottom,
          anchorLeft: coords.left,
          editorWidth: view.dom.getBoundingClientRect().width,
          viewportWidth: viewport?.width ?? window.innerWidth,
          viewportHeight: viewport?.height ?? window.innerHeight,
        }));
      } catch {
        setSuggestionPosition(null);
      }
    }, [state]);

    useLayoutEffect(() => {
      if (!activeSuggestion) {
        setSuggestionPosition(null);
        return;
      }
      updateSuggestionPosition();
      window.addEventListener("resize", updateSuggestionPosition);
      window.addEventListener("scroll", updateSuggestionPosition, true);
      return () => {
        window.removeEventListener("resize", updateSuggestionPosition);
        window.removeEventListener("scroll", updateSuggestionPosition, true);
      };
    }, [activeSuggestionKey, updateSuggestionPosition]);

    const acceptCandidate = (resource: AgentMessageResource, active: AgentComposerSuggestionRange) => {
      const view = viewRef.current;
      if (!view) return;
      setSuggestionPosition(null);
      view.dispatch(insertAgentComposerResourceTransaction(view.state, resource, {
        from: active.from,
        to: active.to,
        trailingSpaceAtEnd: true,
      }));
      view.focus();
    };

    return (
      <div
        className={cn("stela-agent-composer", disabled && "is-disabled", className)}
        style={{ minHeight: minHeightPx }}
        onMouseDown={(event) => {
          if (disabled || (event.target as HTMLElement).closest(".stela-agent-composer__editor")) return;
          event.preventDefault();
          viewRef.current?.focus();
        }}
      >
        <div ref={hostRef} className="contents" />
        {activeSuggestion && suggestionPosition && typeof document !== "undefined"
          ? createPortal(
              <div
                className="stela-agent-composer__suggestions"
                role="listbox"
                style={{
                  position: "fixed",
                  top: suggestionPosition.top,
                  left: suggestionPosition.left,
                  width: suggestionPosition.width,
                  maxHeight: suggestionPosition.maxHeight,
                  transform: suggestionPosition.placement === "above" ? "translateY(-100%)" : undefined,
                }}
                onMouseDown={(event) => event.preventDefault()}
              >
                {suggestion?.candidates.length ? suggestion.candidates.map((resource, index) => (
                  <button
                    key={`${resource.id}-${index}`}
                    type="button"
                    role="option"
                    aria-selected={index === suggestion.selectedIndex}
                    className="stela-agent-composer__suggestion"
                    onClick={() => acceptCandidate(resource, activeSuggestion)}
                  >
                    <span className={`stela-resource-kind stela-resource-kind--${resource.kind}`}>
                      {resource.kind}
                    </span>
                    <span className="truncate">{resource.label}</span>
                  </button>
                )) : (
                  <div className="stela-agent-composer__suggestion-empty">—</div>
                )}
              </div>,
              document.body,
            )
          : null}
      </div>
    );
  },
);
