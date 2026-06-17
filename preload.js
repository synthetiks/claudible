// Claudible — preload (context-isolated bridge)
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('claudible', {
  // terminal
  ptyStart: (cols, rows) => ipcRenderer.send('pty:start', { cols, rows }),
  onPtyData: (cb) => ipcRenderer.on('pty:data', (_e, d) => cb(d)),
  ptyInput: (d) => ipcRenderer.send('pty:input', d),
  ptyResize: (cols, rows) => ipcRenderer.send('pty:resize', { cols, rows }),
  // sessions (switcher)
  sessionList: () => ipcRenderer.invoke('session:list'),
  sessionOpen: (id) => ipcRenderer.invoke('session:open', id),
  sessionDelete: (id) => ipcRenderer.invoke('session:delete', id),
  // audio
  stt: (arrayBuf) => ipcRenderer.invoke('stt', arrayBuf),
  tts: (text, voice) => ipcRenderer.invoke('tts', text, voice),
  // hooks + tracker
  onHookLine: (cb) => ipcRenderer.on('hook:line', (_e, l) => cb(l)),
  hookTest: () => ipcRenderer.invoke('hook:test'),
  onStatus: (cb) => ipcRenderer.on('status', (_e, s) => cb(s)),
  // live terminal sharing
  shareStart: (opts) => ipcRenderer.invoke('share:start', opts || {}),
  shareStop: () => ipcRenderer.invoke('share:stop'),
  shareStatus: () => ipcRenderer.invoke('share:status'),
  shareNewLink: () => ipcRenderer.invoke('share:newlink'),
  shareApprove: (id, ok) => ipcRenderer.invoke('share:approve', { id, ok }),
  shareTracker: (s) => ipcRenderer.send('share:tracker', s),
  shareSendChat: (text) => ipcRenderer.send('share:chat-send', text),
  onShareChat: (cb) => ipcRenderer.on('share:chat', (_e, m) => cb(m)),
  onShareGuests: (cb) => ipcRenderer.on('share:guests', (_e, n) => cb(n)),
  onShareClaimed: (cb) => ipcRenderer.on('share:claimed', () => cb()),
  onShareApproval: (cb) => ipcRenderer.on('share:approval', (_e, info) => cb(info)),
  onShareApprovalCancel: (cb) => ipcRenderer.on('share:approval-cancel', (_e, id) => cb(id)),
  // meta
  endpoints: () => ipcRenderer.invoke('endpoints'),
  saveSession: (text) => ipcRenderer.invoke('save-session', text),
  // clipboard (handled in main so it works regardless of web clipboard permissions)
  clipWrite: (text) => ipcRenderer.invoke('clip:write', text),
  clipRead: () => ipcRenderer.invoke('clip:read'),
});
