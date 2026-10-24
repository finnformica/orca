# Gmail

The Gmail adapter connects Orca to your own Gmail with **Sign in with Google** (OAuth 2.0). Mail that
you mark for Orca reaches the orchestrator. Orca can answer in the same Gmail thread. The code is
`server/integrations/adapters/gmail.ts` and the files in `server/integrations/adapters/gmail/`. The
adapter contract is [ADAPTERS.md](ADAPTERS.md).

This adapter is not the [Email](email.md) adapter. The Email adapter reads one separate mailbox over
IMAP with a password. The Gmail adapter reads your own mailbox through the Gmail API, with a grant
that you can revoke at Google at any time.

## 1. What it does

- **Connect.** You press **Connect with Google** on the integration's card. Google asks you to allow
  access. Google sends your browser back to Orca. Orca stores the refresh token encrypted in its
  secret store. Orca never sees your Google password.
- **Inbound.** Every `pollSeconds` (default 60) the primary bridge reads the Gmail History API from
  a stored cursor (`users.history.list` from a `historyId`). Orca has no public address, so it does
  not use Pub/Sub push.
- **The query.** Only mail that matches the integration's Gmail `query` goes to Orca. The default is
  `label:Orca OR to:<you>+orca@<your domain>`. Gmail does the match with its own search, so the
  query uses the Gmail search syntax.
- **The mail gate.** A matching mail must also pass these checks:
  1. It is not a draft, and it is not only a copy of a mail you sent.
  2. It is not an auto-reply, a bounce, a list mail or a mail that Orca sent.
  3. When `allowedSenders` is set, the sender is in it.
  4. Google says DKIM, SPF or DMARC passed for the From domain (`mx.google.com`). A note that you
     send to your own `+orca` address passes, because Gmail made it for your account.
- **The core.** Then the mail goes to `ctx.ingest` as topic `ext.gmail.message`. The core does its
  usual checks: the link, the person and the grant. Subscriptions and routing apply as for every
  adapter.
- **Outbound (optional).** With **Allow send** on, Orca can answer in a Gmail thread
  (`orca post --reply`, or a subscription to the link). The mail goes out through
  `users.messages.send` from your address.
- **Health.** The card shows the account, the scopes and the last poll. When Google refuses the
  grant (you revoked it, or it expired), the card says **reconnect needed**.

## 2. Scopes

Orca asks for the smallest set of scopes:

| Scope | When | Why |
|---|---|---|
| `https://www.googleapis.com/auth/gmail.readonly` | Always | Read the History API, search with the query, read a matching mail, `orca gmail search` and `orca gmail read`. |
| `https://www.googleapis.com/auth/gmail.send` | Only with **Allow send** on | Send a reply in a thread. |
| `https://www.googleapis.com/auth/gmail.modify` | Never | Orca changes no label and marks no mail as read. The History API cursor is its position. |

If you change **Allow send**, press **Reconnect with Google**. Google then asks for the new set.

## 3. What Orca reads, and what it does not read

- For each new mail in your mailbox, Orca reads its labels and its `Message-ID` header. It needs the
  `Message-ID` to ask Gmail whether the mail matches the query.
- Orca reads the full content (headers, text, attachments) only of a mail that matches the query.
  Only that mail becomes an event.
- Every other mail stays private. Orca does not keep it, show it or give it to an agent.
- `orca gmail search` and `orca gmail read` let the orchestrator read any mail in your mailbox. They
  are read only. They work only in your own chat with the orchestrator. Orca refuses them for a wake
  that an outside sender caused.
- The refresh token is AES-256-GCM ciphertext in the `secret` table (scope `integrations`, name
  `gmail.<integration id>.refresh_token`). The access token is in the bridge's memory only. No token
  goes to a log, to `.env`, to the integration's status or to an agent's environment.
- Orca does not get your Google password, your contacts or your calendar.

## 4. Set up Google Cloud

Do these steps one time. You need a Google account that can create a Google Cloud project.

### 4.1 Make the project and turn on the Gmail API

1. Open <https://console.cloud.google.com/>.
2. Open the project menu at the top. Click **New project**.
3. Type the name `Orca`. Click **Create**. Select the new project.
4. Open **APIs & Services > Library**.
5. Search for `Gmail API`. Open it. Click **Enable**.

### 4.2 Set the OAuth consent screen

Open **Google Auth Platform** (in older consoles: **APIs & Services > OAuth consent screen**). Click
**Get started** if Google asks.

1. In **App information**, type the app name `Orca`. Select your address as the support email.
2. In **Audience**, select one type:
   - **Google Workspace account** (an address on your company's domain): select **Internal**.
     Google does not verify an Internal app. Its refresh tokens do not expire after 7 days. Use this
     type when you can.
   - **Personal account** (`@gmail.com`): select **External**.
3. In **Contact information**, type your address.
4. Accept the policy. Click **Create**.
5. Open **Data Access**. Click **Add or remove scopes**. Add `.../auth/gmail.readonly`. Add
   `.../auth/gmail.send` too if you will turn on **Allow send**. Click **Update**, then **Save**.

For an **External** app, do these steps too:

1. Open **Audience**. The publishing status is **Testing**.
2. Under **Test users**, click **Add users**. Add your own Gmail address. Click **Save**.

> **Important: a Testing app's refresh token expires after 7 days.** Google ends the grant 7 days
> after each Connect. The card then says **reconnect needed**, and Orca reads no more mail. Press
> **Reconnect with Google** to continue for 7 more days.
>
> To stop this, publish the app: open **Audience** and click **Publish app** (the status becomes
> **In production**). Google does not verify the app for your own use. At Connect, Google shows
> "Google hasn't verified this app". Click **Advanced**, then **Go to Orca (unsafe)**. An unverified
> app can have at most 100 users, and you are the only one. Do not publish the app for other people.

### 4.3 Make the OAuth client

1. Open **Google Auth Platform > Clients** (in older consoles: **APIs & Services > Credentials >
   Create credentials > OAuth client ID**).
2. Click **Create client**.
3. Select the application type **Web application**. Type the name `Orca`.
4. Under **Authorized redirect URIs**, click **Add URI**. Type the address of your Orca page plus
   the callback path:

   ```text
   https://<your Orca host>/api/integrations/oauth/google/callback
   ```

   The origin must be the address that you open Orca at, with no path. Google accepts only these:
   - An `https://` address on a domain name. A Tailscale HTTPS name (`https://<machine>.<tailnet>.ts.net`,
     from `tailscale serve`) works. Google never connects to it: your browser does the redirect, so a
     tailnet-only address is correct.
   - `http://localhost:<port>` (for example `http://localhost:8787`) on the machine that runs Orca.

   Google refuses a raw IP address and a plain `http://` name such as `http://my-box:8787`. Add one
   URI for each address that you open Orca at.
5. Leave **Authorized JavaScript origins** empty. Click **Create**.
6. Copy the **Client ID** (`….apps.googleusercontent.com`) and the **Client secret** (`GOCSPX-…`).

## 5. Give the client secret to Orca

The client secret is the integration's secret. Use one of these:

- Put it in the `.env` of each bridge that can run the integration, then restart that bridge:

  ```bash
  ORCA_SECRET_GOOGLE_OAUTH=GOCSPX-…
  ```

- Or store it as an Orca stored secret named `ORCA_SECRET_GOOGLE_OAUTH`, in the `integrations` or the
  `default` scope (a form's secret field, or the composer's `/secret`). Orca uses the env var first.

You can use another name. Type it in the **Secret variable** box of the Connect form. It must start
with `ORCA_SECRET_`, so agents never see it. An empty box means `ORCA_SECRET_GOOGLE_OAUTH`.

## 6. Connect in Orca

1. Open **Integrations** and click **Connect**.
2. Select the kind **Gmail**. Type a name, for example `My Gmail`.
3. Paste the **OAuth client id**.
4. Turn on **Allow send** if Orca may answer in Gmail threads. Leave it off for read only.
5. Change the **Gmail query** if you want. Empty means `label:Orca OR to:<you>+orca@<your domain>`.
6. Click **Save**.
7. On the new card, click **Connect with Google**.
8. Select your Google account. Allow the access that Google shows.
9. Google sends you back to the Integrations page. The card says `Signed in as <your address> · read`
   (or `read + send`).
10. Add a link. Use the catch-all link (external id `*`) for every sender, or one link for each
    sender address.
11. Add yourself as a person, with your Gmail address as an identity. Then your own notes to your
    `+orca` address get your grant. A sender who is not a person gets a read-only grant (ADAPTERS.md
    section 10).

In Gmail, make a label named `Orca`. Put the label on a mail to give it to Orca. You can also make a
Gmail filter that puts the label on some mail. A mail to `<you>+orca@<your domain>` goes to Orca with
no label.

At the first poll, Orca starts at the newest mail. It does not read old mail.

### More than one Orca server

The bridge that gets the callback stores the refresh token with its own secret store key. Another
server can use the token only with the same key. Do one of these:

- Set the same `ORCA_SECRETS_KEY` on every server.
- Or pin the integration (**Runs on**) to the server whose page you use for Connect.

The pending sign-in is in the shared database, so a restart between Start and the callback is safe.
The sign-in must end within 10 minutes.

## 7. The config

Each value can be a string, as the Settings form saves it.

| Key | Default | Meaning |
|---|---|---|
| `clientId` | (required) | The OAuth client id. |
| `query` | `label:Orca OR to:<you>+orca@<domain>` | The Gmail search that selects Orca's mail. |
| `allowSend` | `false` | Ask for `gmail.send` and send replies. |
| `pollSeconds` | 60 | The poll interval. |
| `allowedSenders` | none | Addresses, or `@domain` for a domain, separated by commas. Empty: every sender that the query finds. |
| `checkAuth` | `true` | Require Google's DKIM, SPF or DMARC pass for the From domain. |
| `keepQuoted` | `false` | Keep the quoted history of a reply in the text. |
| `fromName` | none | The display name in From. |
| `perHour` | 20 | The maximum number of mails to one address each hour. |
| `redirectOrigin` | the page's origin | A fixed origin for the redirect URI, when you open Orca at more than one address. |

`authUrl`, `tokenUrl`, `revokeUrl` and `apiUrl` change Google's endpoints. Only the tests use them.

## 8. Threads and replies

- The thread is Gmail's own thread id. A reply from a person in a thread that Orca started goes to
  that thread's workstream.
- `orca post --reply` answers the mail that woke the orchestrator, in its Gmail thread.
- Orca's mail in a thread has `In-Reply-To` and `References` from the thread's last mail, and a
  subject that starts with `Re:`.
- Before a send, Orca looks in Sent for the delivery's Message-ID. A retry after a send that reached
  Gmail does not send the mail two times.
- Attachments go out as files (20 MB at most for each file).

## 9. The orchestrator's verbs

```text
orca gmail search "<gmail query>" [--limit 10] [--integration <id>]
orca gmail read <message id> [--integration <id>]
```

`search` lists the id, thread, date, sender, subject and a short part of each mail. `read` shows one
mail's headers, text and attachment names. Both are read only, and they work only in your own chat.
With more than one Gmail integration, name one with `--integration`.

## 10. Reconnect, disconnect, remove

- **reconnect needed**: Google refused the refresh token. You revoked access, you changed your
  password, or a Testing app's 7 days ended. Orca does not try that token again. Press
  **Reconnect with Google**.
- **Disconnect** on the card revokes the grant at Google and deletes the stored refresh token. The
  integration, its links and its events stay.
- **Remove** does the same, then deletes the integration.
- You can also remove Orca's access at <https://myaccount.google.com/permissions>.

## 11. Limits

- Gmail keeps history for about one week. If the bridge is off for longer, Orca starts again at the
  newest mail. It does not read the mail in the gap.
- One poll checks at most 200 new mails. The next poll reads the rest.
- The query match uses `rfc822msgid:`. A mail with no `Message-ID` header never matches.

## 12. Test it

`tests/gmail.test.ts` runs the adapter against a fake Google OAuth server and a fake Gmail API on
loopback. It never calls Google.

```bash
bun test tests/gmail.test.ts
```
