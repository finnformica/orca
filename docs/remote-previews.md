# Screenshots from remote PR previews

Some repos deploy a preview for each PR. For such a repo, a worker takes its screenshots from that
preview. The worker does not start a local database, backend and Vite on the box for a screenshot.

- The config is one block on the repo: `remotePreview`.
- The command is `orca-shot --preview`.
- The rules are in `shared/remotePreview.ts`. The I/O is in `server/remotePreview.ts`.

## What a worker does

1. Commit and push the branch.
2. Run `orca-shot --preview [/path] [--pr N] [flags]`. Give the Bash call a timeout of 10 minutes.
3. Read the PNG from the `shot:` line.

`orca-shot --preview` takes the same flags as `orca-shot <url>`: `--viewport 390x844`, `--dark`,
`--hover`, `--click`, `--press`, `--type`, `--wait-for`, `--label` and `--console`. The shot goes
through the same box-wide queue and the same capped browser.

The bridge does these steps:

1. It finds the repo from `ORCA_REPO`, else from the current directory.
2. It finds the open PR of the branch (`ORCA_BRANCH`, else the checked-out branch), or PR `--pr N`.
3. It compares the PR head with the worktree `HEAD`. If they are different, it stops with "push first".
4. It asks the source for the preview URL of the PR head commit. It waits until the preview is ready.
5. It reads the login secrets and signs in.
6. It shoots `/path` under the preview URL. The path of the preview URL stays: `/settings` on
   `https://pr-7.preview.example.com/demo` is `https://pr-7.preview.example.com/demo/settings`.

While it waits, it prints `waiting: <reason>` on stderr. When it finds the preview, it prints
`preview: <url> (PR #N, <sha7>, from <source>)`.

It starts no local service.

### Errors

| Message | Cause |
| --- | --- |
| `no open PR for branch …` | The branch has no open PR. The preview deploys only from a PR. |
| `… head is … but this worktree is at …: push first` | The worktree has commits that are not pushed. |
| `timed out waiting for the preview of PR #N …: <reason>` | The preview was not ready before `waitMinutes`. |
| `preview for PR #N: deployment … ended in failure` | The deploy of the head commit failed. |
| `login failed: …` | The login form is missing, the secret is missing, or the login did not work. |
| `repo … has no remotePreview` | The repo has no `remotePreview` block. Use `orca-shot <url>`. |

### Repos where workers do not open PRs

Workers do not open PRs (`gh pr create`). When `orca-shot --preview` says "no open PR", the worker
writes in Remaining that the preview screenshots wait on a PR. The orchestrator then opens a draft
PR for the branch early and sends the worker back to take the screenshots.

## The config

Put the block on a repo in the app config (Settings shows it; the config document validates it).

```ts title=remotePreview
remotePreview: {
  source: "github-deployment" | "github-check-or-comment" | "template",
  urlPattern?: string,     // template: the URL. github-deployment: used when a status has no environment_url.
  environment?: string,    // github-deployment only
  urlRegex?: string,       // github-check-or-comment only (default: a pages.dev or workers.dev URL)
  checkName?: string,      // github-check-or-comment only: part of the check run or status name
  commentAuthor?: string,  // github-check-or-comment only: the bot login of the comment
  waitMinutes?: number,    // 0-60, default 8
  login?: { kind: "none" }
    | { kind: "form", url, userField, passwordField, submit, user? | userSecret?, passwordSecret, waitFor? }
    | { kind: "cookie", secret, name? }
    | { kind: "header", headers: { "<Header-Name>": "<secret name>" } },
}
```

`urlPattern` placeholders: `{pr}`, `{branch}`, `{branchSlug}`, `{sha}`, `{sha7}`, `{owner}`, `{repo}`.
`{branchSlug}` is the branch in lower case, with each run of other characters as one `-`.

## How each source finds the URL

Each source uses only data of the PR **head commit**. A deployment, check, status or comment of an
older commit is never used. The bridge reads the PR again on each poll, so a push during the wait
moves the target to the new head.

### `github-deployment`

1. List the deployments of the head SHA (`GET /repos/{o}/{r}/deployments?sha=…&environment=…`).
2. Take the newest deployment of that SHA. Ignore deployments of other SHAs.
3. Read its newest status.
   - `success`: use `environment_url`, else `urlPattern`.
   - `failure`, `error` or `inactive`: stop with an error.
   - Any other state, or no status: wait.

### `github-check-or-comment`

Use this source for Cloudflare Pages and Workers Builds. They post the preview URL on the PR.

1. Read the check runs of the head SHA. Use the first `success` run (name contains `checkName`) whose
   output has a URL that matches `urlRegex`.
2. Else read the commit statuses of the head SHA. Use the newest `success` status per context whose
   `target_url` or description matches.
3. Else read the PR comments (by `commentAuthor`, when set), newest first. Use a comment only when it
   names the head commit: the full SHA, or 7 or more of its first characters. A comment that names
   an older commit, or no commit, is ignored.
4. A failed check run or status of the head SHA stops with an error. Else wait.

`urlRegex` is a JavaScript regular expression. Group 1 is the URL when the regex has a group. Else
the whole match is the URL.

### `template`

Fill `urlPattern`, then wait until the URL answers. A 404 or a 5xx means "not ready". A 401 or a 403
means "ready behind a login". This source cannot see which commit the URL serves. Use it only when
the host deploys each push before it answers, or when an older build is acceptable.

## Login

All credentials are names of secrets in Orca's secret store (see [secrets.md](secrets.md)). Store a
value with `/secret` in the chat, or with a `secret` field in a form. A value never goes in the
config, in a log or in an error message. Each read writes one audit row (`secret_use`).

- `none`: no login.
- `form`: open `url` (a full URL, or a path on the preview origin). Type `user` (or the value of
  `userSecret`) into `userField`. Type the value of `passwordSecret` into `passwordField`. Click
  `submit`. The login is good when `waitFor` shows, else when the password field is gone.
- `cookie`: set a cookie on the preview origin. With `name`, the secret is the value. Without
  `name`, the secret is a whole `a=1; b=2` cookie string.
- `header`: send each header only to the preview origin. Other hosts (fonts, analytics) never get it.

**Session per run.** After a form login, the bridge keeps the cookies in memory. The key is the run
(`ORCA_RUN_ID`) and the preview origin. The next shot of the same run sets them and does not log in
again. If the page shows the login form again, it logs in again. Nothing is written to disk.

## Example: branch-demo (GitHub deployments)

branch-demo deploys each PR to the `pr-preview` environment. The seeded user is `test@example.com`.
See `docs/pr-preview-deployments.md` in that repo.

1. Store the seeded user's password as a secret named `branch-demo/preview-password`.
2. Add this block to the branch-demo repo in the app config:

```json title=branch-demo
"remotePreview": {
  "source": "github-deployment",
  "environment": "pr-preview",
  "waitMinutes": 15,
  "login": {
    "kind": "form",
    "url": "/demo/login",
    "userField": "input[type=email]",
    "passwordField": "input[type=password]",
    "submit": "button[type=submit]",
    "user": "test@example.com",
    "passwordSecret": "branch-demo/preview-password"
  }
}
```

Check the login path and the selectors against the branch-demo login page. The deployment status
gives the URL (`environment_url`), so no `urlPattern` is necessary.

```bash title=Shoot
orca-shot --preview /settings --viewport 390x844 --dark
```

## Example: Cloudflare Pages or Workers Builds

The Cloudflare GitHub app adds a check run and a PR comment with the preview URL. The comment names
the latest commit.

```json title=Cloudflare
"remotePreview": {
  "source": "github-check-or-comment",
  "urlRegex": "https://[a-z0-9-]+(?:\\.[a-z0-9-]+)*\\.(?:pages|workers)\\.dev\\S*",
  "waitMinutes": 10
}
```

That regex is the default, so you can leave it out. To use one bot only, add `"commentAuthor"` with
the bot login that you see on the PR. To use one check only, add `"checkName"` (for example the
project name).

A preview behind Cloudflare Access needs a service token. Store its id and secret, then add:

```json title=Cloudflare Access
"login": {
  "kind": "header",
  "headers": {
    "CF-Access-Client-Id": "cloudflare/access-client-id",
    "CF-Access-Client-Secret": "cloudflare/access-client-secret"
  }
}
```
