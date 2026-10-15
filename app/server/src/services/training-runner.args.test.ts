// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { trainingRunner } from './training-runner.js';

const argsOf = (p: Parameters<typeof trainingRunner.buildArgs>[0]) => trainingRunner.buildArgs(p);
const valueOf = (args: string[], flag: string) => {
  const i = args.indexOf(flag);
  return i < 0 ? undefined : args[i + 1];
};

describe('train.py arguments', () => {
  it('passes the four new options when they are valid', () => {
    const a = argsOf({ warmupSteps: 50, schedulerType: 'linear', cfgRatio: 0.2, attentionType: 'self' });
    expect(valueOf(a, '--warmup-steps')).toBe('50');
    expect(valueOf(a, '--scheduler-type')).toBe('linear');
    expect(valueOf(a, '--cfg-ratio')).toBe('0.2');
    expect(valueOf(a, '--attention-type')).toBe('self');
  });

  it('accepts a CFG dropout of 0 (switched off) and rounds the warmup to whole steps', () => {
    const a = argsOf({ cfgRatio: 0, warmupSteps: 12.6 });
    expect(valueOf(a, '--cfg-ratio')).toBe('0');
    expect(valueOf(a, '--warmup-steps')).toBe('13');
  });

  it('leaves out what is missing or not acceptable, so train.py keeps its own default', () => {
    const a = argsOf({ warmupSteps: -1, schedulerType: 'cosine; rm -rf', cfgRatio: 1.5, attentionType: '--evil' });
    for (const flag of ['--warmup-steps', '--scheduler-type', '--cfg-ratio', '--attention-type']) expect(a).not.toContain(flag);
    const none = argsOf({});
    for (const flag of ['--warmup-steps', '--scheduler-type', '--cfg-ratio', '--attention-type']) expect(none).not.toContain(flag);
  });

  it('keeps the global options before the subcommand', () => {
    const a = argsOf({ cfgRatio: 0.15 });
    expect(a.slice(0, 3)).toEqual(['--yes', '--plain', 'fixed']);
  });
});
