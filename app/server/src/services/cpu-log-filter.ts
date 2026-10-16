/**
 * In processor mode the engine still prints a long WARNING block ("GPU NOT DETECTED - DIAGNOSTIC INFORMATION", pip hints,
 * ROCm hints...). Every line of it is logged by `_log_gpu_diagnostic_info`, so those lines are dropped; the other GPU lines
 * ("No GPU detected, running on CPU", the configuration block with the duration limits) are kept.
 */
const MARKER = 'gpu_config:_log_gpu_diagnostic_info';

export function dropGpuDiagnostic(text: string): string {
  if (!text.includes(MARKER)) return text;
  return text
    .split(/(?<=\n)/)
    .filter((line) => !line.includes(MARKER))
    .join('');
}
