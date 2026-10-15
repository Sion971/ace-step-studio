// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { trainingRunner } from './training-runner.js';

const flags = (args: string[]) => args.filter((a) => a.startsWith('--'));
const valueOf = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

describe('training arguments: LoRA and LoKr size settings', () => {
  it('sends --rank / --alpha for a LoRA', () => {
    const args = trainingRunner.buildArgs({ adapterType: 'lora', rank: 16, alpha: 32 });
    expect(valueOf(args, '--rank')).toBe('16');
    expect(valueOf(args, '--alpha')).toBe('32');
    expect(flags(args)).not.toContain('--lokr-linear-dim');
  });

  it('sends the LoKr names for a LoKr, so the size chosen is the size trained', () => {
    const args = trainingRunner.buildArgs({ adapterType: 'lokr', rank: 16, alpha: 32 });
    expect(valueOf(args, '--adapter-type')).toBe('lokr');
    expect(valueOf(args, '--lokr-linear-dim')).toBe('16');
    expect(valueOf(args, '--lokr-linear-alpha')).toBe('32');
    expect(flags(args)).not.toContain('--rank');
    expect(flags(args)).not.toContain('--alpha');
  });
});
