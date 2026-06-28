import { i18n } from "./index";

import type { IpcErrorPayload } from "@shared/types";

const CODE_TO_KEY: Record<string, string> = {
  no_vault: "errors.noVault",
  unknown_kind: "errors.unknownKind",
};

export function translateIpcError(err: unknown): string {
  const payload = err as Partial<IpcErrorPayload> | undefined;
  const key = payload?.code ? CODE_TO_KEY[payload.code] : undefined;
  if (key) return i18n.t(key);
  if (payload?.message) return payload.message;
  if (err instanceof Error) return err.message;
  return i18n.t("errors.generic");
}
