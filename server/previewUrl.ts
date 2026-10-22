// Find a PR's deploy-preview URL in its comments — the link the common deploy bots post. Pure: no
// I/O, so the rules are tested on real comment bodies (tests/previewUrl.test.ts).
//
// Matching is on the URL's HOSTNAME, never on raw text: a Vercel feedback link carries the preview
// host in its query, and Cloudflare's dashboard and logo links sit in the same table as the preview.

type Comment = { body?: string };

/** One preview host rule. `branch` marks the stable per-branch alias (it survives a push), which wins
 *  over a per-commit URL in the same comment. */
type Rule = { match: (host: string) => boolean; branch?: (host: string) => boolean };

/** A per-commit Cloudflare preview starts with the commit's short hash (`a32f22f0-ruminate.…` on
 *  Workers, `a32f22f0.project.pages.dev` on Pages); the branch alias does not. */
const commitPrefixed = (host: string) => /^[0-9a-f]{8}[-.]/.test(host);
const labels = (host: string) => host.split(".").length;

const RULES: Rule[] = [
  // Cloudflare Workers Builds: <version|branch>-<worker>.<account>.workers.dev (the bare
  // workers.dev in its header is a logo link).
  { match: (h) => h.endsWith(".workers.dev") && labels(h) >= 4, branch: (h) => !commitPrefixed(h) },
  // Cloudflare Pages: <hash|branch>.<project>.pages.dev.
  { match: (h) => h.endsWith(".pages.dev") && labels(h) >= 4, branch: (h) => !commitPrefixed(h) },
  // Vercel: <project>-git-<branch>-<team>.vercel.app is the branch alias.
  { match: (h) => h.endsWith(".vercel.app"), branch: (h) => h.includes("-git-") },
  // Netlify: deploy-preview-<n>--<site>.netlify.app.
  { match: (h) => /^deploy-preview-\d+--[^.]+\.netlify\.app$/.test(h) },
  // branch-demo's pr-preview action: <branch>.preview.<domain> (not its API host).
  { match: (h) => /\.preview\./.test(h) && !/(^|\.)api\.preview\./.test(h) },
];

const IMAGE = /\.(png|jpe?g|gif|svg|webp|ico)$/i;
// Stop at whitespace, quotes, brackets and angle brackets: the bots wrap links in markdown and in
// `<a href='…'>`.
const URL_RE = /https?:\/\/[^\s"'`<>()[\]{}|*]+/g;

/** The preview URL in ONE comment body: a branch alias first, else the first preview link. */
export function previewUrlInBody(body: string): string | undefined {
  let first: string | undefined;
  for (const m of body.matchAll(URL_RE)) {
    const raw = m[0].replace(/[.,;:!?]+$/, "");
    let url: URL;
    try { url = new URL(raw); } catch { continue; }
    const host = url.hostname.toLowerCase();
    if (IMAGE.test(url.pathname)) continue;
    const rule = RULES.find((r) => r.match(host));
    if (!rule) continue;
    if (rule.branch?.(host)) return raw;
    first ??= raw;
  }
  return first;
}

/** The newest comment's preview URL. `comments` is oldest first, as GitHub lists them. */
export function extractPreviewUrl(comments: Comment[]): string | undefined {
  for (let i = comments.length - 1; i >= 0; i--) {
    const url = previewUrlInBody(comments[i]?.body ?? "");
    if (url) return url;
  }
  return undefined;
}
