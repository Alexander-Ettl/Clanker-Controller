'use strict';

// Optional on-device speech-to-text manager powered by whisper.cpp (`whisper-cli`).
// Nothing is bundled with Clanker Controller: runtime binaries and GGML model weights are downloaded
// on demand into a non-synced local cache folder (outside the repo and outside Nextcloud/OneDrive).
//
// Supports both English-only (.en) and Multilingual quantized GGML models from Hugging Face
// (`ggerganov/whisper.cpp`), plus Whisper's `--prompt` flag so the personal voice dictionary still
// biases local decoding offline.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pipeline } = require('node:stream/promises');

const HF_MODEL_BASE = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';
const WHISPER_RELEASE_API = 'https://api.github.com/repos/ggml-org/whisper.cpp/releases/latest';
const WHISPER_REPO_URL = 'https://github.com/ggml-org/whisper.cpp.git';
const DEFAULT_LOCAL_MODEL = 'small.en';
const TRANSCRIBE_TIMEOUT_MS = 5 * 60 * 1000;

const LOCAL_STT_MODELS = Object.freeze([
  {
    id: 'base.en',
    label: 'Base · Fast',
    group: 'english',
    language: 'en',
    file: 'ggml-base.en-q5_1.bin',
    sizeMb: 60,
    ramGb: 0.3,
    description: 'Quick English transcription with low memory use.',
  },
  {
    id: 'small.en',
    label: 'Small · Balanced',
    group: 'english',
    language: 'en',
    file: 'ggml-small.en-q5_1.bin',
    sizeMb: 190,
    ramGb: 0.5,
    description: 'Recommended English default: accurate and light on RAM.',
  },
  {
    id: 'medium.en',
    label: 'Medium · Accurate',
    group: 'english',
    language: 'en',
    file: 'ggml-medium.en-q5_0.bin',
    sizeMb: 539,
    ramGb: 1.5,
    description: 'Higher English accuracy; needs ~1.5 GB free RAM.',
  },
  {
    id: 'small',
    label: 'Small · Fast',
    group: 'multilingual',
    language: 'auto',
    file: 'ggml-small-q5_1.bin',
    sizeMb: 190,
    ramGb: 0.5,
    description: 'Multilingual (auto-detects 90+ languages) with modest RAM use.',
  },
  {
    id: 'large-v3-turbo',
    label: 'Large v3 Turbo · Best',
    group: 'multilingual',
    language: 'auto',
    file: 'ggml-large-v3-turbo-q5_0.bin',
    sizeMb: 574,
    ramGb: 1.6,
    description: 'Best local multilingual quality; needs ~1.6 GB free RAM.',
  },
]);

function modelById(id) {
  return LOCAL_STT_MODELS.find((entry) => entry.id === id) || LOCAL_STT_MODELS.find((entry) => entry.id === DEFAULT_LOCAL_MODEL);
}

function modelDownloadUrl(model) {
  return `${HF_MODEL_BASE}/${model.file}`;
}

/**
 * Local non-synced storage folder for whisper-cli and GGML model weights.
 * Never places binaries or models inside the repository or synced Nextcloud/OneDrive folders.
 */
function resolveLocalSttDir({ env = process.env, platform = process.platform, homedir = os.homedir() } = {}) {
  if (env.CLANKER_LOCAL_STT_DIR) return path.resolve(env.CLANKER_LOCAL_STT_DIR);
  if (platform === 'win32') {
    const base = env.LOCALAPPDATA || path.join(homedir, 'AppData', 'Local');
    return path.join(base, 'clanker-controller', 'local-stt');
  }
  const base = env.XDG_CACHE_HOME || path.join(homedir, '.cache');
  return path.join(base, 'clanker-controller', 'local-stt');
}

function executableNames(platform = process.platform) {
  return platform === 'win32'
    ? ['whisper-cli.exe', 'whisper-cpp.exe']
    : ['whisper-cli', 'whisper-cpp'];
}

function findInPath(names, { env = process.env, platform = process.platform, existsSync = fs.existsSync } = {}) {
  const pathEnv = env.PATH || env.Path || '';
  const sep = platform === 'win32' ? ';' : ':';
  for (const dir of pathEnv.split(sep).filter(Boolean)) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      try {
        if (existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
      } catch { /* ignore unreadable PATH entry */ }
    }
  }
  return '';
}

function walkFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else out.push(full);
  }
  return out;
}

function runProcess(command, args, { cwd, env, timeoutMs = 10 * 60 * 1000, spawnImpl = spawn, onLine } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (error) {
      reject(error);
      return;
    }
    let stdout = '';
    let stderr = '';
    const feed = (chunk, isErr) => {
      const text = chunk.toString('utf8');
      if (isErr) stderr = (stderr + text).slice(-8000);
      else stdout = (stdout + text).slice(-64000);
      if (onLine) {
        const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        if (lines.length) onLine(lines[lines.length - 1]);
      }
    };
    child.stdout?.on('data', (chunk) => feed(chunk, false));
    child.stderr?.on('data', (chunk) => feed(chunk, true));
    let timedOut = false;
    const timer = timeoutMs ? setTimeout(() => {
      timedOut = true;
      try { child.kill(); } catch { /* ignore */ }
    }, timeoutMs) : null;
    child.once('error', (error) => {
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      if (timer) clearTimeout(timer);
      if (timedOut) reject(new Error(`${command} timed out after ${Math.round(timeoutMs / 1000)}s.`));
      else if (code !== 0) reject(new Error(`${command} exited with code ${code}${stderr.trim() ? `: ${stderr.trim().split(/\r?\n/).slice(-2).join(' ')}` : ''}`));
      else resolve({ stdout, stderr });
    });
  });
}

function cleanWhisperTranscript(raw) {
  return String(raw || '')
    .replace(/\r/g, '')
    // Strip common Whisper non-speech bracket markers when emitted alone or inline.
    .replace(/\[(?:BLANK_AUDIO|SILENCE|MUSIC|APPLAUSE|NOISE)\]/gi, ' ')
    .replace(/\((?:silence|blank audio|inaudible)\)/gi, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function pickWindowsReleaseAsset(assets, arch = process.arch) {
  const list = Array.isArray(assets) ? assets : [];
  const names = arch === 'arm64'
    ? [/whisper-bin-arm64\.zip$/i, /whisper-bin-x64\.zip$/i]
    : [/whisper-bin-x64\.zip$/i, /whisper-blas-bin-x64\.zip$/i, /whisper-bin-Win32\.zip$/i];
  for (const pattern of names) {
    const found = list.find((asset) => pattern.test(asset?.name || '') && asset?.browser_download_url);
    if (found) return found;
  }
  return null;
}

class LocalSttManager {
  constructor({
    rootDir,
    env = process.env,
    platform = process.platform,
    arch = process.arch,
    fetchImpl = globalThis.fetch,
    spawnImpl = spawn,
    onChange,
  } = {}) {
    this.env = env;
    this.platform = platform;
    this.arch = arch;
    this.rootDir = rootDir ? path.resolve(rootDir) : resolveLocalSttDir({ env, platform });
    this.binDir = path.join(this.rootDir, 'bin');
    this.modelsDir = path.join(this.rootDir, 'models');
    this.fetchImpl = fetchImpl;
    this.spawnImpl = spawnImpl;
    this.onChange = onChange;
    this.busy = false;
    this.progress = null;
    this.lastError = '';
    this.activeInstall = null;
  }

  modelPath(modelId) {
    const model = modelById(modelId);
    return path.join(this.modelsDir, model.file);
  }

  findRuntime() {
    if (this.env.CLANKER_WHISPER_CLI && fs.existsSync(this.env.CLANKER_WHISPER_CLI)) {
      return { path: this.env.CLANKER_WHISPER_CLI, source: 'env' };
    }
    const names = executableNames(this.platform);
    for (const name of names) {
      const managed = path.join(this.binDir, name);
      if (fs.existsSync(managed)) return { path: managed, source: 'managed' };
    }
    const fromPath = findInPath(names, { env: this.env, platform: this.platform });
    if (fromPath) return { path: fromPath, source: 'path' };
    return null;
  }

  isModelInstalled(modelId) {
    const file = this.modelPath(modelId);
    try {
      return fs.statSync(file).size > 0;
    } catch {
      return false;
    }
  }

  snapshot(selectedModelId = DEFAULT_LOCAL_MODEL) {
    const runtime = this.findRuntime();
    const selected = modelById(selectedModelId).id;
    const models = LOCAL_STT_MODELS.map((entry) => {
      const file = path.join(this.modelsDir, entry.file);
      let bytes = 0;
      try { bytes = fs.statSync(file).size; } catch { bytes = 0; }
      return {
        ...entry,
        installed: bytes > 0,
        bytes,
      };
    });
    const selectedInfo = models.find((entry) => entry.id === selected);
    return {
      dir: this.rootDir,
      runtime: runtime ? { installed: true, path: runtime.path, source: runtime.source } : { installed: false, path: '', source: '' },
      models,
      selectedModel: selected,
      ready: Boolean(runtime && selectedInfo?.installed),
      busy: this.busy,
      progress: this.progress,
      error: this.lastError,
    };
  }

  emitProgress(progress) {
    this.progress = progress;
    this.onChange?.();
  }

  async downloadFile(url, destPath, { label = 'file', onProgress } = {}) {
    if (typeof this.fetchImpl !== 'function') throw new Error('HTTP download is unavailable in this runtime.');
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    const response = await this.fetchImpl(url, {
      redirect: 'follow',
      headers: { 'User-Agent': 'Clanker-Controller-Local-STT' },
    });
    if (!response.ok) throw new Error(`Could not download ${label} (HTTP ${response.status}).`);
    const total = Number(response.headers?.get?.('content-length')) || 0;
    const tmpPath = `${destPath}.tmp`;
    let downloaded = 0;
    let lastEmit = 0;
    const report = (force = false) => {
      const now = Date.now();
      if (!force && now - lastEmit < 150) return;
      lastEmit = now;
      const percent = total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : null;
      onProgress?.({
        downloadedMb: Number((downloaded / (1024 * 1024)).toFixed(1)),
        totalMb: total > 0 ? Number((total / (1024 * 1024)).toFixed(1)) : null,
        percent,
      });
    };
    try {
      const writer = fs.createWriteStream(tmpPath);
      let writeError = null;
      writer.on('error', (error) => { writeError = error; });
      if (response.body && typeof response.body.getReader === 'function') {
        const reader = response.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (writeError) throw writeError;
          downloaded += value.byteLength;
          if (!writer.write(Buffer.from(value))) {
            await new Promise((resolve, reject) => {
              if (writeError) { reject(writeError); return; }
              const onErr = (err) => { writer.off('drain', onDrain); reject(err); };
              const onDrain = () => { writer.off('error', onErr); resolve(); };
              writer.once('error', onErr);
              writer.once('drain', onDrain);
            });
          }
          report(false);
        }
        await new Promise((resolve, reject) => {
          if (writeError) { reject(writeError); return; }
          writer.once('error', reject);
          writer.end(resolve);
        });
      } else if (response.body && typeof response.body.pipe === 'function') {
        response.body.on('data', (chunk) => { downloaded += chunk.length; report(false); });
        await pipeline(response.body, writer);
      } else {
        writer.destroy();
        const buf = Buffer.from(await response.arrayBuffer());
        downloaded = buf.byteLength;
        fs.writeFileSync(tmpPath, buf);
      }
      if (!fs.existsSync(tmpPath) || fs.statSync(tmpPath).size === 0) {
        throw new Error(`Downloaded ${label} was empty.`);
      }
      fs.renameSync(tmpPath, destPath);
      report(true);
    } catch (error) {
      fs.rmSync(tmpPath, { force: true });
      throw error;
    }
  }

  async installRuntimeWindows() {
    this.emitProgress({ stage: 'runtime', percent: null, message: 'Checking latest whisper.cpp Windows release…' });
    const releaseRes = await this.fetchImpl(WHISPER_RELEASE_API, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Clanker-Controller-Local-STT' },
    });
    if (!releaseRes.ok) throw new Error(`Could not query whisper.cpp releases (HTTP ${releaseRes.status}).`);
    const release = await releaseRes.json();
    const asset = pickWindowsReleaseAsset(release?.assets, this.arch);
    if (!asset) throw new Error('No Windows whisper.cpp binary zip found in the latest release.');

    const zipPath = path.join(this.rootDir, 'whisper-runtime.zip');
    const stageDir = path.join(this.rootDir, 'runtime-stage');
    fs.rmSync(stageDir, { recursive: true, force: true });
    try {
      await this.downloadFile(asset.browser_download_url, zipPath, {
        label: asset.name,
        onProgress: ({ percent, downloadedMb, totalMb }) => {
          const detail = totalMb ? `${downloadedMb} / ${totalMb} MB` : `${downloadedMb} MB`;
          this.emitProgress({ stage: 'runtime', percent, message: `Downloading whisper.cpp runtime (${detail})…` });
        },
      });
      this.emitProgress({ stage: 'runtime', percent: 100, message: 'Extracting whisper-cli…' });
      fs.mkdirSync(stageDir, { recursive: true });
      await runProcess('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${stageDir.replace(/'/g, "''")}' -Force`,
      ], { spawnImpl: this.spawnImpl, env: this.env });
      const files = walkFiles(stageDir);
      const cli = files.find((file) => /^whisper-cli\.exe$/i.test(path.basename(file)));
      if (!cli) throw new Error('Downloaded whisper.cpp archive did not contain whisper-cli.exe.');
      fs.mkdirSync(this.binDir, { recursive: true });
      const cliDir = path.dirname(cli);
      for (const entry of fs.readdirSync(cliDir)) {
        if (/\.(exe|dll)$/i.test(entry)) {
          fs.copyFileSync(path.join(cliDir, entry), path.join(this.binDir, entry));
        }
      }
    } finally {
      fs.rmSync(zipPath, { force: true });
      fs.rmSync(stageDir, { recursive: true, force: true });
    }
  }

  async installRuntimeUnix() {
    const hasTool = (names) => Boolean(findInPath(names, { env: this.env, platform: this.platform }));
    const missing = [];
    if (!hasTool(['git'])) missing.push('git');
    if (!hasTool(['cmake'])) missing.push('cmake');
    if (!hasTool(['c++', 'g++', 'clang++'])) missing.push('a C++ compiler (build-essential)');
    if (missing.length) {
      throw new Error(`Missing build tools to compile whisper-cli: ${missing.join(', ')}. Install them (e.g. sudo apt install git cmake build-essential) or place whisper-cli on PATH, then try again.`);
    }

    const buildRoot = path.join(this.rootDir, 'build');
    const srcDir = path.join(buildRoot, 'src');
    const outDir = path.join(buildRoot, 'out');
    fs.rmSync(buildRoot, { recursive: true, force: true });
    fs.mkdirSync(buildRoot, { recursive: true });

    // Strip broken inherited GIT_CONFIG_COUNT if present so git clone always succeeds.
    const cleanEnv = { ...this.env };
    delete cleanEnv.GIT_CONFIG_COUNT;
    for (const key of Object.keys(cleanEnv)) {
      if (/^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(key)) delete cleanEnv[key];
    }

    try {
      this.emitProgress({ stage: 'runtime', percent: null, message: 'Cloning whisper.cpp source…' });
      await runProcess('git', ['clone', '--depth', '1', WHISPER_REPO_URL, srcDir], {
        env: cleanEnv,
        spawnImpl: this.spawnImpl,
      });
      this.emitProgress({ stage: 'runtime', percent: null, message: 'Configuring whisper.cpp build…' });
      await runProcess('cmake', [
        '-S', srcDir,
        '-B', outDir,
        '-DCMAKE_BUILD_TYPE=Release',
        '-DBUILD_SHARED_LIBS=OFF',
        '-DWHISPER_BUILD_TESTS=OFF',
        '-DWHISPER_BUILD_SERVER=OFF',
      ], { env: cleanEnv, spawnImpl: this.spawnImpl });
      const jobs = String(Math.max(1, Math.min(4, (os.cpus()?.length || 2))));
      this.emitProgress({ stage: 'runtime', percent: null, message: 'Building whisper-cli locally…' });
      await runProcess('cmake', ['--build', outDir, '--config', 'Release', '--target', 'whisper-cli', '-j', jobs], {
        env: cleanEnv,
        spawnImpl: this.spawnImpl,
      });
      const built = walkFiles(outDir).find((file) => path.basename(file) === 'whisper-cli');
      if (!built) throw new Error('whisper-cli finished building but the binary could not be located.');
      fs.mkdirSync(this.binDir, { recursive: true });
      const dest = path.join(this.binDir, 'whisper-cli');
      fs.copyFileSync(built, dest);
      fs.chmodSync(dest, 0o755);
    } finally {
      fs.rmSync(buildRoot, { recursive: true, force: true });
    }
  }

  async install(modelId = DEFAULT_LOCAL_MODEL) {
    if (this.activeInstall) return this.activeInstall;
    const model = modelById(modelId);
    this.busy = true;
    this.lastError = '';
    this.emitProgress({ stage: 'starting', percent: null, message: `Preparing ${model.label}…` });

    const job = (async () => {
      try {
        if (!this.findRuntime()) {
          if (this.platform === 'win32') await this.installRuntimeWindows();
          else await this.installRuntimeUnix();
        }
        const dest = this.modelPath(model.id);
        if (!this.isModelInstalled(model.id)) {
          await this.downloadFile(modelDownloadUrl(model), dest, {
            label: model.file,
            onProgress: ({ percent, downloadedMb, totalMb }) => {
              const detail = totalMb ? `${downloadedMb} / ${totalMb} MB` : `${downloadedMb} MB`;
              this.emitProgress({ stage: 'model', percent, message: `Downloading ${model.label} (${detail})…` });
            },
          });
        }
        this.busy = false;
        this.progress = null;
        this.lastError = '';
        this.onChange?.();
        return { ok: true, model: model.id };
      } catch (error) {
        this.busy = false;
        this.progress = null;
        this.lastError = error?.message || String(error);
        this.onChange?.();
        return { ok: false, error: this.lastError };
      } finally {
        this.activeInstall = null;
      }
    })();

    this.activeInstall = job;
    return job;
  }

  removeModel(modelId) {
    const model = modelById(modelId);
    const file = this.modelPath(model.id);
    fs.rmSync(file, { force: true });
    this.lastError = '';
    this.onChange?.();
    return { ok: true, model: model.id };
  }

  async ensureWavInput(audioPath, ffmpeg = 'ffmpeg') {
    if (/\.wav$/i.test(audioPath)) return { file: audioPath, temp: false };
    const out = path.join(os.tmpdir(), `clanker-local-${process.pid}-${Date.now()}.wav`);
    await runProcess(ffmpeg, ['-y', '-loglevel', 'error', '-i', audioPath, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', out], {
      spawnImpl: this.spawnImpl,
      env: this.env,
      timeoutMs: 60000,
    });
    return { file: out, temp: true };
  }

  async transcribe(audioPath, { modelId = DEFAULT_LOCAL_MODEL, vocabularyPrompt = '', language = '', ffmpeg = 'ffmpeg' } = {}) {
    const runtime = this.findRuntime();
    if (!runtime) {
      throw new Error('Local transcription runtime (whisper-cli) is not installed. Open Chat Settings > Voice and click Install & download.');
    }
    const model = modelById(modelId);
    const modelFile = this.modelPath(model.id);
    if (!this.isModelInstalled(model.id)) {
      throw new Error(`Local model "${model.label}" is not downloaded yet. Open Chat Settings > Voice and click Download model.`);
    }

    const input = await this.ensureWavInput(audioPath, ffmpeg);
    try {
      const lang = language || model.language || 'auto';
      const args = ['-m', modelFile, '-f', input.file, '-l', lang, '-nt', '-np'];
      if (vocabularyPrompt) args.push('--prompt', vocabularyPrompt);
      const { stdout } = await runProcess(runtime.path, args, {
        env: this.env,
        spawnImpl: this.spawnImpl,
        timeoutMs: TRANSCRIBE_TIMEOUT_MS,
      });
      return cleanWhisperTranscript(stdout);
    } finally {
      if (input.temp) fs.rm(input.file, { force: true }, () => {});
    }
  }
}

module.exports = {
  DEFAULT_LOCAL_MODEL,
  HF_MODEL_BASE,
  LOCAL_STT_MODELS,
  LocalSttManager,
  cleanWhisperTranscript,
  modelById,
  modelDownloadUrl,
  pickWindowsReleaseAsset,
  resolveLocalSttDir,
};
