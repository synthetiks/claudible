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
  launchClaudible, seedRepoWorkspace, writeFakeTranscript, localBareRemote, resolveGitBash, waitForAppReady,
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
