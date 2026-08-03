const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("ocx", {
  state: () => ipcRenderer.invoke("state:get"),
  presets: () => ipcRenderer.invoke("presets:list"),
  visibilityLoad: (provider) => ipcRenderer.invoke("visibility:load", provider),
  visibilitySave: (payload) => ipcRenderer.invoke("visibility:save", payload),
  providerAdd: (payload) => ipcRenderer.invoke("provider:add", payload),
  onError: (cb) => ipcRenderer.on("dialog:error", (_e, msg) => cb(msg)),
  close: () => ipcRenderer.send("window:close"),
});
