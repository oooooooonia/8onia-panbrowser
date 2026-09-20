import { contextBridge, ipcRenderer } from 'electron'

/** 最小化 preload：仅暴露系统对话框/版本等原生能力；业务全部走本地 HTTP API */
const api = {
  selectDirectory: () => ipcRenderer.invoke('dialog:selectDirectory'),
  selectFile: () => ipcRenderer.invoke('dialog:selectFile'),
  version: () => ipcRenderer.invoke('app:version'),
  quitApp: () => ipcRenderer.invoke('app:quit')
}

contextBridge.exposeInMainWorld('pan', api)
