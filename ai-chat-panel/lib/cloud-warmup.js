'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { run, shimmed } = require('./loop-exec');
const { cheapestModel } = require('./session-warmup');
const { defaults, plan, estimate, credential, SUPPORTED } = require('./cloud-warmup-plan');
const { bucketStore } = require('../cloud-warmup/runner');

const ID = 'clanker-warmup';
const REGION = 'us-central1';
const RISK = 'Google Cloud can charge you if configured incorrectly, if retries or provider count increase, or if your account exceeds shared free allowances. Builds, container images, storage and networking may also cost money. Budget alerts are not spending caps. Provider subscription credentials will be stored in your private Google Cloud project. This is a personal experiment, not a guarantee of free operation or additional AI allowance.';

function findGcloud(env = process.env) {
  const dirs = [...(env.PATH || env.Path || '').split(path.delimiter),
    path.join(env.LOCALAPPDATA || '', 'Google', 'Cloud SDK', 'google-cloud-sdk', 'bin'),
    path.join(env['ProgramFiles(x86)'] || '', 'Google', 'Cloud SDK', 'google-cloud-sdk', 'bin')];
  return dirs.map(d => path.join(d.replace(/^"|"$/g, ''), process.platform === 'win32' ? 'gcloud.cmd' : 'gcloud')).find(f => fs.existsSync(f)) || '';
}

class CloudWarmup {
  constructor({ context, vscode, models, locate, enabledAgents, subscription, readQuotas, onChange = () => {}, execute = run, fetchImpl = fetch }) {
    Object.assign(this, { context, vscode, models, locate, enabledAgents, subscription, readQuotas, onChange, execute, fetchImpl });
    this.saved = context.globalState.get('cloudWarmup', {});
    try { this.schedule = plan(this.saved.schedule || defaults()); } catch { this.schedule = defaults(); }
    this.status = this.saved.deployed ? 'Saved cloud deployment; refresh to check status.' : 'Off. No Google resources have been created.';
    this.states = this.saved.states || {}; this.busy = false; this.token = null;
  }
  snapshot() {
    return { enabled: this.saved.enabled === true, deployed: Boolean(this.saved.deployed), connected: Boolean(this.saved.project), project: this.saved.project || '',
      region: REGION, schedule: this.schedule, expiresAt: this.saved.expiresAt, status: this.status, busy: this.busy, states: this.states,
      providers: SUPPORTED.map(agent => ({ agent, label: agent === 'claude' ? 'Claude Code' : 'Codex', selected: Boolean(this.saved.providers?.[agent]), connected: Boolean(this.saved.auth?.[agent]), model: this.saved.providers?.[agent]?.model || '' })),
      estimate: estimate(plan(this.schedule), Object.keys(this.saved.providers || {}).length), risk: RISK };
  }
  owns(agent) { return Boolean(this.saved.deployed && this.saved.enabled && this.saved.providers?.[agent] && Date.now() < this.saved.expiresAt); }
  coolingDown(agent) { return this.states[agent]?.next > Date.now(); }
  async save(patch) { this.saved = { ...this.saved, ...patch }; await this.context.globalState.update('cloudWarmup', this.saved); this.onChange(); }
  start() {
    this.timer = setInterval(() => { if (this.saved.deployed && !this.busy) void this.handle({ action: 'refresh', silent: true }); }, 15 * 60000);
    this.timer.unref?.();
    if (this.saved.deployed) this.startup = setTimeout(() => void this.handle({ action: 'refresh', silent: true }), 20000);
  }
  dispose() { clearInterval(this.timer); clearTimeout(this.startup); this.output?.dispose(); }
  async gcloud(args, { timeoutMs = 60000, cwd, input, env } = {}) {
    const file = findGcloud();
    if (!file) throw Error('Install the Google Cloud CLI, then connect again: https://cloud.google.com/sdk/docs/install');
    if (this.saved.account && !this.connecting) args = [...args, `--account=${this.saved.account}`];
    let result;
    if (process.platform === 'win32') {
      // Pass argument data over stdin, never interpolate paths or values into PowerShell code.
      result = await this.execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$r = [Console]::In.ReadToEnd() | ConvertFrom-Json; $a = @($r.args); & $r.file @a; exit $LASTEXITCODE'], {
        cwd: cwd || os.tmpdir(), env, timeoutMs, input: JSON.stringify({ file, args }), maxBytes: 2 * 1024 * 1024 });
    } else result = await this.execute(file, args, { cwd: cwd || os.tmpdir(), env, timeoutMs, input, maxBytes: 2 * 1024 * 1024 });
    if (result.code !== 0) {
      const detail = String(result.stderr || '').replace(/ya29\.[\w.-]+|sk-ant-[\w-]+/g, '[redacted]').slice(-1200);
      const error = Error(`Google Cloud command failed. ${detail || 'Check project permissions, billing, and Google Cloud CLI sign-in.'}`);
      error.notFound = /NOT_FOUND|not found|does not exist/i.test(detail); throw error;
    }
    return result.output.trim();
  }
  async accessToken() {
    if (!this.token || this.token.until < Date.now()) this.token = { value: await this.gcloud(['auth', 'print-access-token', '--quiet']), until: Date.now() + 45 * 60000 };
    return this.token.value;
  }
  async api(url, options = {}) {
    const r = await this.fetchImpl(url, { ...options, headers: { Authorization: `Bearer ${await this.accessToken()}`, 'Content-Type': 'application/json', ...options.headers }, signal: AbortSignal.timeout(30000) });
    if (!r.ok) { const e = Error(`Google Cloud request failed (${r.status}). Check permissions and billing in the Google Cloud console.`); e.status = r.status; throw e; }
    return r.status === 204 ? null : r.json();
  }
  store() {
    if (!this.saved.bucket) throw Error('Deploy the cloud runner first.');
    return bucketStore(this.saved.bucket, () => this.accessToken(), this.fetchImpl);
  }
  async config(enabled = this.saved.enabled) {
    await this.store().put('config.json', { enabled: Boolean(enabled), schedule: plan(this.schedule), providers: this.saved.providers || {},
      expiresAt: this.saved.expiresAt, revision: crypto.randomUUID() });
  }
  async connect() {
    this.connecting = true;
    this.status = 'Opening Google sign-in…'; this.onChange();
    await this.gcloud(['auth', 'login', '--quiet'], { timeoutMs: 300000 }); this.token = null;
    const account = await this.gcloud(['config', 'get-value', 'account', '--quiet']);
    if (!/^[^\s@]+@[^\s@]+$/.test(account)) throw Error('Google sign-in did not return an account. Sign in again.');
    const projects = JSON.parse(await this.gcloud(['projects', 'list', '--format=json(projectId,name)', '--quiet']));
    if (!projects.length) throw Error('No Google Cloud projects are available. Create a personal project with billing enabled in the Google Cloud console, then connect again.');
    const pick = await this.vscode.window.showQuickPick(projects.map(p => ({ label: p.name || p.projectId, description: p.projectId })), { title: 'Choose your Google Cloud project', placeHolder: 'Use a personal project with billing enabled. No Clanker backend is involved.' });
    if (!pick) return;
    if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(pick.description)) throw Error('Invalid Google Cloud project ID.');
    if (this.saved.deployed && pick.description !== this.saved.project) throw Error('Remove the existing deployment before changing projects.');
    const billing = await this.api(`https://cloudbilling.googleapis.com/v1/projects/${pick.description}/billingInfo`);
    if (!billing.billingEnabled) throw Error('Enable billing for the selected Google Cloud project, then connect again. Free-tier usage still requires billing.');
    await this.save({ project: pick.description, account }); this.status = 'Google Cloud connected. Review your calendar, then deploy.';
  }
  async deploy() {
    if (!this.saved.enabled || !this.saved.project) throw Error('Enable the option and connect Google Cloud first.');
    const schedule = plan(this.schedule);
    if (!schedule.days.some(d => d.enabled)) throw Error('Select at least one work day.');
    const providers = Object.fromEntries(SUPPORTED.filter(agent => this.enabledAgents().includes(agent) && this.subscription(agent)).flatMap(agent => {
      const entry = cheapestModel(this.models(), agent);
      return entry ? [[agent, { model: entry.model, effort: entry.effort || null }]] : [];
    }));
    if (!Object.keys(providers).length) throw Error('Connect at least one supported subscription CLI locally: Claude Code or Codex. API-key accounts are skipped.');
    if (await this.vscode.window.showWarningMessage(RISK, { modal: true, detail: 'Creates one Cloud Run Job, one hourly Scheduler job, private runtime/build buckets, a container repository and three dedicated service accounts in your selected project. Automatically stops prompts after 30 days unless renewed. No prompt is sent during deployment.' }, 'Deploy to my Google Cloud project') !== 'Deploy to my Google Cloud project') return;
    const project = this.saved.project;
    const cmd = (args, options) => this.gcloud([...args, `--project=${project}`, '--quiet'], options);
    this.status = 'Enabling Google services…'; this.onChange();
    await cmd(['services', 'enable', 'run.googleapis.com', 'cloudscheduler.googleapis.com', 'cloudbuild.googleapis.com', 'artifactregistry.googleapis.com', 'storage.googleapis.com', 'iam.googleapis.com'], { timeoutMs: 180000 });
    const describe = JSON.parse(await cmd(['projects', 'describe', project, '--format=json(projectNumber)']));
    const bucket = `${project}-clanker-${describe.projectNumber}`;
    const buildBucket = `${project}-clanker-build-${describe.projectNumber}`;
    const runner = `${ID}-runner@${project}.iam.gserviceaccount.com`, scheduler = `${ID}-timer@${project}.iam.gserviceaccount.com`;
    const builder = `${ID}-build@${project}.iam.gserviceaccount.com`;
    const resource = { project, bucket, buildBucket, builder, runner, scheduler, providers, expiresAt: Date.now() + 30 * 86400000 };
    // Save resource names before provisioning, so partial deployments can be removed after an error or IDE restart.
    await this.save({ ...resource, provisioned: true });
    async function ensure(check, create) { try { await cmd(check); } catch (e) { if (!e.notFound) throw e; await cmd(create); } }
    await ensure(['iam', 'service-accounts', 'describe', runner], ['iam', 'service-accounts', 'create', `${ID}-runner`, '--display-name=Clanker personal warmup runner']);
    await ensure(['iam', 'service-accounts', 'describe', scheduler], ['iam', 'service-accounts', 'create', `${ID}-timer`, '--display-name=Clanker warmup timer']);
    await ensure(['iam', 'service-accounts', 'describe', builder], ['iam', 'service-accounts', 'create', `${ID}-build`, '--display-name=Clanker isolated image builder']);
    await ensure(['storage', 'buckets', 'describe', `gs://${bucket}`], ['storage', 'buckets', 'create', `gs://${bucket}`, `--location=${REGION}`, '--uniform-bucket-level-access', '--public-access-prevention']);
    await cmd(['storage', 'buckets', 'update', `gs://${bucket}`, '--uniform-bucket-level-access', '--public-access-prevention', '--clear-soft-delete', '--no-versioning']);
    await cmd(['storage', 'buckets', 'add-iam-policy-binding', `gs://${bucket}`, `--member=serviceAccount:${runner}`, '--role=roles/storage.objectUser']);
    await ensure(['storage', 'buckets', 'describe', `gs://${buildBucket}`], ['storage', 'buckets', 'create', `gs://${buildBucket}`, `--location=${REGION}`, '--uniform-bucket-level-access', '--public-access-prevention']);
    await cmd(['storage', 'buckets', 'update', `gs://${buildBucket}`, '--uniform-bucket-level-access', '--public-access-prevention', '--clear-soft-delete', '--no-versioning']);
    await cmd(['storage', 'buckets', 'add-iam-policy-binding', `gs://${buildBucket}`, `--member=serviceAccount:${builder}`, '--role=roles/storage.admin']);
    await ensure(['artifacts', 'repositories', 'describe', ID, `--location=${REGION}`], ['artifacts', 'repositories', 'create', ID, '--repository-format=docker', `--location=${REGION}`]);
    await cmd(['artifacts', 'repositories', 'add-iam-policy-binding', ID, `--location=${REGION}`, `--member=serviceAccount:${builder}`, '--role=roles/artifactregistry.writer']);
    // Pin provider versions in the image. Never copy a workspace, local CLI config, .env or credentials into build sources.
    this.status = 'Building the isolated CLI image. This can take several minutes…'; this.onChange();
    const versions = await Promise.all(['@anthropic-ai/claude-code', '@openai/codex'].map(async name => {
      const r = await this.fetchImpl(`https://registry.npmjs.org/${name}/latest`, { signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw Error('Cannot resolve the official CLI release.');
      const v = (await r.json()).version;
      if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(v)) throw Error('Invalid CLI release version.');
      return v;
    }));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clanker-build-'));
    const image = `${REGION}-docker.pkg.dev/${project}/${ID}/runner:${crypto.randomBytes(6).toString('hex')}`;
    try {
      let docker = fs.readFileSync(path.join(__dirname, '../cloud-warmup/Dockerfile'), 'utf8');
      docker = docker.replace('ARG CLAUDE_VERSION', `ARG CLAUDE_VERSION=${versions[0]}`).replace('ARG CODEX_VERSION', `ARG CODEX_VERSION=${versions[1]}`);
      fs.writeFileSync(path.join(dir, 'Dockerfile'), docker);
      for (const [source, target] of [[path.join(__dirname, 'cloud-warmup-plan.js'), 'cloud-warmup-plan.js'], [path.join(__dirname, '../cloud-warmup/runner.js'), 'runner.js']]) fs.copyFileSync(source, path.join(dir, target));
      fs.writeFileSync(path.join(dir, 'build.json'), JSON.stringify({ steps: [{ name: 'gcr.io/cloud-builders/docker', args: ['build', '-t', image, '.'] }], images: [image], options: { logging: 'GCS_ONLY' }, timeout: '900s' }));
      await cmd(['builds', 'submit', dir, `--config=${path.join(dir, 'build.json')}`, `--service-account=projects/${project}/serviceAccounts/${builder}`, `--gcs-source-staging-dir=gs://${buildBucket}/source`, `--gcs-log-dir=gs://${buildBucket}/logs`, `--region=${REGION}`, '--suppress-logs'], { timeoutMs: 1000000, cwd: dir });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    this.status = 'Deploying the runner and hourly timer…'; this.onChange();
    await cmd(['run', 'jobs', 'deploy', ID, `--image=${image}`, `--region=${REGION}`, `--service-account=${runner}`, '--tasks=1', '--parallelism=1', '--max-retries=0', '--task-timeout=300s', '--cpu=1', '--memory=1Gi', `--set-env-vars=CLANKER_BUCKET=${bucket}`]);
    await cmd(['run', 'jobs', 'add-iam-policy-binding', ID, `--region=${REGION}`, `--member=serviceAccount:${scheduler}`, '--role=roles/run.invoker']);
    const endpoint = `https://run.googleapis.com/v2/projects/${project}/locations/${REGION}/jobs/${ID}:run`;
    const timerArgs = [`--location=${REGION}`, '--schedule=0 * * * *', `--time-zone=${schedule.timezone}`, `--uri=${endpoint}`, '--http-method=POST', '--message-body={}', `--oauth-service-account-email=${scheduler}`, '--max-retry-attempts=0', '--attempt-deadline=60s'];
    await ensure(['scheduler', 'jobs', 'describe', ID, `--location=${REGION}`], ['scheduler', 'jobs', 'create', 'http', ID, ...timerArgs]);
    await cmd(['scheduler', 'jobs', 'update', 'http', ID, ...timerArgs]);
    await cmd(['scheduler', 'jobs', 'resume', ID, `--location=${REGION}`]);
    await this.config(true);
    await this.save({ deployed: true });
    this.status = 'Deployed. Connect each cloud subscription below; no desktop logins were uploaded.';
  }
  async authenticate(agent) {
    if (!SUPPORTED.includes(agent) || !this.saved.deployed || !this.saved.providers?.[agent]) throw Error('Deploy a supported subscription provider first.');
    let auth;
    if (agent === 'claude') {
      const token = await this.vscode.window.showInputBox({ title: 'Connect Claude Code in Google Cloud', prompt: 'Run claude setup-token in your terminal, then paste its subscription token. It will be stored in your private cloud bucket.', password: true, ignoreFocusOut: true });
      if (!token) return;
      auth = credential(agent, token);
    } else {
      const binary = this.locate('codex'); if (!binary) throw Error('Install Codex locally to authorize a separate cloud login.');
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clanker-cloud-login-'));
      this.status = 'Complete the separate Codex browser sign-in…'; this.onChange();
      try {
        const spec = shimmed(binary, ['login', '-c', 'cli_auth_credentials_store="file"']);
        const result = await this.execute(spec.command, spec.args, { cwd: dir, env: { ...spec.env, CODEX_HOME: dir, OPENAI_API_KEY: '', CODEX_API_KEY: '' }, timeoutMs: 300000 });
        if (result.code !== 0) throw Error('Codex cloud sign-in did not complete. Try again after closing other login attempts.');
        auth = credential(agent, JSON.parse(fs.readFileSync(path.join(dir, 'auth.json'), 'utf8')));
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }
    await this.store().put(`auth/${agent}.json`, auth);
    // Reset reconnect state only after a successful credential upload.
    await this.store().put(`state/${agent}.json`, { status: 'ready', at: Date.now() });
    await this.save({ auth: { ...this.saved.auth, [agent]: true } });
    this.status = `${agent === 'claude' ? 'Claude Code' : 'Codex'} cloud login saved. The next calendar slot will send the first prompt.`;
  }
  async refresh() {
    if (!this.saved.deployed) return;
    const cfg = (await this.store().get('config.json')).value;
    if (!cfg) throw Error('Cloud configuration is missing. Deploy again or remove the resources.');
    // Cloud state is authoritative across IDE restarts and other computers. Do not silently renew its expiry.
    this.schedule = plan(cfg.schedule);
    await this.save({ enabled: Boolean(cfg.enabled), expiresAt: cfg.expiresAt, providers: cfg.providers, schedule: this.schedule });
    const quotas = await this.readQuotas().catch(() => ({}));
    for (const agent of Object.keys(cfg.providers || {})) {
      const record = await this.store().get(`state/${agent}.json`);
      this.states[agent] = record.value || { status: 'reconnect' };
      const reset = quotas?.[agent]?.resetsAt * 1000;
      if (reset > Date.now() && reset > (record.value?.next || 0)) {
        try { await this.store().put(`state/${agent}.json`, { ...record.value, next: reset }, record.generation); } catch (e) { if (e.status !== 412) throw e; }
      }
      if (record.value?.status === 'reconnect' && this.notified?.[agent] !== record.value.at) {
        this.notified ||= {}; this.notified[agent] = record.value.at;
        void this.vscode.window.showWarningMessage(`Clanker cloud warmup: ${agent} needs a new cloud login. Reconnect it in Settings > General.`);
      }
    }
    await this.save({ states: this.states });
    const timer = await this.api(`https://cloudscheduler.googleapis.com/v1/projects/${this.saved.project}/locations/${REGION}/jobs/${ID}`);
    this.status = !cfg.enabled ? 'Cloud prompts are paused.' : cfg.expiresAt < Date.now() ? 'The 30-day experiment expired. Renew to resume prompts.'
      : timer.state !== 'ENABLED' ? `Google timer is ${String(timer.state || 'unavailable').toLowerCase()}. Enable or renew to resume prompts.`
        : 'Cloud status refreshed. Planned times cannot move an existing usage window.';
  }
  async pause() {
    if (this.saved.provisioned) {
      // Write the kill switch first. A stopped timer alone cannot cancel an already queued execution.
      await this.config(false);
      await this.save({ enabled: false });
      if (this.saved.deployed) {
        try { await this.gcloud(['scheduler', 'jobs', 'pause', ID, `--location=${REGION}`, `--project=${this.saved.project}`, '--quiet']); }
        catch { throw Error('Cloud prompts are disabled, but the Google timer could not be paused. Pause or remove it in the Google console to stop empty executions. An already running prompt may finish.'); }
      }
    }
    await this.save({ enabled: false }); this.status = 'Cloud prompts paused. Stored credentials and resources remain until removed.';
  }
  async remove() {
    if (!this.saved.provisioned) { await this.save({ enabled: false, project: null }); return; }
    try { await this.config(false); } catch (e) { if (e.status !== 404 && !e.notFound) throw e; }
    const p = this.saved.project, bucket = this.saved.bucket;
    const cmd = args => this.gcloud([...args, `--project=${p}`, '--quiet'], { timeoutMs: 180000 });
    // Deletion failures are reported and retain the resource names so cleanup can be retried.
    const failures = [];
    for (const args of [
      ['scheduler', 'jobs', 'delete', ID, `--location=${REGION}`],
      ['run', 'jobs', 'delete', ID, `--region=${REGION}`],
      ['storage', 'rm', '--recursive', `gs://${bucket}`],
      ...(this.saved.buildBucket ? [['storage', 'rm', '--recursive', `gs://${this.saved.buildBucket}`]] : []),
      ['artifacts', 'repositories', 'delete', ID, `--location=${REGION}`],
      ['iam', 'service-accounts', 'delete', this.saved.scheduler], ['iam', 'service-accounts', 'delete', this.saved.runner],
      ...(this.saved.builder ? [['iam', 'service-accounts', 'delete', this.saved.builder]] : []),
    ]) { try { await cmd(args); } catch (e) { if (!e.notFound) failures.push(args[0]); } }
    if (failures.length) { await this.save({ enabled: false }); throw Error(`Prompts disabled. Some resources could not be removed (${failures.join(', ')}). Check the Google console before disconnecting.`); }
    this.states = {}; await this.save({ enabled: false, deployed: false, provisioned: false, auth: {}, providers: {}, states: {}, bucket: null, expiresAt: null });
    this.status = 'Cloud runner, timer, credentials, build bucket and image repository removed. Google audit and build history may remain.';
  }
  async handle(message) {
    if (this.busy) return;
    this.busy = true; this.onChange();
    try {
      switch (message.action) {
        case 'enable':
          if (message.enabled === true) {
            await this.save({ enabled: true });
            if (this.saved.deployed) {
              await this.config(true);
              await this.gcloud(['scheduler', 'jobs', 'resume', ID, `--location=${REGION}`, `--project=${this.saved.project}`, '--quiet']);
              this.status = 'Cloud prompts enabled. Expired experiments must be renewed separately.';
            } else this.status = 'Opted in. Connect Google Cloud and review your calendar before deploying.';
          }
          else await this.pause();
          break;
        case 'connect': await this.connect(); break;
        case 'save':
          { const next = plan(message.schedule), previous = this.schedule;
            if (this.saved.deployed && next.timezone !== previous.timezone) await this.gcloud(['scheduler', 'jobs', 'update', 'http', ID, `--location=${REGION}`, `--project=${this.saved.project}`, `--time-zone=${next.timezone}`, '--quiet']);
            this.schedule = next;
            try { if (this.saved.deployed) await this.config(); }
            catch (e) { this.schedule = previous; throw e; }
            await this.save({ schedule: next });
          }
          this.status = 'Weekly work calendar saved.'; break;
        case 'deploy': await this.deploy(); break;
        case 'authenticate': await this.authenticate(message.agent); break;
        case 'refresh': await this.refresh(); break;
        case 'renew':
          if (!this.saved.deployed) throw Error('Deploy the runner first.');
          await this.save({ expiresAt: Date.now() + 30 * 86400000 }); await this.config(true);
          await this.gcloud(['scheduler', 'jobs', 'resume', ID, `--location=${REGION}`, `--project=${this.saved.project}`, '--quiet']);
          await this.save({ enabled: true }); this.status = 'Cloud prompts enabled for another 30 days.'; break;
        case 'remove': await this.remove(); break;
        case 'console': if (this.saved.project) await this.vscode.env.openExternal(this.vscode.Uri.parse(`https://console.cloud.google.com/run/jobs?project=${this.saved.project}`)); break;
        case 'install': await this.vscode.env.openExternal(this.vscode.Uri.parse('https://cloud.google.com/sdk/docs/install')); break;
        default: throw Error('Unknown cloud warmup action.');
      }
    } catch (error) { this.status = error.message; if (!message.silent) void this.vscode.window.showErrorMessage(`Cloud warmup: ${error.message}`); }
    finally { if (this.connecting) { this.connecting = false; this.token = null; } this.busy = false; this.onChange(); }
  }
}

module.exports = { CloudWarmup, findGcloud, RISK };
