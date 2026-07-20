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
  // sessions (switcher) — every call names its workspace explicitly: main's activeWorkspace and the sidebar's
  // notion of "active" can legitimately differ (a joined live tab moves the sidebar but never main), so an
  // ambient call would read/mutate whatever workspace MAIN happens to be on, not the one the row is under.
  // endShare: this tab is the LIVE-SHARED one and the session it holds is being deleted. Main freezes the mirror
  // and allows the re-point — every other attempt to move the pinned tab off its session is refused outright.
  sessionOpen: (tabId, id, endShare) => ipcRenderer.invoke('session:open', { tabId, id, endShare: !!endShare }),
  sessionDelete: (id, scope, wsId) => ipcRenderer.invoke('session:delete', { id, scope, wsId }),
  sessionKeep: (id, wsId) => ipcRenderer.invoke('session:keep', { id, wsId }),   // "keep locally" a session deleted on GitHub
  resolveDiverged: (id, strategy, wsId) => ipcRenderer.invoke('session:resolveDiverged', { id, strategy, wsId }),   // out-of-sync fork → 'remote' (take theirs) | 'local' (keep mine)
  exportSession: (id, wsId) => ipcRenderer.invoke('session:export', { id, wsId }),   // → shareable self-contained HTML replay
  exportSessionText: (id, wsId) => ipcRenderer.invoke('session:export-text', { id, wsId }),   // → plain Markdown (.md/.txt) transcript
  claudeVersion: () => ipcRenderer.invoke('claude:version'),   // the embedded Claude Code CLI version (for the status bar)
  appVersion: () => ipcRenderer.invoke('app:version'),   // Claudible's own version (package.json) for the status-bar badge
  buildSha: () => ipcRenderer.invoke('app:buildSha'),    // the running build's git sha — identifies unreleased builds semver can't
  latestReply: (id) => ipcRenderer.invoke('session:latest-reply', id),   // a session's last assistant reply (for manual Speak / re-listen)
  // first-run onboarding wizard (connect Claude → workspace → GitHub)
  onboardStatus: () => ipcRenderer.invoke('onboard:status'),             // { claudeInstalled, claudeSignedIn, claudeVersion, ghInstalled, ghSignedIn, ghAccount, voiceReady, voiceProvisioning }
  onboardInstallClaude: () => ipcRenderer.invoke('onboard:install-claude'),
  onboardClaudeLogin: () => ipcRenderer.invoke('onboard:claude-login'),
  // self-bootstrapping dependency provisioner (the "System check" wizard step)
  preflightStatus: () => ipcRenderer.invoke('preflight:status'),        // { runner, gitBash, deps: [{ id, label, hint, state, version, account, required, auth, authSoft, installable, restartOnInstall, requires }] }
  preflightInstall: (depId) => ipcRenderer.invoke('preflight:install', depId),   // → { ok, error, restartRequired }; progress streams via onProvision({dep,phase,msg})
  preflightRestart: () => ipcRenderer.invoke('preflight:restart'),
  // Connect-Claude button/popup: main fires 'claude:needed' when a spawn finds no claude; renderer pops the dialog
  onClaudeNeeded: (cb) => ipcRenderer.on('claude:needed', () => cb()),
  claudeConnected: () => ipcRenderer.invoke('claude:connected'),   // bring the terminal up after connecting
  claudeState: () => ipcRenderer.invoke('claude:state'),           // cheap claude-only {installed,signedIn} for the dot/popup
  // diff review (what Claude changed in the workspace's git repo)
  diffList: (wsId) => ipcRenderer.invoke('diff:list', { wsId }),
  diffRevert: (patch, wsId) => ipcRenderer.invoke('diff:revert', { patch, wsId }),      // wsId = the project whose card this button lives on (Project History reviews many at once) — main must mutate THAT repo, not whatever's active
  diffDiscard: (relPath, wsId) => ipcRenderer.invoke('diff:discard', { relPath, wsId }),
  // session history (the append-only activity log behind the Repo Review feed + revert; gated by the sessionHistory setting)
  historyAppend: (prompt, session, wsId, tabId) => ipcRenderer.invoke('history:append', { prompt, session, wsId, tabId }),   // renderer sends the raw prompt + submitting tab's workspace + tabId; main stamps id/seq/author/machine and attributes co-drive by tabId
  historyLoad: (wsId) => ipcRenderer.invoke('history:load', { wsId }),
  checkpointRevert: (id, wsId) => ipcRenderer.invoke('checkpoint:revert', { id, wsId }),   // roll the workspace repo back to a prompt's code snapshot
  checkpointUndo: (wsId) => ipcRenderer.invoke('checkpoint:undo', { wsId }),                // undo the last revert (restores the pre-revert tree)
  // workspaces (the library a session lives in: legacy / local folder / private repo)
  workspaceList: () => ipcRenderer.invoke('workspace:list'),
  workspaceFirstRunDone: () => ipcRenderer.invoke('workspace:firstRunDone'),
  workspaceCreate: (kind, name, pick) => ipcRenderer.invoke('workspace:create', { kind, name, pick: !!pick }),
  workspaceAdopt: (name) => ipcRenderer.invoke('workspace:adopt', { name }),   // point at a folder that already exists (never moves/publishes/deletes it)
  workspaceUpgrade: (id) => ipcRenderer.invoke('workspace:upgrade', id),   // local → synced (private repo) so it appears on other devices + can be shared
  workspaceOpen: (id, session) => ipcRenderer.invoke('workspace:open', id, session),   // session id → open it directly on switch
  workspaceAcceptInvite: (id, useDefault) => ipcRenderer.invoke('workspace:acceptInvite', { id, useDefault: !!useDefault }),   // choose clone dir + clone
  workspaceSetShared: (id, shared) => ipcRenderer.invoke('workspace:setShared', { id, shared }),
  workspaceRename: (id, label) => ipcRenderer.invoke('workspace:rename', { id, label }),
  workspaceDelete: (id) => ipcRenderer.invoke('workspace:delete', id),
  workspaceReorder: (ids) => ipcRenderer.invoke('workspace:reorder', ids),
  effortGet: () => ipcRenderer.invoke('effort:get'),
  effortSet: (level) => ipcRenderer.invoke('effort:set', level),
  permissionModeGet: () => ipcRenderer.invoke('permissionMode:get'),
  permissionModeSet: (mode) => ipcRenderer.invoke('permissionMode:set', mode),   // 'default' | 'acceptEdits' | 'bypass'
  modelStrategyGet: () => ipcRenderer.invoke('modelStrategy:get'),
  modelStrategySet: (v) => ipcRenderer.invoke('modelStrategy:set', v),           // 'planBigExecSmall' (default) | 'off'
  repoInvite: (id, username) => ipcRenderer.invoke('repo:invite', { id, username }),
  skillsList: () => ipcRenderer.invoke('skills:list'),
  skillsSet: (name, state) => ipcRenderer.invoke('skills:set', { name, state }),
  pluginsList: () => ipcRenderer.invoke('plugins:list'),
  pluginsAvailable: () => ipcRenderer.invoke('plugins:available'),
  pluginsToggle: (key, enable) => ipcRenderer.invoke('plugins:toggle', { key, enable }),
  onWorkspaceActiveChanged: (cb) => ipcRenderer.on('workspace:active-changed', (_e, p) => cb(p)),   // { id, tabId } — tabId = the tab main actually re-pointed
  // shared-session sync (repo workspaces): same sessions across collaborators, over the repo's git
  syncSetEnabled: (id, enabled) => ipcRenderer.invoke('session:syncSetEnabled', { id, enabled }),
  syncNow: (id) => ipcRenderer.invoke('session:syncNow', id),
  onSyncState: (cb) => ipcRenderer.on('sync:state', (_e, s) => cb(s)),
  onSyncChanged: (cb) => ipcRenderer.on('sync:changed', (_e, s) => cb(s)),
  onSessionReloaded: (cb) => ipcRenderer.on('session:reloaded', (_e, s) => cb(s)),   // main respawned an open tab whose transcript a sync just replaced
  onWorkspaceAdded: (cb) => ipcRenderer.on('workspace:added', (_e, list) => cb(list)),
  discoverWorkspaces: () => ipcRenderer.invoke('workspace:discover'),   // manual "check for invited projects"
  openExternal: (url) => ipcRenderer.invoke('open-external', url),   // open a repo URL in the real browser
  sessionListWs: (wsId) => ipcRenderer.invoke('session:list-ws', wsId),   // list a (possibly non-active) workspace's sessions
  // audio
  stt: (arrayBuf) => ipcRenderer.invoke('stt', arrayBuf),
  tts: (text, voice) => ipcRenderer.invoke('tts', text, voice),
  // hooks + tracker
  onHookLine: (cb) => ipcRenderer.on('hook:line', (_e, { tabId, line }) => cb(tabId, line)),
  // Per-tab turn-busy, decided by main (the ONE writer — see setGenBusy). The renderer mirrors it and must never
  // derive its own: main clears busy on pty exit / session switch / tab close / a quiet-pty self-heal, and a
  // renderer copy armed by hooks alone can only ever be disarmed by a Stop that may never come.
  onTabBusy: (cb) => ipcRenderer.on('tab:busy', (_e, { tabId, busy }) => cb(tabId, !!busy)),
  onWorkflowAgents: (cb) => ipcRenderer.on('workflow:agents', (_e, { tabId, workflows }) => cb(tabId, workflows)),
  onAgentTokens: (cb) => ipcRenderer.on('agent-tokens', (_e, { tabId, agentTok }) => cb(tabId, agentTok)),
  onStatus: (cb) => ipcRenderer.on('status', (_e, s) => cb(s)),   // s carries s.tabId
  onProvision: (cb) => ipcRenderer.on('provision', (_e, m) => cb(m)),   // first-run voice setup progress {phase,msg}
  // live terminal sharing
  shareStart: (opts) => ipcRenderer.invoke('share:start', opts || {}),
  shareStop: () => ipcRenderer.invoke('share:stop'),
  shareNewLink: () => ipcRenderer.invoke('share:newlink'),
  shareKick: (name) => ipcRenderer.invoke('share:kick', { name }),   // host removes one guest by name
  shareApprove: (id, ok) => ipcRenderer.invoke('share:approve', { id, ok }),
  shareTracker: (s) => ipcRenderer.send('share:tracker', s),
  shareSendChat: (text) => ipcRenderer.send('share:chat-send', text),
  onShareChat: (cb) => ipcRenderer.on('share:chat', (_e, m) => cb(m)),
  onShareGuests: (cb) => ipcRenderer.on('share:guests', (_e, n) => cb(n)),
  onSharePinned: (cb) => ipcRenderer.on('share:pinned', (_e, p) => cb(p)),   // { tabId } the live mirror is pinned to (null = share ended)
  onShareRerouteRefused: (cb) => ipcRenderer.on('share:reroute-refused', (_e, p) => cb(p)),   // main protected the live session: the pinned tab was NOT moved off it
  onShareForceEnd: (cb) => ipcRenderer.on('share:force-end', (_e, p) => cb(p)),   // the live session's workspace was deleted → the share cannot survive; tear the tunnel down
  onShareTypist: (cb) => ipcRenderer.on('share:typist', (_e, p) => cb(p)),   // { name } a guest is typing into the session I host
  onLiveTypist: (cb) => ipcRenderer.on('live:typist', (_e, p) => cb(p)),     // { tabId, name } someone is typing in a session I joined
  onShareRoster: (cb) => ipcRenderer.on('share:roster', (_e, r) => cb(r)),
  onShareTunnelDown: (cb) => ipcRenderer.on('share:tunnel-down', (_e) => cb()),   // public tunnel dropped while sharing
  onShareTunnelUp: (cb) => ipcRenderer.on('share:tunnel-up', (_e, p) => cb(p)),   // { url } public tunnel is live — a fresh share, or the background self-heal recovered it
  onUpdateAvailable: (cb) => ipcRenderer.on('update:available', (_e, p) => cb(p)),   // a newer GitHub release exists (packaged builds only; notice-only, nothing auto-installs)
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
  livePeers: (wsId) => ipcRenderer.invoke('live:peers', wsId),   // peers on THIS workspace's presence branch, never main's ambient one
  onAdvertiseLost: (cb) => ipcRenderer.on('live:advertise-lost', (_e, p) => cb(p)),   // the presence heartbeat lost the one-host-per-session claim (a collaborator went live while ours was stale) — UI must stop saying "sharing"
  onLivePeersPush: (cb) => ipcRenderer.on('live:peers-push', (_e, p) => cb(p)),       // { id, peers } main's beacon saw this workspace's shared branch move and already read the fresh presence — paint it now, no extra round-trip
  onBuildDrift: (cb) => ipcRenderer.on('build:drift', (_e, p) => cb(p)),             // { running, disk } a git pull moved the files under this running process — show the restart chip
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
  onLiveHistory: (cb) => ipcRenderer.on('live:history', (_e, p) => cb(p)),   // the host's Session-History feed for a joined tab (view-only)
  // shared session names — publish my rename + read the merged map (everyone in the workspace sees the same title)
  titleSet: (id, name, wsId) => ipcRenderer.invoke('title:set', { id, name, wsId }),
  titleList: (wsId) => ipcRenderer.invoke('title:list', wsId),
  // meta
  endpoints: () => ipcRenderer.invoke('endpoints'),
  // clipboard (handled in main so it works regardless of web clipboard permissions)
  clipWrite: (text) => ipcRenderer.invoke('clip:write', text),
  clipRead: () => ipcRenderer.invoke('clip:read'),
});
