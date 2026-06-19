// Claudible — preload (context-isolated bridge)
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('claudible', {
  // terminal (per-tab: every channel carries a tabId so N live ptys/xterms can coexist)
  ptyStart: (tabId, cols, rows) => ipcRenderer.send('pty:start', { tabId, cols, rows }),
  onPtyData: (cb) => ipcRenderer.on('pty:data', (_e, { tabId, data }) => cb(tabId, data)),
  ptyInput: (tabId, d) => ipcRenderer.send('pty:input', { tabId, data: d }),
  ptyResize: (tabId, cols, rows) => ipcRenderer.send('pty:resize', { tabId, cols, rows }),
  // tabs (lifecycle): record intent → start → foreground → close
  tabOpen: (tabId, wsId, session) => ipcRenderer.invoke('tab:open', { tabId, wsId, session }),
  tabClose: (tabId) => ipcRenderer.invoke('tab:close', { tabId }),
  tabForeground: (tabId) => ipcRenderer.send('pty:foreground', { tabId }),
  // sessions (switcher)
  sessionList: () => ipcRenderer.invoke('session:list'),
  sessionOpen: (tabId, id) => ipcRenderer.invoke('session:open', { tabId, id }),
  sessionDelete: (id) => ipcRenderer.invoke('session:delete', id),
  exportSession: (id) => ipcRenderer.invoke('session:export', id),   // → shareable self-contained HTML replay
  // diff review (what Claude changed in the workspace's git repo)
  diffList: () => ipcRenderer.invoke('diff:list'),
  diffRevert: (patch) => ipcRenderer.invoke('diff:revert', patch),
  diffDiscard: (relPath) => ipcRenderer.invoke('diff:discard', relPath),
  // workspaces (the library a session lives in: legacy / local folder / private repo)
  workspaceList: () => ipcRenderer.invoke('workspace:list'),
  workspaceCreate: (kind, name, pick) => ipcRenderer.invoke('workspace:create', { kind, name, pick: !!pick }),
  workspaceOpen: (id) => ipcRenderer.invoke('workspace:open', id),
  workspaceSetShared: (id, shared) => ipcRenderer.invoke('workspace:setShared', { id, shared }),
  workspaceRename: (id, label) => ipcRenderer.invoke('workspace:rename', { id, label }),
  workspaceDelete: (id) => ipcRenderer.invoke('workspace:delete', id),
  workspaceReorder: (ids) => ipcRenderer.invoke('workspace:reorder', ids),
  effortGet: () => ipcRenderer.invoke('effort:get'),
  effortSet: (level) => ipcRenderer.invoke('effort:set', level),
  repoInvite: (id, username) => ipcRenderer.invoke('repo:invite', { id, username }),
  skillsList: () => ipcRenderer.invoke('skills:list'),
  skillsSet: (name, state) => ipcRenderer.invoke('skills:set', { name, state }),
  pluginsList: () => ipcRenderer.invoke('plugins:list'),
  pluginsAvailable: () => ipcRenderer.invoke('plugins:available'),
  pluginsToggle: (key, enable) => ipcRenderer.invoke('plugins:toggle', { key, enable }),
  onWorkspaceActiveChanged: (cb) => ipcRenderer.on('workspace:active-changed', (_e, id) => cb(id)),
  // shared-session sync (repo workspaces): same sessions across collaborators, over the repo's git
  syncStatus: (id) => ipcRenderer.invoke('session:syncStatus', id),
  syncSetEnabled: (id, enabled) => ipcRenderer.invoke('session:syncSetEnabled', { id, enabled }),
  syncNow: (id) => ipcRenderer.invoke('session:syncNow', id),
  workspaceDiscover: () => ipcRenderer.invoke('workspace:discover'),
  onSyncState: (cb) => ipcRenderer.on('sync:state', (_e, s) => cb(s)),
  onSyncChanged: (cb) => ipcRenderer.on('sync:changed', (_e, s) => cb(s)),
  onWorkspaceAdded: (cb) => ipcRenderer.on('workspace:added', (_e, list) => cb(list)),
  // audio
  stt: (arrayBuf) => ipcRenderer.invoke('stt', arrayBuf),
  tts: (text, voice) => ipcRenderer.invoke('tts', text, voice),
  // hooks + tracker
  onHookLine: (cb) => ipcRenderer.on('hook:line', (_e, { tabId, line }) => cb(tabId, line)),
  onWorkflowAgents: (cb) => ipcRenderer.on('workflow:agents', (_e, { tabId, workflows }) => cb(tabId, workflows)),
  onAgentTokens: (cb) => ipcRenderer.on('agent-tokens', (_e, { tabId, agentTok }) => cb(tabId, agentTok)),
  hookTest: () => ipcRenderer.invoke('hook:test'),
  onStatus: (cb) => ipcRenderer.on('status', (_e, s) => cb(s)),   // s carries s.tabId
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
