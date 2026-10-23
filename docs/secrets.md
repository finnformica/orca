# Forms in the chat and the secret store

An agent (the orchestrator first) can ask the user for structured data. The form shows as a card in
the Orca chat. A field can be a secret. Orca stores a secret value encrypted. The agent can use the
value in a command, but the agent never sees it.

## Ask for a form

```text
orca ask-form --title "…" [--intro "…"] [--scope <scope>] --fields <json|@file>
```

`--fields` is a JSON array, or `@file` with the array in a file (relative to the caller's directory).
Each field is an object:

| Key | Use |
| --- | --- |
| `name` | The key in the answers. Letters, digits, `_`, `.` or `-`. Unique in the form. |
| `label` | The text above the input. |
| `type` | `text`, `textarea`, `number`, `date`, `datetime`, `select`, `multiselect`, `checkbox`, `url`, `email` or `secret`. |
| `required` | `true` makes the field necessary. A required checkbox must be ticked. |
| `help`, `placeholder` | Text for the user. |
| `default` | The start value. A secret field has no default. |
| `options` | For `select` and `multiselect` only: text, or `{ "value", "label" }`. |
| `min`, `max` | `number`: the value. `text`, `textarea`, `secret`: the length. `multiselect`: the count. `date`, `datetime`: ISO text. |
| `scope` | For `secret` only: the scope of the stored secret. The default is the form's `--scope`, else `default`. |

Orca checks the spec before it asks. It refuses an unknown key, a wrong type, a missing option list
and a default on a secret field. It lists every problem in one message.

The command returns at once with the form's id (`orca-form://<id>`). The chat shows the card under
the turn that asked it. The submit wakes the orchestrator with one message:

```text
[form answered] Set up billing (form <id>)
{ "project": "orca", "replicas": 3, "api_key": { "name": "billing/api_key", "stored": true } }
```

Cancel wakes it with `[form cancelled] …`.

A channel (Discord, Slack, email) never shows a field. A form sends the title, the intro and a link
to the Orca chat to every channel that subscribes to `orca.question`.

## Use a stored secret

```text
orca secret list                          names, scope, created, last used — never a value
orca secret pipe <name> -- <cmd…>         run cmd with the value on its stdin
orca secret env <name>[=VAR] -- <cmd…>    run cmd with the value in VAR (default: the name in capitals)
orca secret delete <name>                 delete the secret
```

A name is `name` in the `default` scope, else `scope/name`. A bare name in two scopes is refused.
The bridge runs the command in the caller's directory with an agent's environment. The command's
output and exit code come back. Each use writes one audit row.

Example:

```bash
orca secret pipe gh_token -- gh auth login --with-token
orca secret env billing/api_key=STRIPE_KEY -- ./scripts/sync-prices.sh
```

## The paste guard

The chat composer holds text that looks like a key before it is sent. It knows the shape of each of
these (`shared/secretGuard.ts`, taken from the gitleaks rule set):

- Anthropic (`sk-ant-…`), OpenRouter (`sk-or-…`), OpenAI-style (`sk-…`), Stripe (`sk_live_…`,
  `sk_test_…`, `rk_live_…`).
- GitHub (`ghp_…`, `github_pat_…`), GitLab (`glpat-…`), Slack (`xox…`), Discord bot tokens.
- AWS access keys (`AKIA…`, `ASIA…`), Google API keys (`AIza…`), Google OAuth client secrets
  (`GOCSPX-…`).
- SendGrid (`SG.…`), Twilio API keys and account SIDs (`SK…`, `AC…` + 32 hex), npm (`npm_…`), PyPI
  (`pypi-…`), Hugging Face (`hf_…`), Shopify (`shpat_…` and its siblings).
- Notion (`secret_…`, `ntn_…`), Linear (`lin_api_…`), a JWT (`eyJ…`.`eyJ…`.`…`), a private key
  block.
- A long random string (32 to 512 characters, mixed case plus digits, high entropy; a hex-only run
  is left to the rule below, since a hash or a UUID has that same shape).
- **A keyword just before a token on the same line**: `key`, `token`, `secret`, `password`,
  `passwd`, `pwd`, `api_key`, `apikey`, `auth` or `bearer`, then an optional quote and a separator
  (`=`, `:` or a space), then 16 or more characters (hex and a single case both count — this is
  what catches a Datadog- or Mailgun-style hex key with no prefix of its own).

The bar under the box gives two choices:

- **Save as secret** stores each value in the `chat` scope. The message then holds
  `[secret chat/<name> stored]` in place of the value.
- **Send anyway** sends the text as it is.

A commit sha, a UUID, a URL and a path do not trigger the guard — unless one of the keywords above
sits right before it.

`server/handoff.ts` scans a handoff pack for the same shapes (`shared/secretGuard.ts`'s
`KEY_PATTERNS`), plus one shape of its own: a `PASSWORD=value` line in a file, for scanning a whole
`.env`-style file rather than a chat message.

## Security model

- **Where values live.** Only as AES-256-GCM ciphertext in the `secret` table in Postgres. A form's
  answers (`form.answers`) hold the secret's name, never the value.
- **The key.** `ORCA_SECRETS_KEY`: base64 of 32 bytes, or any text (Orca hashes it). Without it,
  Orca makes `~/.orca/secrets.key` (or `$ORCA_STATE_DIR/secrets.key`) on first use, with mode 0600, and
  logs the path. Each row records the key's id. A secret stored with another key is listed, but this
  bridge does not use it. To share secrets between instances, set the same `ORCA_SECRETS_KEY` on each.
  The form and secret routes go to the orchestrator's instance (`orchestratorOn`), so one key
  encrypts them.
- **What agents see.** `ORCA_SECRETS_KEY` is in `ORCA_SECRETS` (`server/env.ts`), so no agent's
  environment has it. An agent gets names only. A value goes from the store into one command.
- **Scrub.** The bridge replaces every stored value with `[secret <name>]` in:
  - the text `orca` returns to an agent (each verb, its errors, and `pipe` / `env` output);
  - transcript steps (tool input and output) and the copy sent to the chat stream;
  - each turn's prompt, instruction, response and structured outcome, also in the outbox journal;
  - every outbound channel post (the dispatcher, before the adapter sends).

  The scrub reads an in-memory cache of the values this bridge can decrypt. Orca reads the cache at
  connect, every minute, and at once after a store or a delete. A value shorter than 6 characters is
  not scrubbed, because the scrub would cut ordinary words.
- **Who can use the store.** `orca secret` is owner-only: a wake that an outside sender caused
  (Discord, Slack, a webhook) cannot list, use or delete a secret. `orca ask-form` is allowed at the
  "ask" level, like `orca ask-user`.
- **Audit.** `secret_use` has one row for each store, `pipe`, `env` and `delete`: who, the command's
  name (never its arguments) and when.

### Limits

The store keeps values out of the model's context, the transcripts and the channel posts. It is not
a sandbox:

- An agent with a shell as the same OS user can read the key file and the database URL.
- A command can change a value (for example, base64) before it prints it. The scrub does not find
  a changed value.
- The live reply stream (text deltas) is not scrubbed. Orca never stores it, and the stored final
  message replaces it.
