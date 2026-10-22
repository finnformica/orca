// The deploy-preview URL in a PR's comments (server/previewUrl.ts). The bodies are the bots' real
// comments, copied from public PRs; only project names, account ids and build ids are replaced.
import { describe, expect, test } from "bun:test";
import { extractPreviewUrl, previewUrlInBody } from "../server/previewUrl";

const ACCOUNT = "0123456789abcdef0123456789abcdef";

// Cloudflare Workers Builds (login cloudflare-workers-and-pages): a Commit and a Branch preview.
const workers = (commit: string, branchHost: string) => `## Deploying with &nbsp;<a href="https://workers.dev"><img alt="Cloudflare Workers" src="https://workers.cloudflare.com/logo.svg" width="16"></a> &nbsp;Cloudflare Workers
The latest updates on your project. Learn more about [integrating Git with Workers](https://developers.cloudflare.com/workers/ci-cd/builds/git-integration/).

| Status | Name | Latest Commit | Preview URL | Updated (UTC) |
| -|-|-|-|-|
| ✅ Deployment successful! <br>[View logs](https://dash.cloudflare.com/?to=/${ACCOUNT}/workers/services/view/ruminate/production/builds/00000000-0000-0000-0000-000000000000) | ruminate | ${commit} | <a href='https://${commit}-ruminate.example.workers.dev'>Commit Preview URL</a><br><br><a href='https://${branchHost}'>Branch Preview URL</a> | Oct 20 2026, 10:07 PM |`;

// Cloudflare Pages (the same bot): a per-commit Preview URL and a Branch Preview URL.
const pages = `## Deploying acme-site with &nbsp;<a href="https://pages.dev"><img alt="Cloudflare Pages" src="https://user-images.githubusercontent.com/23264/106598434-9e719e00-654f-11eb-9e59-6167043cfa01.png" width="16"></a> &nbsp;Cloudflare Pages

<table><tr><td><strong>Latest commit:</strong> </td><td>
<code>29e5943</code>
</td></tr>
<tr><td><strong>Status:</strong></td><td>&nbsp;✅&nbsp; Deploy successful!</td></tr>
<tr><td><strong>Preview URL:</strong></td><td>
<a href='https://29e5943d.acme-site.pages.dev'>https://29e5943d.acme-site.pages.dev</a>
</td></tr>
<tr><td><strong>Branch Preview URL:</strong></td><td>
<a href='https://fix-header.acme-site.pages.dev'>https://fix-header.acme-site.pages.dev</a>
</td></tr>
</table>

[View logs](https://dash.cloudflare.com/?to=/${ACCOUNT}/pages/view/acme-site/29e5943d-0000-0000-0000-000000000000)`;

// Vercel: dashboard, avatar and status-badge links around the one Preview link.
const vercel = `[vc]: #abc=:eyJ0eXBlIjoiZ2l0aHViIn0=
The latest updates on your projects. Learn more about [Vercel for GitHub](https://vercel.link/github-learn-more).

| Project | Deployment | Actions | Updated |
| :--- | :----- | :------ | :------ |
| <a href="https://vercel.com/acme-team/acme"><sup><img src="https://vercel.com/api/www/avatar?projectId=prj_x&teamId=team_x&s=32" width="16" height="16" align="middle" alt="" /></sup></a> [acme](https://vercel.com/acme-team/acme) | ![Ready](https://vercel.com/static/status/ready.svg) [Ready](https://vercel.com/acme-team/acme/4wkiwMeX6w47) | [Preview](https://acme-git-fix-header-acme-team.vercel.app), [Comment](https://vercel.live/open-feedback/acme-git-fix-header-acme-team.vercel.app?via=pr-comment-feedback-link) | <relative-time datetime="2026-10-22T07:33:48.141Z">Oct 22, 2026 7:33am UTC</relative-time> |`;

// Netlify, ready: a deploy log, a QR code image and the Deploy Preview.
const netlifyReady = `### <span aria-hidden="true">✅</span> Deploy Preview for *acme* ready!


|  Name | Link |
|:-:|------------------------|
|<span aria-hidden="true">🔨</span> Latest commit | c442aa544876c5a1cb6c5d8ca26df48761d205d4 |
|<span aria-hidden="true">🔍</span> Latest deploy log | https://app.netlify.com/projects/acme/deploys/6ad04c21f67223534acfc96d |
|<span aria-hidden="true">😎</span> Deploy Preview | [https://deploy-preview-31--acme.netlify.app](https://deploy-preview-31--acme.netlify.app) |
|<span aria-hidden="true">📱</span> Preview on mobile | <details><summary> Toggle QR Code... </summary><br /><br />![QR Code](https://app.netlify.com/qr-code/eyJ0eXAiOiJKV1QifQ.e30.sig)<br /><br />_Use your smartphone camera to open QR code link._</details> |
---
<!-- [acme Preview](https://deploy-preview-31--acme.netlify.app) -->
_To edit notification comments on pull requests, go to your [Netlify project configuration](https://app.netlify.com/projects/acme/configuration/notifications#deploy-notifications)._`;

// Netlify, still building: only the deploy log, no preview yet.
const netlifyBuilding = `### <span aria-hidden="true">👷</span> Deploy Preview for *acme* processing.


|  Name | Link |
|:-:|------------------------|
|<span aria-hidden="true">🔨</span> Latest commit | bf23ea39918d8554f854798479f9800872698d47 |
|<span aria-hidden="true">🔍</span> Latest deploy log | https://app.netlify.com/projects/acme/deploys/6ad9bc5dee8b6bb31d98f549 |`;

// branch-demo's pr-preview action.
const prPreview = "Deploy preview: https://feat-a.preview.example.com is ready";

describe("previewUrlInBody", () => {
  test("Cloudflare Workers Builds: the Branch preview, not the commit one, the logo or the dashboard", () => {
    expect(previewUrlInBody(workers("a32f22f0", "orca-focus-stack-a77da4-ruminate.example.workers.dev")))
      .toBe("https://orca-focus-stack-a77da4-ruminate.example.workers.dev");
  });
  test("Cloudflare Workers Builds: the Commit preview when no Branch preview is posted", () => {
    const body = workers("a32f22f0", "x").replace(/<br><br><a href='https:\/\/x'>Branch Preview URL<\/a>/, "");
    expect(previewUrlInBody(body)).toBe("https://a32f22f0-ruminate.example.workers.dev");
  });
  test("Cloudflare Pages: the Branch Preview URL", () => {
    expect(previewUrlInBody(pages)).toBe("https://fix-header.acme-site.pages.dev");
  });
  test("Vercel: the branch alias, not the dashboard, the badge or the feedback link", () => {
    expect(previewUrlInBody(vercel)).toBe("https://acme-git-fix-header-acme-team.vercel.app");
  });
  test("Netlify: the Deploy Preview, not the deploy log or the QR code", () => {
    expect(previewUrlInBody(netlifyReady)).toBe("https://deploy-preview-31--acme.netlify.app");
  });
  test("Netlify still building: no preview", () => {
    expect(previewUrlInBody(netlifyBuilding)).toBeUndefined();
  });
  test("branch-demo's pr-preview action still matches; its API host and images do not", () => {
    expect(previewUrlInBody(prPreview)).toBe("https://feat-a.preview.example.com");
    expect(previewUrlInBody("api at https://api.preview.example.com and ![s](https://feat.preview.example.com/shot.png)")).toBeUndefined();
  });
  test("a comment with only other links: no preview", () => {
    expect(previewUrlInBody("See https://github.com/acme/app/pull/3 and https://workers.dev and https://dash.cloudflare.com/x")).toBeUndefined();
  });
});

describe("extractPreviewUrl", () => {
  test("the newest comment that has a preview wins", () => {
    const comments = [
      { body: workers("11111111", "old-branch-ruminate.example.workers.dev") },
      { body: workers("22222222", "new-branch-ruminate.example.workers.dev") },
      { body: "LGTM" },
    ];
    expect(extractPreviewUrl(comments)).toBe("https://new-branch-ruminate.example.workers.dev");
  });
  test("no comments, or none with a preview: undefined", () => {
    expect(extractPreviewUrl([])).toBeUndefined();
    expect(extractPreviewUrl([{ body: netlifyBuilding }, {}])).toBeUndefined();
  });
});
