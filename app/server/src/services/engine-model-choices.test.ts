// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The model dropdown of the engine is built once, when the engine starts, from the folders that exist then. Gradio refuses any other value
// ("Value: acestep-v15-turbo is not in the list of choices"), so a model downloaded afterwards from the menu could not be loaded until the next
// restart. Reproduced with gradio 6.2.0 (the version the engine pins): with allow_custom_value=True the same call is accepted.
const here = path.dirname(fileURLToPath(import.meta.url));
const file = path.resolve(here, '../../../../ACE-Step-1.5/acestep/ui/gradio/interfaces/generation_service_config_rows.py');

describe('the main model dropdown of the engine', () => {
  it('accepts a model that was downloaded after the engine started', () => {
    const source = readFileSync(file, 'utf-8');
    const start = source.indexOf('config_path = gr.Dropdown(');
    expect(start).toBeGreaterThan(-1);
    const call = source.slice(start, source.indexOf('\n        )\n', start));
    expect(call).toContain('choices=available_models');
    expect(call).toContain('allow_custom_value=True');
  });
});
