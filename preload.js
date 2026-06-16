// Claudible V2 — preload (context-isolated bridge)
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cv2', {
  // terminal
  ptyStart: (cols, rows) => ipcRenderer.send('pty:start', { cols, rows }),
  onPtyData: (cb) => ipcRenderer.on('pty:data', (_e, d) => cb(d)),
  ptyInput: (d) => ipcRenderer.send('pty:input', d),
  ptyResize: (cols, rows) => ipcRenderer.send('pty:resize', { cols, rows }),
  // audio
  stt: (arrayBuf) => ipcRenderer.invoke('stt', arrayBuf),
  tts: (text, voice) => ipcRenderer.invoke('tts', text, voice),
  // hooks + tracker
  onHookLine: (cb) => ipcRenderer.on('hook:line', (_e, l) => cb(l)),
  hookTest: () => ipcRenderer.invoke('hook:test'),
  onStatus: (cb) => ipcRenderer.on('status', (_e, s) => cb(s)),
  // meta
  endpoints: () => ipcRenderer.invoke('endpoints'),
  saveSession: (text) => ipcRenderer.invoke('save-session', text),
});
