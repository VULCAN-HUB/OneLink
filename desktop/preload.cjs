const { contextBridge, ipcRenderer, webUtils } = require('electron');
contextBridge.exposeInMainWorld('oneLink', {
  command: async (name, args) => { const result = await ipcRenderer.invoke('command', name, args); if (!result.ok) throw new Error(result.error); return result.value; },
  onState: callback => { const handler = (_event, state) => callback(state); ipcRenderer.on('state', handler); return () => ipcRenderer.removeListener('state', handler); },
  onUpdate: callback => { const handler = (_event, state) => callback(state); ipcRenderer.on('update-state', handler); return () => ipcRenderer.removeListener('update-state', handler); },
  pathsForFiles: files => files.map(file => webUtils.getPathForFile(file)).filter(Boolean)
});
