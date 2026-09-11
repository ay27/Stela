import { contextBridge, ipcRenderer } from "electron";
contextBridge.exposeInMainWorld("canvasFixture", {
  read: () => ipcRenderer.invoke("fixture:read"),
  finish: (error?: string) => ipcRenderer.send("fixture:finish", error),
  screenshot: () => ipcRenderer.invoke("fixture:screenshot"),
});
