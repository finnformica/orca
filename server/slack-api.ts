// The card's Slack button path (/api/slack): post the message VERBATIM from YOUR identity with a user
// token (`xoxp`, SLACK_TOKEN) to the repo's `slackChannel` — dependency-free, no model, so a post is
// deterministic. branch-demo's PRs use it. It is NOT the Slack adapter: the adapter (a bot over Socket
// Mode, server/integrations/adapters/slack.ts) is receive-only and never posts.
const userToken = () => process.env.SLACK_TOKEN ?? "";

/** `{channel, text}` to chat.postMessage as the user. Never throws: Slack's error comes back as `error`. */
export async function postMessage(channel: string, text: string): Promise<{ ok: boolean; error?: string; channel?: string }> {
  if (!userToken()) return { ok: false, error: "SLACK_TOKEN is not set" };
  try {
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8", authorization: `Bearer ${userToken()}` },
      body: JSON.stringify({ channel, text }),
    });
    return (await res.json().catch(() => ({ ok: false, error: `http ${res.status}` }))) as { ok: boolean; error?: string; channel?: string };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
