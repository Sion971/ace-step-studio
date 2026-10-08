import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { authMiddleware } from '../middleware/auth.js';
import { LoraHub } from '../services/lora-hub.js';
import { loadCatalogFile } from '../services/lora-catalog.js';
import { createLoraHubRouter } from './lora-hub-router.js';
import { LORA_OUTPUT_DIR } from './lora.js';

const here = path.dirname(fileURLToPath(import.meta.url));

// Where the LoRA live and which Hub to talk to: the same folder as /api/lora/available, and the same environment variables as huggingface_hub.
const hub = new LoraHub({
  loraDir: LORA_OUTPUT_DIR,
  endpoint: process.env.HF_ENDPOINT,
  token: process.env.HF_TOKEN || process.env.HUGGING_FACE_HUB_TOKEN,
});

// app/server/src/routes/lora-hub.ts -> app/server/catalog/lora-catalog.json. Read at each request: editing the file needs no restart.
const CATALOG_FILE = path.join(here, '../../catalog/lora-catalog.json');

export default createLoraHubRouter({
  auth: authMiddleware,
  hub,
  catalog: () => loadCatalogFile(CATALOG_FILE),
});
