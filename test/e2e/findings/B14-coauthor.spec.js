// test/e2e/findings/B14-coauthor.spec.js — HARDWARE-SMOKE-RESULTS.md finding B14 (CRAZY SOLO, "FAIL"): "This
// session's own results commit, made with MK live in the session, fired NO co-author hook — the trailer had
// to be added by hand. The OFF-by-default is correct, but the live-session default-on crediting isn't wired
// into real terminal commits."
//
// C-10.6: "by default, a commit made while a Claudible live session is running credits everyone in that live
// session as co-authors." The REAL mechanism (main.js's _syncCoauthorHookNow, ~3953, wired to share's onRoster
// callback) installs a `prepare-commit-msg` git hook (lib/coauthorHook.js) in the shared repo's OWN .git/hooks
// the moment a guest with a resolvable identity is connected to a live share on that repo workspace.
//
// SETUP: a repo workspace, seeded with `collaborators: [{login, id}]` (the shape repo:invite would have
// recorded) whose login case-insensitively matches the guest's typed display name — buildCoauthorLines
// (lib/coauthorHook.js) SKIPS any roster entry it cannot match to a login/email rather than fabricate an
// address, so an unmatched guest name would never produce a trailer regardless of whether the feature works.
//
// COMMIT PATH: the mission suggests driving this through the shared session's terminal (fake-claude "can exec
// git"). fake-claude (test/e2e/fake-claude/fake-claude.js) only ECHOES stdin — it is not a shell and cannot run
// `git commit` for real (see its own file header: "not a claude.exe fake in the visual-fidelity sense"). The
// REAL mechanism under test is a git hook file that fires on ANY `git commit` in that working tree, regardless
// of which process invoked git — Claude, a human, or this harness — so this spec runs the commit directly via
// child_process against the SAME clone the hook was installed into. This is a deliberate, documented departure
// from routing bytes through the pty: it tests the actual C-10.6 mechanism (the hook) without needing to teach
// the harness's terminal shim to be a real shell, which would be its own large (and separately risky) change.
'use strict';
const { test, expect, chromium } = require('playwright/test');
const path = require('path');
const fs = require('fs');
const cp = require('child_process');
const {
  launchClaudible, seedRepoWorkspace, seedAdoptedRepoWorkspace, writeFakeTranscript, localBareRemote,
  resolveGitBash, waitForAppReady,
} = require('../_fixtures');

test('a commit made while a live session is running credits the connected guest as Co-authored-by (C-10.6)', async () => {
  test.setTimeout(90000);
  const gitBash = resolveGitBash();
  test.skip(!gitBash, 'no usable git-bash found on this machine — session listing / the coauthor hook script both require it');

  let guestBrowser = null, host = null, guestPage = null;
  try {
    guestBrowser = await chromium.launch();
    const remote = localBareRemote();
    const guestLogin = 'e2eguestb14';
    const guestId = 999999;
    let ws = null;
    const sid = 'e2e-coauthor-' + Date.now();

    host = await launchClaudible({
      withClaude: true,
      withGh: true,
      gitBash,
      env: { CLAUDIBLE_CLOUDFLARED: process.execPath },   // force the documented loopback fallback — hermetic, no real cloudflared/network
      seed: (ctx) => {
        ws = seedRepoWorkspace(ctx, {
          slug: 'coauthor-proj', owner: 'crazy-e2e', remote,
          collaborators: [{ login: guestLogin, id: guestId }],
        });
        writeFakeTranscript(ctx, ws, sid, 'a real session for the coauthor hook to attach to');
        const wsFile = path.join(ctx.persist, 'workspaces.json');
        const reg = JSON.parse(fs.readFileSync(wsFile, 'utf8'));
        reg.activeId = ws.id;   // boot straight into this project's session — "a live session running" per C-10.6
        fs.writeFileSync(wsFile, JSON.stringify(reg));
      },
    });

    await expect(host.page).toHaveTitle(/./, { timeout: 30000 });
    await waitForAppReady(host.page);   // see _fixtures.js — <title> can resolve before app.js has even started under cross-spec load
    await expect.poll(() => host.page.evaluate(() => activeSession), { timeout: 20000 }).toBe(sid);

    // ---- go live (a plain web link is enough — C-10.6 only cares that the PINNED tab's workspace is a repo
    // with a resolvable path; it does not distinguish collab-toggle shares from "Share a live link") ----------
    await host.page.locator('#share-btn').click();
    await expect(host.page.locator('#namemodal')).toHaveClass(/show/, { timeout: 10000 });
    await host.page.locator('#host-name-in').fill('crazy-e2e-b14-host');
    await host.page.locator('#name-start').click();
    const shareLink = host.page.locator('#share-link');
    await expect(shareLink).toBeVisible({ timeout: 20000 });
    await expect.poll(async () => (await shareLink.inputValue()) || '', { timeout: 20000 }).not.toBe('');
    const url = await shareLink.inputValue();

    // ---- a real browser guest joins, typing the EXACT login the workspace's collaborators record ----------
    const guestContext = await guestBrowser.newContext();
    guestPage = await guestContext.newPage();
    await guestPage.goto(url);
    await expect(guestPage.locator('#name-overlay')).toBeVisible({ timeout: 10000 });
    await guestPage.locator('#name-in').fill(guestLogin);
    await guestPage.locator('#name-go').click();
    const approveModal = host.page.locator('#approve');
    await expect(approveModal).toHaveClass(/show/, { timeout: 15000 });
    await host.page.locator('#approve-yes').click();
    await expect(guestPage.locator('body')).toHaveClass(/connected/, { timeout: 15000 });

    // ---- wait for the REAL hook to land on disk (main's roster->hook sync is async; poll the actual file
    // rather than guess a sleep) ------------------------------------------------------------------------------
    const gitDirOut = cp.execFileSync('git', ['rev-parse', '--git-dir'], { cwd: ws.path, encoding: 'utf8' }).trim();
    const gitDir = path.isAbsolute(gitDirOut) ? gitDirOut : path.join(ws.path, gitDirOut);
    const hookPath = path.join(gitDir, 'hooks', 'prepare-commit-msg');
    const coauthorsPath = path.join(gitDir, 'claudible-coauthors');
    await expect.poll(() => fs.existsSync(hookPath) && fs.readFileSync(hookPath, 'utf8').includes('claudible:coauthor-hook'), {
      timeout: 20000, message: 'expected the prepare-commit-msg hook to be installed once the guest is connected',
    }).toBe(true);
    await expect.poll(() => fs.existsSync(coauthorsPath) ? fs.readFileSync(coauthorsPath, 'utf8') : '', {
      timeout: 20000, message: 'expected the claudible-coauthors file to name the connected guest',
    }).toContain(guestLogin);

    // ---- make a REAL commit against the same working tree the hook was installed into (see file header) ----
    fs.writeFileSync(path.join(ws.path, 'e2e-b14.txt'), 'hello from the coauthor hook test\n');
    cp.execFileSync('git', ['add', 'e2e-b14.txt'], { cwd: ws.path });
    cp.execFileSync('git', [
      '-c', 'user.name=e2e-tester', '-c', 'user.email=e2e-tester@example.com',
      'commit', '-m', 'e2e: exercise the C-10.6 coauthor hook',
    ], { cwd: ws.path });

    const commitMsg = cp.execFileSync('git', ['log', '-1', '--format=%B'], { cwd: ws.path, encoding: 'utf8' });
    const expectedEmail = guestId + '+' + guestLogin + '@users.noreply.github.com';
    expect(commitMsg, 'expected a real commit in the shared repo to carry the connected guest as Co-authored-by: ' + commitMsg)
      .toContain('Co-authored-by: ' + guestLogin + ' <' + expectedEmail + '>');
  } finally {
    if (guestPage) { try { await guestPage.context().close(); } catch {} }
    if (guestBrowser) { try { await guestBrowser.close(); } catch {} }
    if (host) await host.stop();
  }
});

// UNSEEDED-METADATA VARIANT — the actual B14 hardware failure, not the harness's seeded stand-in above. The
// hardware finding's own diagnosis: "lib/coauthorHook's roster matching needs collaborators [{login,id}]
// metadata on the workspace, which the REAL flows never populate." This workspace is seeded with NO
// `collaborators` at all (repo-invite.sh never ran against it, and neither does main's lazy GitHub backfill
// succeed here — fake-gh refuses `repos/.../collaborators` on purpose, standing in for "gh is unauthenticated /
// offline / the repo predates any of this wiring", exactly like the owners' real claudible-development
// workspace on hardware). Before this fix, main.js's _syncCoauthorHookNow just returned silently in this shape
// forever: no hook, no coauthors file, and NOTHING told the host why — the exact "OFF-by-default is correct,
// but the live-session default-on crediting isn't wired into real terminal commits" failure. The fix is a LOUD
// one-time toast ("couldn't credit guests — no GitHub identity for ⟨name⟩") instead of that silence, AND it
// must still never install a hook it cannot back with a real, non-fabricated email (coauthorHook.js's hard rule).
test('a live guest who cannot be resolved to any known GitHub identity gets a loud degrade toast, never silence (C-10.6/B14)', async () => {
  test.setTimeout(90000);
  const gitBash = resolveGitBash();
  test.skip(!gitBash, 'no usable git-bash found on this machine — session listing / the coauthor hook script both require it');

  let guestBrowser = null, host = null, guestPage = null;
  try {
    guestBrowser = await chromium.launch();
    const remote = localBareRemote();
    const guestName = 'e2e-unmatched-guest';   // deliberately NOT a login recorded anywhere — no collaborators were ever seeded on this workspace
    let ws = null;
    const sid = 'e2e-coauthor-noid-' + Date.now();

    host = await launchClaudible({
      withClaude: true,
      withGh: true,   // present but deliberately answers 'unsupported' to the collaborators lookup (see fake-gh.js) — proves the degrade fires even when a lazy GitHub backfill is ATTEMPTED and comes back empty, not just when gh is entirely absent
      gitBash,
      env: { CLAUDIBLE_CLOUDFLARED: process.execPath },
      seed: (ctx) => {
        // NOTE: no `collaborators` option — this is the "unseeded metadata" shape the real repo:invite/
        // acceptInvite flows leave a pre-existing workspace in (see main.js's B14/C-10.6 comments).
        ws = seedRepoWorkspace(ctx, { slug: 'coauthor-noid-proj', owner: 'crazy-e2e', remote });
        writeFakeTranscript(ctx, ws, sid, 'a real session for the loud-degrade path to attach to');
        const wsFile = path.join(ctx.persist, 'workspaces.json');
        const reg = JSON.parse(fs.readFileSync(wsFile, 'utf8'));
        reg.activeId = ws.id;
        fs.writeFileSync(wsFile, JSON.stringify(reg));
      },
    });

    await expect(host.page).toHaveTitle(/./, { timeout: 30000 });
    await waitForAppReady(host.page);
    await expect.poll(() => host.page.evaluate(() => activeSession), { timeout: 20000 }).toBe(sid);

    // Capture every toast the host UI shows from here on — `toast()` is a plain top-level function in app.js's
    // non-module script, so it hangs off `window` and can be wrapped without touching app.js itself. This
    // catches the message even though the real UI auto-hides it after 2.2s (polling `#toast`'s fading text
    // would be a race; this is not).
    await host.page.evaluate(() => {
      window.__toasts = [];
      const orig = window.toast;
      window.toast = (msg) => { window.__toasts.push(msg); return orig(msg); };
    });

    await host.page.locator('#share-btn').click();
    await expect(host.page.locator('#namemodal')).toHaveClass(/show/, { timeout: 10000 });
    await host.page.locator('#host-name-in').fill('crazy-e2e-noid-host');
    await host.page.locator('#name-start').click();
    const shareLink = host.page.locator('#share-link');
    await expect(shareLink).toBeVisible({ timeout: 20000 });
    await expect.poll(async () => (await shareLink.inputValue()) || '', { timeout: 20000 }).not.toBe('');
    const url = await shareLink.inputValue();

    const guestContext = await guestBrowser.newContext();
    guestPage = await guestContext.newPage();
    await guestPage.goto(url);
    await expect(guestPage.locator('#name-overlay')).toBeVisible({ timeout: 10000 });
    await guestPage.locator('#name-in').fill(guestName);
    await guestPage.locator('#name-go').click();
    const approveModal = host.page.locator('#approve');
    await expect(approveModal).toHaveClass(/show/, { timeout: 15000 });
    await host.page.locator('#approve-yes').click();
    await expect(guestPage.locator('body')).toHaveClass(/connected/, { timeout: 15000 });

    // ---- the loud degrade: a toast naming the unresolved guest, fired at most once ----------------------------
    await expect.poll(() => host.page.evaluate(() => window.__toasts.some((m) => /no github identity/i.test(m))), {
      timeout: 20000, message: 'expected a "couldn\'t credit guests — no GitHub identity for …" toast once the unmatched guest connected',
    }).toBe(true);
    const degradeToasts = await host.page.evaluate(() =>
      window.__toasts.filter((m) => /no github identity/i.test(m)));
    expect(degradeToasts.some((m) => m.includes('e2e-unmatched-guest')),
      'expected the degrade toast to name the unresolved guest: ' + JSON.stringify(degradeToasts)).toBe(true);
    expect(degradeToasts.length, 'expected the degrade toast to fire at most once per live share, not once per roster tick: ' + JSON.stringify(degradeToasts)).toBe(1);

    // ---- never silently fabricate: no hook, no coauthors file — nothing on disk pretends to credit anyone ----
    const gitDirOut = cp.execFileSync('git', ['rev-parse', '--git-dir'], { cwd: ws.path, encoding: 'utf8' }).trim();
    const gitDir = path.isAbsolute(gitDirOut) ? gitDirOut : path.join(ws.path, gitDirOut);
    const hookPath = path.join(gitDir, 'hooks', 'prepare-commit-msg');
    const coauthorsPath = path.join(gitDir, 'claudible-coauthors');
    expect(fs.existsSync(hookPath), 'expected NO prepare-commit-msg hook — nobody in the session resolves to a real identity, so there is nothing honest to install').toBe(false);
    expect(fs.existsSync(coauthorsPath), 'expected no claudible-coauthors file either').toBe(false);
  } finally {
    if (guestPage) { try { await guestPage.context().close(); } catch {} }
    if (guestBrowser) { try { await guestBrowser.close(); } catch {} }
    if (host) await host.stop();
  }
});

// ADOPTED-WORKSPACE VARIANT — the actual root cause behind the hardware failure, not just its symptom. Per
// the hardware finding's own diagnosis of the owners' setup: the claudible-development workspace (the
// sessions/tools repo) was added as an EXISTING local clone via "Adopt an existing folder" (main.js
// workspace:adopt), not created/invited through the app's own repo pipeline — so its registry entry is
// ws.kind==='local', ws.adopted:true, with the GitHub owner/name parsed into ws.repoId at adopt time, NEVER
// ws.kind==='repo'. Before this fix, _coauthorTargetWs's gate was a bare `ws.kind === 'repo'`, so an adopted
// workspace — even one with real GitHub collaborators correctly seeded — could NEVER reach the hook-install
// logic at all: _syncCoauthorHookNow returned at its very first line, with no runScript call and no toast,
// which is the "no co-author hook fired, nothing said why" hardware symptom exactly. This proves the fix (a
// _repoIdentity() gate that also admits an adopted folder with a real GitHub remote) actually closes it: WITH
// collaborators correctly seeded on an adopted workspace, the hook must install and credit the guest, just
// like the kind:'repo' case in the first test above.
test('a live share on an ADOPTED workspace (kind:local, not kind:repo) still installs the coauthor hook (C-10.6/B14 root cause)', async () => {
  test.setTimeout(90000);
  const gitBash = resolveGitBash();
  test.skip(!gitBash, 'no usable git-bash found on this machine — session listing / the coauthor hook script both require it');

  let guestBrowser = null, host = null, guestPage = null;
  try {
    guestBrowser = await chromium.launch();
    const remote = localBareRemote();
    const guestLogin = 'e2eguestadopted';
    const guestId = 999998;
    let ws = null;
    const sid = 'e2e-coauthor-adopted-' + Date.now();

    host = await launchClaudible({
      withClaude: true,
      withGh: true,
      gitBash,
      env: { CLAUDIBLE_CLOUDFLARED: process.execPath },
      seed: (ctx) => {
        // kind:'local', adopted:true — mirrors main.js workspace:adopt's shape for an EXISTING local clone of a
        // real GitHub repo, exactly the owners' claudible-development setup per the hardware finding.
        ws = seedAdoptedRepoWorkspace(ctx, {
          slug: 'coauthor-adopted-proj', owner: 'crazy-e2e', remote,
          collaborators: [{ login: guestLogin, id: guestId }],
        });
        writeFakeTranscript(ctx, ws, sid, 'a real session on an adopted workspace, for the kind-gate fix to attach to');
        const wsFile = path.join(ctx.persist, 'workspaces.json');
        const reg = JSON.parse(fs.readFileSync(wsFile, 'utf8'));
        reg.activeId = ws.id;
        fs.writeFileSync(wsFile, JSON.stringify(reg));
      },
    });

    await expect(host.page).toHaveTitle(/./, { timeout: 30000 });
    await waitForAppReady(host.page);
    await expect.poll(() => host.page.evaluate(() => activeSession), { timeout: 20000 }).toBe(sid);

    await host.page.locator('#share-btn').click();
    await expect(host.page.locator('#namemodal')).toHaveClass(/show/, { timeout: 10000 });
    await host.page.locator('#host-name-in').fill('crazy-e2e-adopted-host');
    await host.page.locator('#name-start').click();
    const shareLink = host.page.locator('#share-link');
    await expect(shareLink).toBeVisible({ timeout: 20000 });
    await expect.poll(async () => (await shareLink.inputValue()) || '', { timeout: 20000 }).not.toBe('');
    const url = await shareLink.inputValue();

    const guestContext = await guestBrowser.newContext();
    guestPage = await guestContext.newPage();
    await guestPage.goto(url);
    await expect(guestPage.locator('#name-overlay')).toBeVisible({ timeout: 10000 });
    await guestPage.locator('#name-in').fill(guestLogin);
    await guestPage.locator('#name-go').click();
    const approveModal = host.page.locator('#approve');
    await expect(approveModal).toHaveClass(/show/, { timeout: 15000 });
    await host.page.locator('#approve-yes').click();
    await expect(guestPage.locator('body')).toHaveClass(/connected/, { timeout: 15000 });

    const gitDirOut = cp.execFileSync('git', ['rev-parse', '--git-dir'], { cwd: ws.path, encoding: 'utf8' }).trim();
    const gitDir = path.isAbsolute(gitDirOut) ? gitDirOut : path.join(ws.path, gitDirOut);
    const hookPath = path.join(gitDir, 'hooks', 'prepare-commit-msg');
    const coauthorsPath = path.join(gitDir, 'claudible-coauthors');
    await expect.poll(() => fs.existsSync(hookPath) && fs.readFileSync(hookPath, 'utf8').includes('claudible:coauthor-hook'), {
      timeout: 20000, message: 'expected the prepare-commit-msg hook to be installed on the ADOPTED workspace once the guest is connected — a kind:local, adopted:true repo must not be excluded from C-10.6',
    }).toBe(true);
    await expect.poll(() => fs.existsSync(coauthorsPath) ? fs.readFileSync(coauthorsPath, 'utf8') : '', {
      timeout: 20000, message: 'expected the claudible-coauthors file to name the connected guest',
    }).toContain(guestLogin);

    fs.writeFileSync(path.join(ws.path, 'e2e-b14-adopted.txt'), 'hello from the adopted-workspace coauthor hook test\n');
    cp.execFileSync('git', ['add', 'e2e-b14-adopted.txt'], { cwd: ws.path });
    cp.execFileSync('git', [
      '-c', 'user.name=e2e-tester', '-c', 'user.email=e2e-tester@example.com',
      'commit', '-m', 'e2e: exercise the C-10.6 coauthor hook on an adopted workspace',
    ], { cwd: ws.path });

    const commitMsg = cp.execFileSync('git', ['log', '-1', '--format=%B'], { cwd: ws.path, encoding: 'utf8' });
    const expectedEmail = guestId + '+' + guestLogin + '@users.noreply.github.com';
    expect(commitMsg, 'expected a real commit in the ADOPTED repo to carry the connected guest as Co-authored-by: ' + commitMsg)
      .toContain('Co-authored-by: ' + guestLogin + ' <' + expectedEmail + '>');
  } finally {
    if (guestPage) { try { await guestPage.context().close(); } catch {} }
    if (guestBrowser) { try { await guestBrowser.close(); } catch {} }
    if (host) await host.stop();
  }
});
