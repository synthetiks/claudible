'use strict';
// lib/discovery.js — pure helpers for turning a discovered GitHub repo into a workspace decision. Extracted so
// the phantom-duplicate guard is unit-testable (main.js can't be require()'d under plain node). No IO: the caller
// (main.js discoverWorkspaces) applies the returned patch to the registry and persists.
//
// The one hard invariant: NEVER change a workspace's `slug`. It names ~/.claudible/repos/<slug> and, through the
// cwd-encoding, ~/.claude/projects/<encoded>/ — i.e. every Claude transcript for that project. A rename moves the
// GitHub/display identity (repoName/repoUrl/label); the slug and the local folder stay put.

// Which existing workspace IS this discovered repo? The GitHub numeric id (ghId) is authoritative because it
// SURVIVES a rename; owner+name, the registry id (`repo-<slug>`), and the adopted repoId ALL stop matching the
// moment a repo is renamed. So a workspace whose slug no longer names its GitHub repo (repoName set and != slug —
// i.e. it was renamed) is matchable ONLY by ghId — otherwise a brand-new repo that reuses the freed-up old name
// would be mistaken for it and hijack its identity. Never-renamed repos still fall back to id/name/adopted matching
// (that path also backfills ghId onto pre-existing entries, making the NEXT rename dedupe-safe).
function findExistingWorkspace(workspaces, disc) {
  if (!Array.isArray(workspaces) || !disc) return null;
  const { slug, owner } = disc;
  const ghId = disc.ghId;
  const wid = disc.wid || ('repo-' + slug);
  return workspaces.find((w) => {
    if (ghId != null && w.ghId === ghId) return true;                       // stable id — always authoritative
    const renamed = w.kind === 'repo' && w.repoName && w.repoName !== w.slug;   // its slug is stale as a GitHub name
    // A renamed workspace must never be matched by its STALE slug or its `repo-<slug>` id — a brand-new repo that
    // reuses the freed-up old name would hijack it. But it CAN be matched by its CURRENT name (repoName): that is
    // still unique per owner, and it keeps us safe when ghId is missing (e.g. `gh repo rename` succeeded but the
    // follow-up id fetch failed, leaving repoName set and ghId unset — which used to re-add it as a phantom).
    if (renamed) return w.repoName === slug && w.owner === owner;
    return w.id === wid ||
      (w.kind === 'repo' && w.slug === slug && w.owner === owner) ||
      (w.adopted && w.repoId === owner + '/' + slug);
  }) || null;
}

// The in-place update plan for a matched workspace: backfill the stable id, and FOLLOW a GitHub rename (the repo's
// current name differs from what we last knew) by updating repoName/repoUrl and — only if the user never set a
// custom label — the label. Returns { changed, patch }; patch never contains `slug`.
function reconcileWorkspace(existing, disc) {
  const patch = {}; let changed = false;
  if (!existing || !disc) return { changed, patch };
  const { slug, owner } = disc;
  const ghId = disc.ghId;
  if (ghId != null && existing.ghId !== ghId) { patch.ghId = ghId; changed = true; }
  const known = existing.repoName || existing.slug;
  // Follow a rename only when we can prove it's the same repo by stable id, and the name actually moved.
  if (existing.kind === 'repo' && ghId != null && owner === existing.owner && slug !== known) {
    patch.repoName = slug;
    patch.repoUrl = disc.repoUrl || ('https://github.com/' + owner + '/' + slug);
    if (existing.label === known) patch.label = slug;   // only track the rename in the UI when the label wasn't customized
    changed = true;
  }
  return { changed, patch };
}

module.exports = { findExistingWorkspace, reconcileWorkspace };
