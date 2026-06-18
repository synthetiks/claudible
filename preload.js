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
  // workspaces (the library a session lives in: legacy / local folder / private repo)
  workspaceList: () => ipcRenderer.invoke('workspace:list'),
  workspaceCreate: (kind, name) => ipcRenderer.invoke('workspace:create', { kind, name }),
  workspaceOpen: (id) => ipcRenderer.invoke('workspace:open', id),
  workspaceSetShared: (id, shared) => ipcRenderer.invoke('workspace:setShared', { id, shared }),
  workspaceRename: (id, label) => ipcRenderer.invoke('workspace:rename', { id, label }),
  repoInvite: (id, username) => ipcRenderer.invoke('repo:invite', { id, username }),
  skillsList: () => ipcRenderer.invoke('skills:list'),
  skillsSet: (name, state) => ipcRenderer.invoke('skills:set', { name, state }),
  pluginsList: () => ipcRenderer.invoke('plugins:list'),
  pluginsAvailable: () => ipcRenderer.invoke('plugins:available'),
  pluginsToggle: (key, enable) => ipcRenderer.invoke('plugins:toggle', { key, enable }),
  onWorkspaceActiveChanged: (cb) => ipcRenderer.on('workspace:active-changed', (_e, id) => cb(id)),
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
  onShareRoster: (cb) => ipcRenderer.on('share:roster', (_e, r) => cb(r)),
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
