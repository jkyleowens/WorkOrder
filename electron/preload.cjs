const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("workspace", {
  read: () => ipcRenderer.invoke("workspace:read"),
  save: (data) => ipcRenderer.invoke("workspace:save", data),
});
