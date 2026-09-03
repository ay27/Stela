import { useEffect, useRef } from "react";

import { indentWithTab } from "@codemirror/commands";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { basicSetup } from "codemirror";

import { currentCmTheme, subscribeCmTheme } from "./runsql/cm-theme";
import { recallScroll, rememberScroll } from "./scroll-memory";
import { detectLineSeparator, sourceLanguageForPath } from "./source-file-mode";

import "./source-text-editor.css";

interface SourceTextEditorProps {
  path: string;
  initialText: string;
  onBufferChange: (next: string) => void;
  onDirtyChange: (dirty: boolean) => void;
  onPersist: (next: string) => Promise<void>;
  shouldFlushOnUnmount: () => boolean;
}

const PERSIST_DEBOUNCE_MS = 800;

export function SourceTextEditor({
  path,
  initialText,
  onBufferChange,
  onDirtyChange,
  onPersist,
  shouldFlushOnUnmount,
}: SourceTextEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const onBufferChangeRef = useRef(onBufferChange);
  const onDirtyChangeRef = useRef(onDirtyChange);
  const onPersistRef = useRef(onPersist);
  const shouldFlushOnUnmountRef = useRef(shouldFlushOnUnmount);

  useEffect(() => {
    onBufferChangeRef.current = onBufferChange;
    onDirtyChangeRef.current = onDirtyChange;
    onPersistRef.current = onPersist;
    shouldFlushOnUnmountRef.current = shouldFlushOnUnmount;
  }, [onBufferChange, onDirtyChange, onPersist, shouldFlushOnUnmount]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let destroyed = false;
    let persistTimer: ReturnType<typeof setTimeout> | null = null;
    let persistChain: Promise<void> = Promise.resolve();
    let editVersion = 0;
    let queuedVersion = 0;
    let latestText = initialText;
    const themeCompartment = new Compartment();
    const languageCompartment = new Compartment();

    const queuePersist = (text: string, version: number) => {
      queuedVersion = version;
      persistChain = persistChain
        .catch(() => undefined)
        .then(() => onPersistRef.current(text))
        .then(() => {
          if (version === editVersion) {
            onDirtyChangeRef.current(false);
          }
        })
        .catch((error: unknown) => {
          console.error("[stela] source file persist failed", error);
        });
    };

    const state = EditorState.create({
      doc: initialText,
      extensions: [
        basicSetup,
        EditorState.lineSeparator.of(detectLineSeparator(initialText)),
        keymap.of([indentWithTab]),
        EditorView.lineWrapping,
        themeCompartment.of(currentCmTheme()),
        languageCompartment.of([]),
        EditorView.contentAttributes.of({
          "aria-label": `Source editor: ${path}`,
          spellcheck: "false",
        }),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return;
          latestText = update.state.sliceDoc();
          editVersion += 1;
          onBufferChangeRef.current(latestText);
          onDirtyChangeRef.current(true);
          if (persistTimer) clearTimeout(persistTimer);
          const version = editVersion;
          persistTimer = setTimeout(() => {
            persistTimer = null;
            queuePersist(latestText, version);
          }, PERSIST_DEBOUNCE_MS);
        }),
      ],
    });

    const view = new EditorView({ state, parent: host });
    const unsubscribeTheme = subscribeCmTheme(() => {
      if (destroyed) return;
      view.dispatch({
        effects: themeCompartment.reconfigure(currentCmTheme()),
      });
    });

    const language = sourceLanguageForPath(path);
    if (language) {
      void language
        .load()
        .then((support) => {
          if (destroyed) return;
          view.dispatch({
            effects: languageCompartment.reconfigure(support),
          });
        })
        .catch((error: unknown) => {
          console.error(
            `[stela] failed to load source language for ${path}`,
            error,
          );
        });
    }

    const restoreFrame = requestAnimationFrame(() => {
      const remembered = recallScroll(path);
      if (remembered !== undefined) view.scrollDOM.scrollTop = remembered;
    });
    const rememberCurrentScroll = () => {
      rememberScroll(path, view.scrollDOM.scrollTop);
    };
    view.scrollDOM.addEventListener("scroll", rememberCurrentScroll, {
      passive: true,
    });

    return () => {
      destroyed = true;
      cancelAnimationFrame(restoreFrame);
      rememberCurrentScroll();
      view.scrollDOM.removeEventListener("scroll", rememberCurrentScroll);
      unsubscribeTheme();
      if (persistTimer) {
        clearTimeout(persistTimer);
        persistTimer = null;
      }
      if (editVersion > queuedVersion && shouldFlushOnUnmountRef.current()) {
        queuePersist(latestText, editVersion);
      }
      view.destroy();
    };
    // A path/reload key remounts this component. Persisting must not recreate the
    // editor merely because the parent receives the newly saved text.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  return <div ref={hostRef} className="stela-source-editor" />;
}
