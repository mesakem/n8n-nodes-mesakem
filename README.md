# n8n-nodes-mesakem

n8n nodes for [Mesakem](https://mesakem.com), the AI meeting notetaker.

- **Mesakem Trigger** starts a workflow the moment something happens in Mesakem: a summary is ready, a meeting ends, a transcript is ready, action items are created, a task changes, and more (24 event types). Mesakem pushes each event to n8n. Nothing is polled.
- **Mesakem** reads meetings, summaries, transcripts, upcoming meetings, documents and tasks. It can also create, update and cancel tasks, and send, schedule or cancel the Mesakem notetaker.

The nodes only call the [Mesakem public API v1](https://mesakem.com/en/developers). They use no AI features and add no cost of their own.

## Installation

In n8n (self-hosted): **Settings → Community Nodes → Install**, then enter `n8n-nodes-mesakem`.
See the [n8n community nodes guide](https://docs.n8n.io/integrations/community-nodes/installation/).

## Credentials

1. In Mesakem, open **Settings → API & webhooks** and create an API key. It starts with `msk_live_` (organization keys start with `msk_org_`).
2. In n8n, create a **Mesakem API** credential and paste the key.
3. Leave **Base URL** as `https://mesakem.com/api/v1`. Change it only to test against another Mesakem server.

n8n tests the credential with `GET /me`.

**What each plan can do**

| | Free / trial | Paid and organization seats |
|---|---|---|
| Read meetings, summaries, transcripts, tasks, documents | Yes | Yes |
| Create, update or cancel tasks; send, schedule or cancel the notetaker | No (read-only) | Yes |
| Mesakem Trigger, automatic registration | No | Yes, up to 10 endpoints per person |
| Mesakem Trigger, manual registration | Yes (your one webhook) | Yes |

A key also needs the right permission (scope) for each step, for example `tasks:write` to create tasks or `webhooks:write` (Manage webhooks) for automatic triggers. When a plan or a permission is missing, the node stops with a message that says which one and what to do.

## Mesakem Trigger

Your n8n instance must be reachable from the internet over **https**. Mesakem delivers only to public https addresses on port 443 or 8443, so `http://localhost` does not work. Use a public n8n URL (the `WEBHOOK_URL` setting of n8n) or a tunnel.

**Registration**

- **Automatic** (paid plans): when you activate the workflow, the node creates one Mesakem webhook for this workflow. When you deactivate it, the node deletes that webhook. Each active workflow with a Mesakem Trigger uses one webhook endpoint. "Listen for test event" in the editor creates a temporary one for the test address.
- **Manual** (works on Free): copy the trigger's **Production URL**, add it as a webhook in Mesakem **Settings → API & webhooks**, choose the same events, and paste the signing secret (`whsec_…`) into **Signing Secret**. The node never calls the webhook API in this mode.

**Security.** Every delivery is checked against its Standard Webhooks signature (`webhook-id`, `webhook-timestamp`, `webhook-signature`), using the secret Mesakem returned for this webhook. A delivery that is unsigned, tampered or older than 5 minutes is answered with 401 and does not start the workflow. Details are always fetched by ID from the credential's Base URL. Links inside the payload are never followed.

**What you get.** Mesakem payloads are short: they hold IDs only. With **Fetch Details** on (the default), the node fetches what you need, in at most **two API requests per event**:

| Events | Fetched |
|---|---|
| Summary Ready, Summary Updated, Call Summarized | the summary (plus the meeting, unless you turn that off) |
| Meeting Scheduled, Started, Ended, Failed, Notetaker Status Changed, Recording Ready | the meeting |
| Transcript Ready, Call Transcript Ready | the meeting (plus the transcript text, if you turn that on) |
| Action Items Created | the new tasks (one item per task) and the meeting |
| Task Created, Task Updated | the task |
| Meeting Deleted, Task Deleted, share, room and upload events | nothing (the short event only) |

If the item was deleted before n8n fetched it, the workflow still runs, with `resource_deleted: true`.

**Duplicates.** Mesakem retries failed deliveries. The event `id` stays the same on every retry, so use it to skip duplicates when that matters.

**Testing.** In Mesakem Settings, "Send test" on the webhook sends a `webhook.test` event. While you "Listen for test event" in the editor, it shows up as an item. An active workflow ignores it.

## Mesakem node

| Resource | Operations |
|---|---|
| Meeting | Get, Get Many, Get Summary, Get Transcript (text, JSON segments, WebVTT, SRT), Get Upcoming |
| Task | Get, Get Many, Create, Update (title, description, status), Delete (Mesakem keeps it as cancelled) |
| Notetaker | Send (to a meeting link, now or later), Schedule (an upcoming calendar meeting), Cancel (skip an upcoming meeting, or leave a meeting in progress) |
| Document | Get (Markdown, HTML, text, raw or JSON) |
| Account | Get (the key, its user, plan, permissions and limits) |

Meetings, upcoming meetings and tasks can be picked from a list or entered by ID. Dates without a time zone use the workflow's time zone.

Writes send an `Idempotency-Key` that stays the same within one execution, so "Retry On Fail" never sends a second notetaker or creates a second task.

**Limits.** Each API key may make 60 requests per minute. When the limit is reached, the node says so; turn on "Retry On Fail" in the node settings if you run large batches. Sending the notetaker uses your plan's meeting quota, and Mesakem limits how many notetakers it sends per minute, hour and day.

## Testing against staging

1. Create a key on the staging server (`https://staging.mesakem.com` → Settings → API & webhooks).
2. In the credential, set **Base URL** to `https://staging.mesakem.com/api/v1`.
3. Use an n8n instance with a public https address for the trigger.

## Development

```bash
npm install
npm run build     # n8n-node build (TypeScript + icons)
npm run lint      # n8n's community node linter
npm test          # unit tests with mocked HTTP (no network)
npm run dev       # runs a local n8n with these nodes
```

## Releasing (maintainers)

Verified community nodes must be published from GitHub Actions with npm provenance (n8n rule since May 1, 2026). This folder includes `.github/workflows/publish.yml` for that. It runs when a version tag is pushed.

1. Put this folder in its own public GitHub repository, for example `github.com/mesakem/n8n-nodes-mesakem`. Update `repository`, `homepage` and the links in `nodes/*/*.node.json` if the address differs.
2. On npmjs.com, create the account or organization that will own the package, and turn on two-factor authentication.
3. First release: create a granular npm access token with publish rights. Add it to the GitHub repository as the secret `NPM_TOKEN`. Then run `npm run release` on your machine. It bumps the version, tags and pushes, and the workflow publishes. (`npm publish` alone is blocked on purpose.)
4. After the first release, switch to npm Trusted Publishing: on npmjs.com, open the package → Settings → Trusted Publishers. Add the GitHub repository with workflow `publish.yml`, then delete the `NPM_TOKEN` secret.
5. Check the package: `npx @n8n/scan-community-package n8n-nodes-mesakem`.
6. Submit it for verification in the [n8n Creator Portal](https://docs.n8n.io/integrations/creating-nodes/deploy/submit-community-nodes/).

## License

[MIT](LICENSE.md)
