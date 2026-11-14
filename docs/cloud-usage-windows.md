# Google Cloud usage windows (experimental)

Settings > General > **Start windows in Google Cloud** is off by default. It runs a personal Cloud Run Job in your Google Cloud project while the PC and IDE are off. Google operates the infrastructure; there is no shared Clanker backend. The existing local **Start usage windows early** switch remains independent.

## Setup

1. Install the [Google Cloud CLI](https://cloud.google.com/sdk/docs/install). Create or select a personal Google Cloud project with billing enabled and permission to enable APIs, create service accounts, assign resource IAM policies, submit builds, and deploy Cloud Run and Scheduler jobs. A project Owner can do this; organization policies can still prevent it.
2. Enable the cloud switch, click **Connect Google Cloud**, complete Google's browser login, and select the project. Clanker uses the official `gcloud` login rather than collecting your Google password or operating an OAuth backend.
3. Set your weekly work calendar and IANA timezone, then **Save calendar**. This is Clanker's own work calendar, not an integration with Google Calendar events. Shifts must start/end on the hour within the same day. The early-start offset must fit before the work start on that date; overnight shifts are not supported.
4. Choose **Review & deploy** and review the cost and credential notice. Deployment builds an image containing official Claude Code and Codex releases pinned at build time, installs one hourly Scheduler job and one Cloud Run Job, and creates dedicated runtime/build buckets, an Artifact Registry repository, and three service accounts. No model request is made by deployment.
5. Connect each deployed subscription separately. For Claude, run `claude setup-token` yourself, then paste that token into the password input. For Codex, **Connect** opens an official, separate browser login in a temporary `CODEX_HOME`; its resulting subscription auth cache is uploaded and the temporary local directory is removed. Desktop credentials are not automatically copied. API-key accounts are skipped.

The initial adapters support Claude Code and Codex. Antigravity (`agy`, registered as `gemini`) has no supported cloud authentication adapter here. Gemini CLI has different authentication/quota behavior and is not a substitute. Providers added to the local registry are not silently uploaded or enabled in the cloud.

## Calendar and dispatch

For 09:00–18:00 work with a three-hour lead, planned starts are 06:00, 11:00, and 16:00, with a pause until the next selected day. The first *planned* reset is 11:00. Real provider activity, outages, quotas, and delayed starts can change actual resets. A successful tiny response is not proof that a provider started a fresh window. Weekly or shared model limits are not increased.

The timer checks hourly in the selected timezone; the runner sends only at a due calendar slot and within its first 15 minutes. Delayed jobs do not replay old slots. Wall-clock schedules follow daylight saving, and durable slot IDs suppress duplicated local hours. Skipped clock hours are skipped. Overnight windows use elapsed five-hour cooldowns, not clock arithmetic.

Cloud state reserves each request before dispatch. A generation-checked lease suppresses concurrent executions, including manual duplicate deliveries. There are no automatic CLI retries; Cloud Run and Scheduler retries are disabled. Known provider cooldowns and desktop quota reset readings suppress warmups. The IDE syncs status and desktop reset readings every 15 minutes while open. Activity on other devices while this IDE is offline cannot always be observed in advance; a scheduled ping may therefore arrive during an existing window.

Deployed providers are excluded from local warmups while cloud operation is enabled and unexpired. Recent cloud cooldowns also prevent an immediate local ping after cloud operation is paused. Manual chats and quota-reset continuations still run normally. Redeploy to change the selected cheap models, provider set, or installed CLI versions.

## Credentials and failures

Subscription credentials are stored in the private runtime bucket, encrypted at rest by Google, with uniform bucket access and public-access prevention. Object versioning and soft delete are disabled so removed/rotated tokens do not accumulate as historical objects. Google project administrators and the runner service account can access these credentials; encryption does not eliminate that trust. No account credentials, workspace files or `.env` files enter the build context. The dedicated builder can access its separate build bucket and image repository, not the runtime credential bucket. Cloud jobs receive no service-account key files; they use Google's attached workload identity.

Codex refreshes its separate cloud credentials through the official CLI; the updated cache is conditionally written back so an explicit reconnect is not overwritten by an older execution. Authentication failures pause that provider until reconnected. Quota failures and unknown failures wait for a later calendar slot; partial output is not treated as success. CLI output and credential values are not printed to cloud logs.

Cloud Run does not supply the kernel sandbox Codex normally uses. This runner therefore executes Codex in its disposable Google container with command execution and web search disabled, a fixed prompt, and no mounted projects. Claude runs with its built-in tools disabled. These are dedicated warmup invocations, not remote access to your desktop or projects.

Clanker shows reconnect warnings while the IDE is open, including after reopening and refreshing. Phone/email alerts while the PC is off are not configured. Check **Refresh status** or **Open Google console** for infrastructure failures. No live cloud deployment or real model call is part of the repository checks.

## Costs, pause, and removal

This feature is **not guaranteed free**. Google may charge for incorrect setup, extra executions/retries, more providers, other projects sharing the free allowances, container images, builds, storage, API operations, or network traffic. The displayed compute estimate includes an hourly job's minimum billing duration and a conservative prompt allowance; it is not a total bill estimate. Budget alerts do not cap charges. See [Cloud Run pricing](https://cloud.google.com/run/pricing) and [Scheduler pricing](https://cloud.google.com/scheduler/pricing).

Each deployment/renewal permits prompts for 30 days. Expiry stops model requests, but the hourly timer and stored resources remain and can still incur usage or charges. **Renew for 30 days** explicitly resumes the timer and extends that date. Pausing writes a remote kill switch before stopping the timer. If the PC is offline or lacks Google permission, Clanker reports the failure instead of claiming the cloud is off; use Google's console. A prompt already in progress may finish after pausing.

**Remove cloud runner & credentials** disables prompts and deletes the named Scheduler job, Cloud Run Job, runtime/build buckets, image repository and dedicated service accounts. Partial provisioning and failed deletion retain resource names so cleanup can be retried. Google audit/build history can remain. Removing/disabling the IDE extension alone does **not** remove cloud resources; use the removal control first. Review the Google console after an interrupted deployment.

Resources use the `clanker-warmup` names within the selected project: use a dedicated personal project. One deployment per project is intended; multiple computers pointing at it share its calendar and slot reservations. Do not use these resource names for unrelated services.
