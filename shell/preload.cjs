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
  typeText: (text, enter) => ipcRenderer.invoke('tv:typeText', text, enter),
  cancelTyping: () => ipcRenderer.invoke('tv:cancelTyping'),
  getDisplay: () => ipcRenderer.invoke('tv:getDisplay'),
  setDisplay: (opts) => ipcRenderer.invoke('tv:setDisplay', opts),
  resetInputPrefs: () => ipcRenderer.invoke('tv:resetInputPrefs'),
  resumeApp: () => ipcRenderer.invoke('tv:resumeApp'),
  quitApp: () => ipcRenderer.invoke('tv:quitApp'),
  osUpdateStatus: () => ipcRenderer.invoke('tv:osUpdateStatus'),
  osUpdateCheck: () => ipcRenderer.invoke('tv:osUpdateCheck'),
  osUpdateDownload: () => ipcRenderer.invoke('tv:osUpdateDownload'),
  getVolume: () => ipcRenderer.invoke('tv:getVolume'),
  changeVolume: (step) => ipcRenderer.invoke('tv:changeVolume', step),
  onEvent: (cb) => {
    const listener = (_e, event) => cb(event)
    ipcRenderer.on('tv:event', listener)
    return () => ipcRenderer.removeListener('tv:event', listener)
  },
})
