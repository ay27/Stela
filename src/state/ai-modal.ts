import { create } from "zustand";

import type {
  AiCompleteRequest,
  AiCompleteResponse,
  AiActionKind,
} from "@shared/types";
import { i18n } from "@/i18n";

type AiModalPhase = "idle" | "loading" | "done" | "error";

export interface AiModalAction {
  label: string;
  run: (response: AiCompleteResponse) => void | Promise<void>;
  disabled?: (response: AiCompleteResponse) => boolean;
}

interface AiModalState {
  open: boolean;
  title: string;
  phase: AiModalPhase;
  request: AiCompleteRequest | null;
  response: AiCompleteResponse | null;
  error: string | null;
  actions: AiModalAction[];
  openRequest: (input: {
    title: string;
    request: AiCompleteRequest;
    actions?: AiModalAction[];
  }) => Promise<void>;
  rerunWithAction: (action: AiActionKind, title: string) => Promise<void>;
  close: () => void;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object" && "message" in err) {
    const msg = (err as { message?: unknown }).message;
    if (typeof msg === "string") return msg;
  }
  return String(err);
}

export const useAiModal = create<AiModalState>((set, get) => ({
  open: false,
  title: "",
  phase: "idle",
  request: null,
  response: null,
  error: null,
  actions: [],
  async openRequest({ title, request, actions = [] }) {
    const localizedRequest: AiCompleteRequest = {
      ...request,
      locale: i18n.resolvedLanguage?.startsWith("zh") ? "zh" : "en",
    };
    set({
      open: true,
      title,
      phase: "loading",
      request: localizedRequest,
      response: null,
      error: null,
      actions,
    });
    try {
      const response = await window.stela.ai.complete(localizedRequest);
      set({ phase: "done", response });
    } catch (err) {
      set({ phase: "error", error: errorMessage(err) });
    }
  },
  async rerunWithAction(action, title) {
    const request = get().request;
    if (!request) return;
    await get().openRequest({
      title,
      request: { ...request, action },
      actions: get().actions,
    });
  },
  close() {
    set({
      open: false,
      title: "",
      phase: "idle",
      request: null,
      response: null,
      error: null,
      actions: [],
    });
  },
}));

export function openAiModal(input: {
  title: string;
  request: AiCompleteRequest;
  actions?: AiModalAction[];
}): void {
  void useAiModal.getState().openRequest(input);
}

