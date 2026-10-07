import { authMiddleware } from '../middleware/auth.js';
import { LoraHub } from '../services/lora-hub.js';
import { createLoraHubRouter } from './lora-hub-router.js';
import { LORA_OUTPUT_DIR } from './lora.js';

// Where the LoRA live and which Hub to talk to: the same folder as /api/lora/available, and the same environment variables as huggingface_hub.
const hub = new LoraHub({
  loraDir: LORA_OUTPUT_DIR,
  endpoint: process.env.HF_ENDPOINT,
  token: process.env.HF_TOKEN || process.env.HUGGING_FACE_HUB_TOKEN,
});

export default createLoraHubRouter({ auth: authMiddleware, hub });
