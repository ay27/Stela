import { app } from "electron";
import path from "node:path";

const IS_DEV = !!process.env.ELECTRON_RENDERER_URL;

/** Read-only System Skills shipped with Stela. */
export function bundledSystemSkillsRoot(): string {
  return IS_DEV
    ? path.join(app.getAppPath(), "resources", "playbooks")
    : path.join(process.resourcesPath, "playbooks");
}
