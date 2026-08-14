import { Router, Request, Response } from 'express';
import { authMiddleware, AuthenticatedRequest } from '../middleware/auth.js';
import { resolvePythonPath } from '../services/acestep.js';
import { config } from '../config/index.js';
import path from 'path';
import { fileURLToPath } from 'url';
import { existsSync, statSync, readdirSync } from 'fs';
import { spawn, ChildProcess } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = Router();

// Active conversion process (only one at a time)
let activeConversion: {
  process: ChildProcess;
  events: Array<Record<string, unknown>>;
  done: boolean;
  error: string | null;
  startedAt: number;
} | null = null;

function getAceStepDir(): string {
  const envPath = process.env.ACESTEP_PATH;
  if (envPath) {
    return path.isAbsolute(envPath) ? envPath : path.resolve(process.cwd(), envPath);
  }
  return path.resolve(config.datasets.dir, '..');
}

// GET /api/tools/models — List available models from checkpoints directory
router.get('/models', authMiddleware, async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const aceStepDir = getAceStepDir();
    const checkpointsDir = path.join(aceStepDir, 'checkpoints');

    if (!existsSync(checkpointsDir)) {
      res.json({ models: [], checkpointsDir });
      return;
    }

    const models: Array<{
      name: string;
      path: string;
      sizeMb: number;
      safetensorCount: number;
      isBf16: boolean;
    }> = [];

    // Scan top-level folders
    for (const entry of readdirSync(checkpointsDir)) {
      const entryPath = path.join(checkpointsDir, entry);
      try {
        if (!statSync(entryPath).isDirectory()) continue;
        // Skip non-model dirs
        if (entry.startsWith('acestep-5Hz-lm-') || entry === 'vae' || entry.startsWith('Qwen')) continue;

        const files = readdirSync(entryPath);
        const safetensors = files.filter((f: string) => f.endsWith('.safetensors'));
        if (safetensors.length === 0) continue;

        let totalSize = 0;
        for (const f of safetensors) {
          try { totalSize += statSync(path.join(entryPath, f)).size; } catch {}
        }

        models.push({
          name: entry,
          path: entryPath,
          sizeMb: Math.round(totalSize / 1024 / 1024 * 10) / 10,
          safetensorCount: safetensors.length,
          isBf16: entry.toLowerCase().includes('bf16'),
        });
      } catch {}
    }

    // Scan nested dirs (org/repo style)
    for (const entry of readdirSync(checkpointsDir)) {
      const entryPath = path.join(checkpointsDir, entry);
      try {
        if (!statSync(entryPath).isDirectory()) continue;
        for (const sub of readdirSync(entryPath)) {
          const subPath = path.join(entryPath, sub);
          if (!statSync(subPath).isDirectory()) continue;
          const files = readdirSync(subPath);
          const safetensors = files.filter((f: string) => f.endsWith('.safetensors'));
          if (safetensors.length === 0) continue;

          let totalSize = 0;
          for (const f of safetensors) {
            try { totalSize += statSync(path.join(subPath, f)).size; } catch {}
          }

          models.push({
            name: `${entry}/${sub}`,
            path: subPath,
            sizeMb: Math.round(totalSize / 1024 / 1024 * 10) / 10,
            safetensorCount: safetensors.length,
            isBf16: sub.toLowerCase().includes('bf16'),
          });
        }
      } catch {}
    }

    // Sort: non-bf16 first (candidates for conversion), then by size desc
    models.sort((a, b) => {
      if (a.isBf16 !== b.isBf16) return a.isBf16 ? 1 : -1;
      return b.sizeMb - a.sizeMb;
    });

    res.json({ models, checkpointsDir });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to list models' });
  }
});

// POST /api/tools/bf16/start — Start BF16 conversion
router.post('/bf16/start', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (activeConversion && !activeConversion.done) {
      res.status(409).json({ error: 'A conversion is already in progress' });
      return;
    }

    const { sourcePath, outputDir } = req.body;
    if (!sourcePath) {
      res.status(400).json({ error: 'sourcePath is required' });
      return;
    }
    if (!outputDir) {
      res.status(400).json({ error: 'outputDir is required' });
      return;
    }

    // Validate source exists
    if (!existsSync(sourcePath)) {
      res.status(400).json({ error: `Source path not found: ${sourcePath}` });
      return;
    }

    const aceStepDir = getAceStepDir();
    const scriptPath = path.resolve(__dirname, '../../scripts/bf16_convert.py');
    const pythonPath = resolvePythonPath(aceStepDir);

    const child = spawn(pythonPath, [
      scriptPath,
      '--source', sourcePath,
      '--output', outputDir,
    ], {
      cwd: aceStepDir,
      env: { ...process.env },
    });

    activeConversion = {
      process: child,
      events: [],
      done: false,
      error: null,
      startedAt: Date.now(),
    };

    let buffer = '';

    child.stdout.on('data', (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (activeConversion) {
            activeConversion.events.push(event);
            // Cap event buffer to prevent memory leak on large models
            if (activeConversion.events.length > 100) {
              activeConversion.events = activeConversion.events.slice(-50);
            }
          }
        } catch {
          // Non-JSON output, ignore
        }
      }
    });

    child.stderr.on('data', (data: Buffer) => {
      console.error('[BF16] stderr:', data.toString());
    });

    child.on('close', (code: number | null) => {
      if (activeConversion) {
        activeConversion.done = true;
        if (code !== 0) {
          activeConversion.error = `Process exited with code ${code}`;
        }
      }
    });

    child.on('error', (err: Error) => {
      if (activeConversion) {
        activeConversion.done = true;
        activeConversion.error = err.message;
      }
    });

    res.json({ status: 'started' });
  } catch (error) {
    console.error('[BF16] Start error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to start conversion' });
  }
});

// GET /api/tools/bf16/status — Poll conversion progress
router.get('/bf16/status', authMiddleware, async (_req: AuthenticatedRequest, res: Response) => {
  if (!activeConversion) {
    res.json({ status: 'idle' });
    return;
  }

  const lastEvents = activeConversion.events.slice(-20);
  const lastEvent = activeConversion.events[activeConversion.events.length - 1];

  res.json({
    status: activeConversion.done
      ? (activeConversion.error ? 'error' : 'done')
      : 'running',
    error: activeConversion.error,
    events: lastEvents,
    lastEvent,
    totalEvents: activeConversion.events.length,
    elapsed: Date.now() - activeConversion.startedAt,
  });
});

// POST /api/tools/bf16/stop — Stop active conversion
router.post('/bf16/stop', authMiddleware, async (_req: AuthenticatedRequest, res: Response) => {
  if (!activeConversion || activeConversion.done) {
    res.json({ status: 'no active conversion' });
    return;
  }

  activeConversion.process.kill('SIGTERM');
  activeConversion.done = true;
  activeConversion.error = 'Cancelled by user';
  res.json({ status: 'stopped' });
});

// POST /api/tools/bf16/analyze — Analyze source without converting
router.post('/bf16/analyze', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { sourcePath } = req.body;
    if (!sourcePath || !existsSync(sourcePath)) {
      res.status(400).json({ error: 'Valid sourcePath is required' });
      return;
    }

    const stat = statSync(sourcePath);
    if (stat.isFile()) {
      if (!sourcePath.endsWith('.safetensors')) {
        res.status(400).json({ error: 'Single file must be .safetensors' });
        return;
      }
      res.json({
        sourceType: 'file',
        displayName: path.basename(sourcePath, '.safetensors'),
        safetensorCount: 1,
        supportCount: 0,
        totalSizeMb: Math.round(stat.size / 1024 / 1024 * 10) / 10,
      });
      return;
    }

    // Folder
    const files = readdirSync(sourcePath, { recursive: true, withFileTypes: false }) as string[];
    let safetensorCount = 0;
    let supportCount = 0;
    let totalSize = 0;
    let hasIndex = false;

    for (const file of files) {
      const fullPath = path.join(sourcePath, file as string);
      try {
        const fstat = statSync(fullPath);
        if (!fstat.isFile()) continue;
        if ((file as string).endsWith('.safetensors')) {
          safetensorCount++;
          totalSize += fstat.size;
        } else {
          supportCount++;
          if ((file as string).endsWith('model.safetensors.index.json')) hasIndex = true;
        }
      } catch { /* skip */ }
    }

    res.json({
      sourceType: 'folder',
      displayName: path.basename(sourcePath),
      safetensorCount,
      supportCount,
      hasIndex,
      totalSizeMb: Math.round(totalSize / 1024 / 1024 * 10) / 10,
    });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Analysis failed' });
  }
});

// POST /api/tools/bf16/reset — Clear finished conversion state
router.post('/bf16/reset', authMiddleware, async (_req: AuthenticatedRequest, res: Response) => {
  if (activeConversion?.done) {
    activeConversion = null;
  }
  res.json({ status: 'ok' });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Model Merger
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

let activeMerge: {
  process: ChildProcess;
  events: Array<Record<string, unknown>>;
  done: boolean;
  error: string | null;
  startedAt: number;
} | null = null;

// POST /api/tools/merge/start
router.post('/merge/start', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (activeMerge && !activeMerge.done) {
      res.status(409).json({ error: 'A merge is already in progress' });
      return;
    }

    const { modelA, modelB, outputDir, alpha = 0.5, method = 'weighted_sum' } = req.body;
    const VALID_METHODS = ['weighted_sum', 'add_difference', 'multiply'];
    if (!VALID_METHODS.includes(method)) {
      res.status(400).json({ error: `Invalid method. Must be one of: ${VALID_METHODS.join(', ')}` });
      return;
    }
    if (!modelA || !modelB || !outputDir) {
      res.status(400).json({ error: 'modelA, modelB, and outputDir are required' });
      return;
    }

    if (!existsSync(modelA)) {
      res.status(400).json({ error: `Model A not found: ${modelA}` });
      return;
    }
    if (!existsSync(modelB)) {
      res.status(400).json({ error: `Model B not found: ${modelB}` });
      return;
    }

    const aceStepDir = getAceStepDir();
    const scriptPath = path.resolve(__dirname, '../../scripts/merge_models.py');
    const pythonPath = resolvePythonPath(aceStepDir);

    const child = spawn(pythonPath, [
      scriptPath,
      '--model-a', modelA,
      '--model-b', modelB,
      '--output', outputDir,
      '--alpha', String(alpha),
      '--method', String(method),
    ], {
      cwd: aceStepDir,
      env: { ...process.env },
    });

    activeMerge = {
      process: child,
      events: [],
      done: false,
      error: null,
      startedAt: Date.now(),
    };

    let buffer = '';

    child.stdout.on('data', (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (activeMerge) {
            activeMerge.events.push(event);
            if (activeMerge.events.length > 100) {
              activeMerge.events = activeMerge.events.slice(-50);
            }
          }
        } catch { /* ignore */ }
      }
    });

    child.stderr.on('data', (data: Buffer) => {
      console.error('[Merge] stderr:', data.toString());
    });

    child.on('close', (code: number | null) => {
      if (activeMerge) {
        activeMerge.done = true;
        if (code !== 0) activeMerge.error = `Process exited with code ${code}`;
      }
    });

    child.on('error', (err: Error) => {
      if (activeMerge) {
        activeMerge.done = true;
        activeMerge.error = err.message;
      }
    });

    res.json({ status: 'started' });
  } catch (error) {
    console.error('[Merge] Start error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to start merge' });
  }
});

// GET /api/tools/merge/status
router.get('/merge/status', authMiddleware, async (_req: AuthenticatedRequest, res: Response) => {
  if (!activeMerge) {
    res.json({ status: 'idle' });
    return;
  }

  res.json({
    status: activeMerge.done ? (activeMerge.error ? 'error' : 'done') : 'running',
    error: activeMerge.error,
    events: activeMerge.events.slice(-20),
    lastEvent: activeMerge.events[activeMerge.events.length - 1],
    totalEvents: activeMerge.events.length,
    elapsed: Date.now() - activeMerge.startedAt,
  });
});

// POST /api/tools/merge/stop
router.post('/merge/stop', authMiddleware, async (_req: AuthenticatedRequest, res: Response) => {
  if (!activeMerge || activeMerge.done) {
    res.json({ status: 'no active merge' });
    return;
  }
  activeMerge.process.kill('SIGTERM');
  activeMerge.done = true;
  activeMerge.error = 'Cancelled by user';
  res.json({ status: 'stopped' });
});

// POST /api/tools/merge/reset
router.post('/merge/reset', authMiddleware, async (_req: AuthenticatedRequest, res: Response) => {
  if (activeMerge?.done) activeMerge = null;
  res.json({ status: 'ok' });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Bake LoRA
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

let activeBake: {
  process: ChildProcess;
  events: Array<Record<string, unknown>>;
  done: boolean;
  error: string | null;
  startedAt: number;
} | null = null;

router.post('/bake/start', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (activeBake && !activeBake.done) {
      res.status(409).json({ error: 'A bake operation is already in progress' });
      return;
    }

    const { basePath, loraPath, outputDir, strength = 1.0 } = req.body;
    if (!basePath || !loraPath || !outputDir) {
      res.status(400).json({ error: 'basePath, loraPath, and outputDir are required' });
      return;
    }
    if (!existsSync(basePath)) {
      res.status(400).json({ error: `Base model not found: ${basePath}` });
      return;
    }
    if (!existsSync(loraPath)) {
      res.status(400).json({ error: `LoRA not found: ${loraPath}` });
      return;
    }

    const aceStepDir = getAceStepDir();
    const scriptPath = path.resolve(__dirname, '../../scripts/bake_lora.py');
    const pythonPath = resolvePythonPath(aceStepDir);

    const child = spawn(pythonPath, [
      scriptPath,
      '--base', basePath,
      '--lora', loraPath,
      '--output', outputDir,
      '--strength', String(strength),
    ], {
      cwd: aceStepDir,
      env: { ...process.env },
    });

    activeBake = { process: child, events: [], done: false, error: null, startedAt: Date.now() };

    let buffer = '';
    child.stdout.on('data', (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          if (activeBake) {
            activeBake.events.push(JSON.parse(line));
            if (activeBake.events.length > 100) activeBake.events = activeBake.events.slice(-50);
          }
        } catch {}
      }
    });
    child.stderr.on('data', (data: Buffer) => { console.error('[Bake] stderr:', data.toString()); });
    child.on('close', (code: number | null) => {
      if (activeBake) { activeBake.done = true; if (code !== 0) activeBake.error = `Process exited with code ${code}`; }
    });
    child.on('error', (err: Error) => {
      if (activeBake) { activeBake.done = true; activeBake.error = err.message; }
    });

    res.json({ status: 'started' });
  } catch (error) {
    console.error('[Bake] Start error:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to start' });
  }
});

router.get('/bake/status', authMiddleware, async (_req: AuthenticatedRequest, res: Response) => {
  if (!activeBake) { res.json({ status: 'idle' }); return; }
  res.json({
    status: activeBake.done ? (activeBake.error ? 'error' : 'done') : 'running',
    error: activeBake.error,
    events: activeBake.events.slice(-20),
    lastEvent: activeBake.events[activeBake.events.length - 1],
    totalEvents: activeBake.events.length,
    elapsed: Date.now() - activeBake.startedAt,
  });
});

router.post('/bake/stop', authMiddleware, async (_req: AuthenticatedRequest, res: Response) => {
  if (!activeBake || activeBake.done) { res.json({ status: 'no active bake' }); return; }
  activeBake.process.kill('SIGTERM');
  activeBake.done = true;
  activeBake.error = 'Cancelled by user';
  res.json({ status: 'stopped' });
});

router.post('/bake/reset', authMiddleware, async (_req: AuthenticatedRequest, res: Response) => {
  if (activeBake?.done) activeBake = null;
  res.json({ status: 'ok' });
});

// GET /api/tools/loras — List available LoRA adapters
router.get('/loras', authMiddleware, async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const loraOutputDir = path.resolve(process.cwd(), 'lora_output');
    const loras: Array<{ name: string; path: string; sizeMb: number }> = [];

    // Scan lora_output/ for exported LoRAs
    if (existsSync(loraOutputDir)) {
      for (const entry of readdirSync(loraOutputDir)) {
        const entryPath = path.join(loraOutputDir, entry);
        try {
          const st = statSync(entryPath);
          if (st.isDirectory()) {
            // Check for safetensors inside
            const files = readdirSync(entryPath);
            const hasSt = files.some((f: string) => f.endsWith('.safetensors'));
            if (hasSt) {
              let size = 0;
              for (const f of files) {
                if (f.endsWith('.safetensors')) {
                  try { size += statSync(path.join(entryPath, f)).size; } catch {}
                }
              }
              loras.push({ name: entry, path: entryPath, sizeMb: Math.round(size / 1024 / 1024 * 10) / 10 });
            }
          } else if (entry.endsWith('.safetensors')) {
            loras.push({ name: entry.replace('.safetensors', ''), path: entryPath, sizeMb: Math.round(st.size / 1024 / 1024 * 10) / 10 });
          }
        } catch {}
      }
    }

    // Also scan checkpoints for lora subfolders
    const checkpointsDir = path.join(getAceStepDir(), 'checkpoints');
    if (existsSync(checkpointsDir)) {
      for (const entry of readdirSync(checkpointsDir)) {
        const entryPath = path.join(checkpointsDir, entry);
        // Look for lora-specific folders (typically smaller, contain adapter_config.json)
        try {
          if (!statSync(entryPath).isDirectory()) continue;
          const files = readdirSync(entryPath);
          if (files.includes('adapter_config.json') || files.includes('adapter_model.safetensors')) {
            let size = 0;
            for (const f of files) {
              if (f.endsWith('.safetensors')) {
                try { size += statSync(path.join(entryPath, f)).size; } catch {}
              }
            }
            loras.push({ name: entry, path: entryPath, sizeMb: Math.round(size / 1024 / 1024 * 10) / 10 });
          }
        } catch {}
      }
    }

    res.json({ loras });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to list LoRAs' });
  }
});

export default router;
