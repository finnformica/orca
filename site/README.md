# Orca public page

A small public site for the Orca Google OAuth app. Google needs a public home page, a privacy page and
a public redirect domain before it publishes the app.

- `/` is the home page: the logo, the word "orca", and links to Privacy and Terms.
- `/privacy` and `/terms` are the policy pages.
- `GET /api/integrations/oauth/google/callback` sends the browser on to the Orca server with the same
  query (`302`). The Orca server then finishes the sign-in. If `ORCA_ORIGIN` is not set, it answers `503`.

The site is plain HTML and CSS in `public/`, with a self-hosted font (Unbounded, SIL OFL, see
`public/fonts/OFL.txt`). It makes no external request, and it has no script and no tracking. The Worker
(`src/worker.ts`) runs only for `/api/*`. The tests are in `tests/site.test.ts` at the repo root.

## Deploy with Workers Builds

Use these settings in the Cloudflare dashboard (**Workers & Pages > Create > Import a repository**):

| Setting | Value |
| --- | --- |
| Repository | `finnformica/orca` |
| Branch | `main` |
| Root directory | `site` |
| Build watch paths | `site/**` |
| Build command | (empty) |
| Deploy command | `npx wrangler deploy` |

Each push to `main` that changes a file under `site/` deploys the Worker again.

`wrangler.jsonc` holds no account id and no routes. Workers Builds gives the account. Add the custom
domain in the dashboard: open the Worker, then **Settings > Domains & Routes > Add > Custom domain**.
`workers_dev` is on and `preview_urls` is off.

## The variable

Set one variable on the Worker in the dashboard: **Settings > Variables and Secrets > Add**.

| Name | Type | Value |
| --- | --- | --- |
| `ORCA_ORIGIN` | Text | The `https://` origin of your Orca server, with no path. |

Do not put this value in the repo. The repo is public. `wrangler.jsonc` sets `keep_vars: true`, so a
deploy keeps the dashboard variable.

## Connect Orca to it

1. In Google Cloud, add `https://<public domain>/api/integrations/oauth/google/callback` as an
   authorized redirect URI. Add the public domain as an authorized domain.
2. In Orca, set `googleOAuth.redirectOrigin` to `https://<public domain>`.

See `docs/integrations/gmail.md` sections 4 and 5.
