// Claudible — preload (context-isolated bridge)
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('claudible', {
  // Durable settings (your Claudible username + every pref). The preload is SANDBOXED, so it can't touch fs — the
  // MAIN process owns the file (runtime/settings.json). sendSync gives a synchronous snapshot at load so the
  // renderer hydrates with no async; main writes synchronously, so a force-kill can't lose the value (the bug
  // localStorage had — its async LevelDB flush was dropped on a hard kill).
  settingsInitial: ipcRenderer.sendSync('settings:get'),
  settingsSave: (obj) => { try { return ipcRenderer.sendSync('settings:set', obj); } catch { return false; } },   // sendSync → main's writeFileSync completes before this returns (durable through a force-kill)
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
  sessionDelete: (id, scope) => ipcRenderer.invoke('session:delete', { id, scope }),
  sessionKeep: (id) => ipcRenderer.invoke('session:keep', { id }),   // "keep locally" a session deleted on GitHub
  exportSession: (id) => ipcRenderer.invoke('session:export', id),   // → shareable self-contained HTML replay
  exportSessionText: (id) => ipcRenderer.invoke('session:export-text', id),   // → plain Markdown (.md/.txt) transcript
  claudeVersion: () => ipcRenderer.invoke('claude:version'),   // the embedded Claude Code CLI version (for the status bar)
  // diff review (what Claude changed in the workspace's git repo)
  diffList: () => ipcRenderer.invoke('diff:list'),
  diffRevert: (patch) => ipcRenderer.invoke('diff:revert', patch),
  diffDiscard: (relPath) => ipcRenderer.invoke('diff:discard', relPath),
  // workspaces (the library a session lives in: legacy / local folder / private repo)
  workspaceList: () => ipcRenderer.invoke('workspace:list'),
  workspaceCreate: (kind, name, pick) => ipcRenderer.invoke('workspace:create', { kind, name, pick: !!pick }),
  workspaceOpen: (id) => ipcRenderer.invoke('workspace:open', id),
  workspaceAcceptInvite: (id, useDefault) => ipcRenderer.invoke('workspace:acceptInvite', { id, useDefault: !!useDefault }),   // choose clone dir + clone
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
  onShareApproval: (cb) => ipcRenderer.on('share:approval', (_e, info) => cb(info)),
  onShareApprovalCancel: (cb) => ipcRenderer.on('share:approval-cancel', (_e, id) => cb(id)),
  // voice room — audio frames are relayed through the share server (server-relayed PCM, not peer-to-peer)
  voiceJoin: (join) => ipcRenderer.send('share:voice', { join }),
  onVoiceMembers: (cb) => ipcRenderer.on('share:voice-members', (_e, m) => cb(m)),
  voiceAudio: (b64, sr) => ipcRenderer.send('share:audio-send', { data: b64, sr }),   // cockpit mic frame (+ rate) → guests
  onShareAudio: (cb) => ipcRenderer.on('share:audio', (_e, p) => cb(p)),           // guest voice frame → cockpit
  // live sessions — advertise the session I'm hosting; discover + join a collaborator's live session natively
  liveAdvertise: (sessionId, name) => ipcRenderer.invoke('live:advertise', { sessionId, name }),
  liveUnadvertise: () => ipcRenderer.invoke('live:unadvertise'),
  livePeers: () => ipcRenderer.invoke('live:peers'),
  liveJoin: (peer, name) => ipcRenderer.invoke('live:join', { peer, name }),   // open the peer's session in a SEPARATE window (fallback)
  // native joined tab: main holds a client WebSocket to the peer; the renderer draws a normal xterm tab and
  // co-drives over IPC (the renderer's CSP forbids a wss:// socket, so the socket lives in main).
  liveConnect: (tabId, peer, name) => ipcRenderer.invoke('live:connect', { tabId, peer, name }),
  liveDisconnect: (tabId) => ipcRenderer.invoke('live:disconnect', { tabId }),
  liveInput: (tabId, data) => ipcRenderer.send('live:input', { tabId, data }),          // a keystroke → the peer's terminal
  liveChatSend: (tabId, text) => ipcRenderer.send('live:chat-send', { tabId, text }),
  liveVoice: (tabId, join) => ipcRenderer.send('live:voice', { tabId, join }),
  liveAudioSend: (tabId, data, sr) => ipcRenderer.send('live:audio-send', { tabId, data, sr }),
  onLiveData: (cb) => ipcRenderer.on('live:data', (_e, { tabId, data }) => cb(tabId, data)),   // raw terminal bytes from the peer
  onLiveHello: (cb) => ipcRenderer.on('live:hello', (_e, p) => cb(p)),
  onLiveStatus: (cb) => ipcRenderer.on('live:status', (_e, p) => cb(p)),
  onLiveSize: (cb) => ipcRenderer.on('live:size', (_e, p) => cb(p)),
  onLivePaused: (cb) => ipcRenderer.on('live:paused', (_e, p) => cb(p)),
  onLiveChat: (cb) => ipcRenderer.on('live:chat', (_e, p) => cb(p)),
  onLiveRoster: (cb) => ipcRenderer.on('live:roster', (_e, p) => cb(p)),
  onLiveVoiceMembers: (cb) => ipcRenderer.on('live:voice-members', (_e, p) => cb(p)),
  onLiveAudio: (cb) => ipcRenderer.on('live:audio', (_e, p) => cb(p)),
  onLiveState: (cb) => ipcRenderer.on('live:state', (_e, p) => cb(p)),
  // shared session names — publish my rename + read the merged map (everyone in the workspace sees the same title)
  titleSet: (id, name) => ipcRenderer.invoke('title:set', { id, name }),
  titleList: () => ipcRenderer.invoke('title:list'),
  // meta
  endpoints: () => ipcRenderer.invoke('endpoints'),
  saveSession: (text) => ipcRenderer.invoke('save-session', text),
  // clipboard (handled in main so it works regardless of web clipboard permissions)
  clipWrite: (text) => ipcRenderer.invoke('clip:write', text),
  clipRead: () => ipcRenderer.invoke('clip:read'),
});
