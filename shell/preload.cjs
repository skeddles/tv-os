// Exposes `window.tv` to the launcher UI. The UI's matching types are in
// tv-launcher-ui/src/lib/bridge.ts — keep the two in step.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('tv', {
  listFlatpaks: () => ipcRenderer.invoke('tv:listFlatpaks'),
  listSteamGames: () => ipcRenderer.invoke('tv:listSteamGames'),
  launch: (target, label) => ipcRenderer.invoke('tv:launch', target, label),
  storeSearch: (query) => ipcRenderer.invoke('tv:storeSearch', query),
  storeDetails: (appIds) => ipcRenderer.invoke('tv:storeDetails', appIds),
  storeInstall: (appId) => ipcRenderer.invoke('tv:storeInstall', appId),
  storeUninstall: (appId) => ipcRenderer.invoke('tv:storeUninstall', appId),
  systemInfo: () => ipcRenderer.invoke('tv:systemInfo'),
  power: (action) => ipcRenderer.invoke('tv:power', action),
  onEvent: (cb) => {
    const listener = (_e, event) => cb(event)
    ipcRenderer.on('tv:event', listener)
    return () => ipcRenderer.removeListener('tv:event', listener)
  },
})
