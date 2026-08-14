# Single Terminal Architecture — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consolidate 3 separate terminal windows into 1 by making Express the supervisor that spawns Python/Gradio as a child process and serves the pre-built Vite frontend as static files.

**Architecture:** Express server becomes the single entry point. On startup it spawns the Python Gradio pipeline via `child_process.spawn()`, monitors its health via stdout parsing + HTTP polling, auto-restarts on crash with exponential backoff, and serves the Vite production build as static files. A new `/api/pipeline/status` endpoint exposes pipeline state to the frontend.

**Tech Stack:** Node.js (spawn), Express (static serving), Vite (build), Python/Gradio (subprocess)

---

## File Structure

| Action | File | Responsibility |
|--------|------|---------------|
| Create | `app/server/src/services/pipeline-manager.ts` | Spawn, monitor, restart, shutdown Python process |
| Modify | `app/server/src/index.ts` | Integrate pipeline manager + static file serving |
| Modify | `app/server/src/config/index.ts` | Add pipeline config (paths, timeouts, restart limits) |
| Create | `app/server/src/routes/pipeline.ts` | `/api/pipeline/status` endpoint |
| Modify | `app/vite.config.ts` | Ensure build output goes to `dist/` (already default) |
| Create | `run-prod.bat` | Single-terminal production launcher |
| Rename | `run.bat` → `run-dev.bat` | Keep 3-process dev mode |

---

### Task 1: Pipeline Manager — Core Process Spawning

**Files:**
- Create: `app/server/src/services/pipeline-manager.ts`
- Modify: `app/server/src/config/index.ts`

This is the core — a class that spawns Python, parses stdout for readiness, monitors health, handles crashes.

- [ ] **Step 1: Add pipeline config to config/index.ts**

Add to the existing config object:

```typescript
// Pipeline process management
pipeline: {
  pythonPath: process.env.PYTHON_PATH || path.join(__dirname, '../../../../python/python.exe'),
  aceStepDir: process.env.ACESTEP_PATH || path.join(__dirname, '../../../../ACE-Step-1.5'),
  defaultModel: process.env.DEFAULT_MODEL || 'acestep-v15-xl-turbo',
  port: parseInt(process.env.ACESTEP_PORT || '8001', 10),
  healthCheckInterval: 10_000,  // 10 seconds
  startupTimeout: 300_000,      // 5 minutes (model loading is slow)
  maxRestarts: 10,
  backoffBase: 500,             // ms, doubles each restart
  backoffMax: 15_000,           // 15 seconds max
},
```

- [ ] **Step 2: Create pipeline-manager.ts with PipelineManager class**

```typescript
// app/server/src/services/pipeline-manager.ts
import { spawn, ChildProcess, execSync } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';
import { config } from '../config/index.js';

export type PipelineState =
  | 'stopped'
  | 'starting'
  | 'loading_model'
  | 'ready'
  | 'error'
  | 'restarting';

interface PipelineStatus {
  state: PipelineState;
  message: string;
  pid: number | null;
  restartCount: number;
  uptime: number | null;      // ms since last successful start
  lastError: string | null;
}

class PipelineManager {
  private process: ChildProcess | null = null;
  private state: PipelineState = 'stopped';
  private message = '';
  private lastError: string | null = null;
  private restartCount = 0;
  private startedAt: number | null = null;
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  private isShuttingDown = false;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((err: Error) => void) | null = null;

  getStatus(): PipelineStatus {
    return {
      state: this.state,
      message: this.message,
      pid: this.process?.pid ?? null,
      restartCount: this.restartCount,
      uptime: this.startedAt ? Date.now() - this.startedAt : null,
      lastError: this.lastError,
    };
  }

  /** Spawn Python pipeline and wait for readiness. */
  async start(): Promise<void> {
    if (this.state === 'ready' || this.state === 'starting') return;

    const { pythonPath, aceStepDir, defaultModel, port, startupTimeout } = config.pipeline;

    // Validate paths
    if (!existsSync(pythonPath)) {
      throw new Error(`Python not found: ${pythonPath}`);
    }
    if (!existsSync(aceStepDir)) {
      throw new Error(`ACE-Step directory not found: ${aceStepDir}`);
    }

    this.state = 'starting';
    this.message = 'Spawning Python pipeline...';
    this.lastError = null;

    const args = [
      '-u',  // unbuffered stdout
      '-m', 'acestep.acestep_v15_pipeline',
      '--config_path', defaultModel,
      '--port', String(port),
      '--init_service', 'true',
      '--init_llm', 'true',
    ];

    console.log(`[Pipeline] Starting: ${pythonPath} ${args.join(' ')}`);
    console.log(`[Pipeline] CWD: ${aceStepDir}`);

    this.process = spawn(pythonPath, args, {
      cwd: aceStepDir,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PYTHONUNBUFFERED: '1',
        PYTHONIOENCODING: 'utf-8',
      },
    });

    // Pipe stdout with prefix
    this.process.stdout!.on('data', (data: Buffer) => {
      const text = data.toString();
      process.stdout.write(`[Gradio] ${text}`);
      this.parseStdout(text);
    });

    // Pipe stderr with prefix
    this.process.stderr!.on('data', (data: Buffer) => {
      const text = data.toString();
      process.stderr.write(`[Gradio] ${text}`);
      this.parseStderr(text);
    });

    // Handle process exit
    this.process.on('exit', (code, signal) => {
      console.log(`[Pipeline] Process exited: code=${code} signal=${signal}`);
      this.process = null;
      this.stopHealthCheck();

      if (this.readyReject) {
        this.readyReject(new Error(`Pipeline exited during startup (code=${code})`));
        this.readyResolve = null;
        this.readyReject = null;
      }

      if (!this.isShuttingDown) {
        this.state = 'error';
        this.lastError = `Process exited with code ${code}`;
        this.message = `Crashed (code ${code}). Restarting...`;
        this.scheduleRestart();
      }
    });

    this.process.on('error', (err) => {
      console.error(`[Pipeline] Spawn error:`, err);
      this.state = 'error';
      this.lastError = err.message;
      this.message = `Spawn failed: ${err.message}`;
    });

    // Wait for readiness with timeout
    return new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;

      setTimeout(() => {
        if (this.state !== 'ready') {
          this.readyReject = null;
          this.readyResolve = null;
          // Don't reject — let it keep loading, just resolve so Express can start
          console.warn(`[Pipeline] Startup timeout (${startupTimeout}ms) — pipeline still loading, Express will start anyway`);
          resolve();
        }
      }, startupTimeout);
    });
  }

  /** Parse stdout lines for state changes */
  private parseStdout(text: string) {
    // GPU detection
    if (text.includes('GPU Memory:') || text.includes('GPU Configuration')) {
      this.message = 'GPU detected, configuring...';
    }
    // Model loading
    if (text.includes('Loading checkpoint') || text.includes('Initializing DiT')) {
      this.state = 'loading_model';
      this.message = 'Loading AI model...';
    }
    if (text.includes('Loading') && text.includes('shards')) {
      const match = text.match(/(\d+)%/);
      if (match) {
        this.message = `Loading model: ${match[1]}%`;
      }
    }
    // LM init
    if (text.includes('Initializing 5Hz LM') || text.includes('loading 5Hz LM tokenizer')) {
      this.message = 'Loading language model...';
    }
    // Ready signal
    if (text.includes('Running on local URL') || text.includes('Running on')) {
      this.onReady();
    }
  }

  /** Parse stderr for errors */
  private parseStderr(text: string) {
    if (text.includes('CUDA out of memory') || text.includes('OutOfMemoryError')) {
      this.lastError = 'CUDA out of memory';
      this.message = 'GPU memory exhausted';
    }
    if (text.includes('Address already in use')) {
      this.lastError = `Port ${config.pipeline.port} already in use`;
      this.message = this.lastError;
    }
  }

  /** Called when pipeline signals readiness */
  private onReady() {
    this.state = 'ready';
    this.message = 'Pipeline running';
    this.startedAt = Date.now();
    this.restartCount = 0; // Reset on successful start
    console.log('[Pipeline] Ready!');

    this.startHealthCheck();

    if (this.readyResolve) {
      this.readyResolve();
      this.readyResolve = null;
      this.readyReject = null;
    }
  }

  /** Periodic health check via HTTP */
  private startHealthCheck() {
    this.stopHealthCheck();
    this.healthCheckTimer = setInterval(async () => {
      if (this.state !== 'ready') return;
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);
        const res = await fetch(
          `http://localhost:${config.pipeline.port}/gradio_api/info`,
          { signal: controller.signal }
        );
        clearTimeout(timer);
        if (!res.ok && res.status >= 500) {
          console.warn(`[Pipeline] Health check failed: HTTP ${res.status}`);
          this.handleUnhealthy();
        }
      } catch {
        console.warn('[Pipeline] Health check failed: no response');
        this.handleUnhealthy();
      }
    }, config.pipeline.healthCheckInterval);
  }

  private stopHealthCheck() {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  /** Pipeline became unresponsive (zombie state) */
  private handleUnhealthy() {
    if (this.state !== 'ready') return;
    this.state = 'error';
    this.lastError = 'Pipeline unresponsive (zombie)';
    this.message = 'Pipeline stopped responding. Killing and restarting...';
    console.error('[Pipeline] Zombie detected, killing process...');
    this.killProcess();
    this.scheduleRestart();
  }

  /** Schedule restart with exponential backoff */
  private scheduleRestart() {
    const { maxRestarts, backoffBase, backoffMax } = config.pipeline;

    if (this.restartCount >= maxRestarts) {
      this.state = 'error';
      this.message = `Max restarts (${maxRestarts}) exceeded. Manual intervention required.`;
      console.error(`[Pipeline] ${this.message}`);
      return;
    }

    const delay = Math.min(backoffBase * Math.pow(2, this.restartCount), backoffMax);
    this.restartCount++;
    this.state = 'restarting';
    this.message = `Restarting in ${Math.round(delay / 1000)}s (attempt ${this.restartCount}/${maxRestarts})`;
    console.log(`[Pipeline] ${this.message}`);

    setTimeout(() => {
      if (!this.isShuttingDown) {
        this.start().catch(err => {
          console.error('[Pipeline] Restart failed:', err);
        });
      }
    }, delay);
  }

  /** Kill the Python process tree on Windows */
  private killProcess() {
    if (!this.process?.pid) return;
    try {
      if (process.platform === 'win32') {
        execSync(`taskkill /pid ${this.process.pid} /T /F`, { stdio: 'ignore' });
      } else {
        this.process.kill('SIGTERM');
        setTimeout(() => {
          if (this.process) this.process.kill('SIGKILL');
        }, 5000);
      }
    } catch {
      // Process may already be dead
    }
    this.process = null;
  }

  /** Graceful shutdown — kill Python, stop health checks */
  async shutdown(): Promise<void> {
    this.isShuttingDown = true;
    this.stopHealthCheck();
    console.log('[Pipeline] Shutting down...');
    this.killProcess();
    this.state = 'stopped';
    this.message = 'Stopped';
  }
}

// Singleton
export const pipelineManager = new PipelineManager();
```

- [ ] **Step 3: Commit**

```bash
git add app/server/src/services/pipeline-manager.ts app/server/src/config/index.ts
git commit -m "feat: add PipelineManager for Python subprocess control"
```

---

### Task 2: Pipeline Status API Endpoint

**Files:**
- Create: `app/server/src/routes/pipeline.ts`

- [ ] **Step 1: Create pipeline route**

```typescript
// app/server/src/routes/pipeline.ts
import { Router } from 'express';
import { pipelineManager } from '../services/pipeline-manager.js';

const router = Router();

// GET /api/pipeline/status — returns current pipeline state
router.get('/status', (_req, res) => {
  res.json(pipelineManager.getStatus());
});

export default router;
```

- [ ] **Step 2: Commit**

```bash
git add app/server/src/routes/pipeline.ts
git commit -m "feat: add /api/pipeline/status endpoint"
```

---

### Task 3: Integrate Pipeline Manager into Express Server

**Files:**
- Modify: `app/server/src/index.ts`

Changes:
1. Import and start `pipelineManager` before `app.listen()`
2. Register pipeline routes
3. Serve Vite build as static files (production mode)
4. Setup shutdown handlers for graceful cleanup
5. SPA fallback for client-side routing

- [ ] **Step 1: Add imports at top of index.ts**

After existing imports, add:

```typescript
import pipelineRoutes from './routes/pipeline.js';
import { pipelineManager } from './services/pipeline-manager.js';
```

- [ ] **Step 2: Register pipeline routes**

After `app.use('/api/settings', settingsRoutes);` add:

```typescript
app.use('/api/pipeline', pipelineRoutes);
```

- [ ] **Step 3: Add static file serving for production build**

After all API routes but before the error handler, add:

```typescript
// In production, serve Vite build output
const distPath = path.join(__dirname, '../../dist');
if (existsSync(distPath)) {
  console.log(`[Server] Serving frontend from ${distPath}`);
  // Hashed assets — cache aggressively
  app.use('/assets', express.static(path.join(distPath, 'assets'), {
    maxAge: '1y',
    immutable: true,
  }));
  // Other static files (index.html, favicon, etc.)
  app.use(express.static(distPath));
  // SPA fallback — any unmatched GET returns index.html
  app.get('*', (_req, res) => {
    res.sendFile(path.resolve(distPath, 'index.html'));
  });
} else {
  console.log('[Server] No dist/ found — frontend served by Vite dev server');
}
```

Add `import { existsSync } from 'fs';` at the top if not already imported.

- [ ] **Step 4: Start pipeline manager and setup shutdown**

Replace the existing `app.listen(...)` block with:

```typescript
// Start pipeline if managed mode (MANAGE_PIPELINE env or no external Gradio detected)
const managePipeline = process.env.MANAGE_PIPELINE !== 'false';

async function startServer() {
  if (managePipeline) {
    console.log('[Server] Starting pipeline manager...');
    // Don't await — let Express start while pipeline loads models
    pipelineManager.start().catch(err => {
      console.error('[Server] Pipeline start error:', err.message);
    });
  }

  app.listen(config.port, '0.0.0.0', () => {
    console.log(`ACE-Step UI Server running on http://localhost:${config.port}`);
    console.log(`Environment: ${config.nodeEnv}`);
    if (managePipeline) {
      console.log(`Pipeline: managed (port ${config.pipeline.port})`);
    } else {
      console.log(`ACE-Step API: ${config.acestep.apiUrl} (external)`);
    }

    // Show LAN access info
    import('os').then(os => {
      const nets = os.networkInterfaces();
      for (const name of Object.keys(nets)) {
        for (const net of nets[name] || []) {
          if (net.family === 'IPv4' && !net.internal) {
            console.log(`LAN access: http://${net.address}:${config.port}`);
          }
        }
      }
    });
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\nShutting down...');
    if (managePipeline) {
      await pipelineManager.shutdown();
    }
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  // Windows: handle console close
  process.on('exit', () => {
    if (managePipeline && pipelineManager.getStatus().state !== 'stopped') {
      pipelineManager.shutdown();
    }
  });
}

startServer();
```

- [ ] **Step 5: Commit**

```bash
git add app/server/src/index.ts
git commit -m "feat: integrate pipeline manager and static serving into Express"
```

---

### Task 4: Production Launcher Scripts

**Files:**
- Rename: `run.bat` → `run-dev.bat`
- Create: `run.bat` (new single-terminal launcher)

- [ ] **Step 1: Rename current run.bat to run-dev.bat**

```bash
cd D:/Projects/TEMP/ACE-Step-Studio
git mv run.bat run-dev.bat
```

- [ ] **Step 2: Create new run.bat (single terminal)**

```batch
@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

echo ========================================
echo   ACE-Step Studio
echo ========================================

set "SCRIPT_DIR=%~dp0"
cd /d "%SCRIPT_DIR%"

REM === Checks ===
if not exist "python\python.exe" (
    echo ERROR: Python not found! Run install.bat first
    pause
    exit /b 1
)
if not exist "node\node.exe" (
    echo ERROR: Node.js not found! Run install.bat first
    pause
    exit /b 1
)
if not exist "ACE-Step-1.5" (
    echo ERROR: ACE-Step-1.5 not found!
    pause
    exit /b 1
)

REM === Environment isolation ===
set "TEMP=%SCRIPT_DIR%temp"
set "TMP=%SCRIPT_DIR%temp"
if not exist "%TEMP%" mkdir "%TEMP%"

set "HF_HOME=%SCRIPT_DIR%models"
set "HUGGINGFACE_HUB_CACHE=%SCRIPT_DIR%models"
set "TRANSFORMERS_CACHE=%SCRIPT_DIR%models"
set "HF_HUB_ENABLE_HF_TRANSFER=1"
if not exist "%HF_HOME%" mkdir "%HF_HOME%"

set "TORCH_HOME=%SCRIPT_DIR%models\torch"
if not exist "%TORCH_HOME%" mkdir "%TORCH_HOME%"

set "XDG_CACHE_HOME=%SCRIPT_DIR%cache"
if not exist "%XDG_CACHE_HOME%" mkdir "%XDG_CACHE_HOME%"

if exist "%SCRIPT_DIR%ffmpeg\ffmpeg.exe" (
    set "PATH=%SCRIPT_DIR%ffmpeg;%PATH%"
)

set PYTHONIOENCODING=utf-8
set PYTHONUNBUFFERED=1

REM === Node.js in PATH ===
set "PATH=%SCRIPT_DIR%node;%PATH%"

REM === Pipeline config ===
set "PYTHON_PATH=%SCRIPT_DIR%python\python.exe"
set "ACESTEP_PATH=%SCRIPT_DIR%ACE-Step-1.5"
set "DEFAULT_MODEL=acestep-v15-xl-turbo"
set "MANAGE_PIPELINE=true"

if exist "cuda_version.txt" (
    set /p CUDA_VERSION=<cuda_version.txt
    echo GPU: !CUDA_VERSION!
)

REM === Install npm deps if needed ===
if not exist "app\node_modules" (
    echo Installing npm dependencies...
    for /f "tokens=*" %%v in ('"%SCRIPT_DIR%node\node.exe" -v') do set "NODE_VER=%%v"
    set "NODE_VER=!NODE_VER:~1!"
    set "npm_config_target=!NODE_VER!"
    set "npm_config_target_arch=x64"
    set "npm_config_runtime=node"
    cd app
    "%SCRIPT_DIR%node\npm.cmd" install
    cd "%SCRIPT_DIR%"
)

REM === Build frontend if dist/ missing ===
if not exist "app\dist" (
    echo Building frontend...
    cd app
    "%SCRIPT_DIR%node\npx.cmd" vite build
    cd "%SCRIPT_DIR%"
)

REM === Create output dirs ===
if not exist "app\data" mkdir "app\data"
if not exist "app\server\public\audio" mkdir "app\server\public\audio"

echo.
echo ========================================
echo   Single terminal mode
echo   Express + Pipeline + Frontend
echo   UI: http://localhost:3001
echo   Close this window to stop all
echo ========================================
echo.

REM === Start Express (manages everything) ===
"%SCRIPT_DIR%node\node.exe" "%SCRIPT_DIR%app\server\node_modules\tsx\dist\cli.mjs" "%SCRIPT_DIR%app\server\src\index.ts"

if errorlevel 1 (
    echo.
    echo ERROR starting server!
    pause
    exit /b 1
)
pause
```

Note: in production mode the UI is on port 3001 (Express), not 3000 (Vite dev).

- [ ] **Step 3: Commit**

```bash
git add run.bat run-dev.bat
git commit -m "feat: single-terminal launcher (run.bat), dev mode moved to run-dev.bat"
```

---

### Task 5: Vite Build Setup

**Files:**
- Modify: `app/vite.config.ts` — ensure API proxy base works in both dev and prod

No changes needed to vite.config.ts itself — the proxy config is only used in dev mode. In production, Express serves both API and static files on the same port (3001), so no proxy is needed.

- [ ] **Step 1: Build frontend and verify**

```bash
cd D:/Projects/TEMP/ACE-Step-Studio/app
../node/npx.cmd vite build
```

Expected: `dist/` directory created with `index.html` and `assets/`.

- [ ] **Step 2: Verify the frontend makes API calls to relative URLs (not hardcoded localhost:3000)**

Search for hardcoded API URLs in frontend code:

```bash
grep -r "localhost:3001\|localhost:3000\|127.0.0.1:3001" app/src/ --include="*.ts" --include="*.tsx"
```

If any hardcoded URLs found → they need to be changed to relative paths (`/api/...`). The Vite proxy and Express static serving both handle relative paths correctly.

- [ ] **Step 3: Commit if any changes were needed**

---

### Task 6: Manual Testing

- [ ] **Step 1: Stop all existing ACE-Step processes**

Kill any running Python/Node processes from previous sessions.

- [ ] **Step 2: Build frontend**

```bash
cd D:/Projects/TEMP/ACE-Step-Studio/app
../node/npx.cmd vite build
```

- [ ] **Step 3: Run single-terminal mode**

Double-click `run.bat` or from terminal:

```bash
cd D:/Projects/TEMP/ACE-Step-Studio
run.bat
```

- [ ] **Step 4: Verify checklist**

1. Single terminal window shows both Express and Gradio logs
2. Gradio logs appear with `[Gradio]` prefix
3. Express logs show pipeline state transitions: starting → loading_model → ready
4. `http://localhost:3001` serves the UI
5. `http://localhost:3001/api/pipeline/status` returns JSON with `state: "ready"` after model loads
6. Music generation works through the UI
7. Closing the terminal window kills both Express and Python (check Task Manager)

- [ ] **Step 5: Test crash recovery**

1. While running, kill the Python process from Task Manager
2. Observe Express logs — should detect exit, show restart message
3. Python should restart automatically
4. `/api/pipeline/status` should show `state: "restarting"` then `state: "ready"`

---

## Notes

- **Dev mode:** Use `run-dev.bat` — keeps 3 separate processes with Vite HMR on port 3000
- **Prod mode:** Use `run.bat` — single terminal, UI on port 3001, no HMR
- `MANAGE_PIPELINE=false` env var disables auto-spawning (for when Gradio runs externally)
- Node v24 has a known bug with child processes on Windows dying after ~25 min. Monitor and downgrade to v22 if needed.
