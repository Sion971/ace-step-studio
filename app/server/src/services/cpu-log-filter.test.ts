// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { dropGpuDiagnostic } from './cpu-log-filter.js';

const line = (fn: string, n: number, msg: string) => `2026-10-15 10:00:00 | WARNING | acestep.gpu_config:${fn}:${n} - ${msg}\n`;

describe('dropGpuDiagnostic', () => {
  it('removes the whole diagnostic block and keeps the lines around it', () => {
    const text =
      'No GPU detected, running on CPU\n' +
      line('_log_gpu_diagnostic_info', 645, '=====') +
      line('_log_gpu_diagnostic_info', 646, 'GPU NOT DETECTED - DIAGNOSTIC INFORMATION') +
      line('_log_gpu_diagnostic_info', 740, '=====') +
      'GPU Configuration Detected: Max Duration 360s\n';
    expect(dropGpuDiagnostic(text)).toBe('No GPU detected, running on CPU\nGPU Configuration Detected: Max Duration 360s\n');
  });
  it('returns other text untouched', () => {
    const text = 'a\nb\n';
    expect(dropGpuDiagnostic(text)).toBe(text);
  });
  it('returns an empty string when only the block is present', () => {
    expect(dropGpuDiagnostic(line('_log_gpu_diagnostic_info', 650, 'x'))).toBe('');
  });
});
