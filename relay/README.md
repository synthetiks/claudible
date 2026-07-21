# Claudible presence relay

The <1s "went live / ended" push channel (see `worker.js` for the full model). Git remains the source of
truth; the app treats the relay as a preview doorbell and works fully without it.

## Before you deploy — required precondition

`worker.js` has **no automated test coverage** (its auth / room-routing / frame-validation logic uses
Cloudflare Workers runtime globals that don't run under Node). Before pointing any real install at a
deployment, smoke it by hand: `npx wrangler dev`, connect two `wsl://…/room/<key>` clients, and confirm a
`hello` with push access gets `{"type":"welcome","role":"publisher"}`, a pull-only token gets
`"subscriber"`, an unrelated token gets `{"type":"reject"}`, and a published `live`/`end` frame fans out to
the other client with the **server-forced** `login`. Only then set a URL in `lib/presenceRelay.js` /
`CLAUDIBLE_RELAY_URL`. Until a URL is set the whole relay layer is inert and this precondition doesn't apply.

## Deploy (once, by a maintainer)

```bash
cd relay
npx wrangler login       # a free Cloudflare account is enough (Durable Objects run on the free plan via the SQLite class migration)
npx wrangler deploy
```

Take the printed URL (`https://claudible-presence.<account>.workers.dev`) and either:

- set it as `DEFAULT_RELAY_URL` in `lib/presenceRelay.js` (ships it for every install), or
- set `CLAUDIBLE_RELAY_URL` in the app's environment (per-machine override / testing).

Until one of those is set, the entire relay layer is inert — zero connections, zero behavior change.

## Privacy

The relay sees: which repo-identity room is active (a hash — repo names don't appear in URLs/logs), the
connecting GitHub login, timestamps, and the same ~300-byte presence payload already committed to the
`claudible/sessions` branch. Never transcripts or terminal content. GitHub tokens are used for one
read-only permission check per connection and are not stored or logged.
