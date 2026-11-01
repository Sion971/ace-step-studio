// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { markLogLines } from './logLines';

const errors = (log: string) => markLogLines(log).filter((l) => l.error).map((l) => l.text);

describe('markLogLines', () => {
  it('keeps ordinary lines unmarked', () => {
    expect(errors('[INFO] Loading model\nEpoch 1/10, Step 1, Loss: 1.6508\n[OK] Epoch 1/10 in 26.1s, Loss: 1.5674')).toEqual([]);
  });

  it('marks the trainer\'s own error message', () => {
    const msg = '[Side-Step] Dataset and model do not match Error: ValueError: tensors of width 2048';
    expect(errors(`[INFO] Loading model\n\n${msg}\n`)).toEqual([msg]);
  });

  it('marks out-of-memory and failure lines', () => {
    const log = [
      'torch.OutOfMemoryError: CUDA out of memory. Tried to allocate 382.00 MiB.',
      '[FAIL] Training failed: CUDA out of memory.',
      '  TRAINING FAILED -- 0 steps executed',
      '[INFO] Peak VRAM so far: 1.13 GiB',
    ].join('\n');
    expect(errors(log)).toEqual(log.split('\n').slice(0, 3));
  });

  it('marks a whole traceback and stops at the next normal line', () => {
    const log = [
      '[INFO] Gradient checkpointing enabled',
      'Traceback (most recent call last):',
      '  File "trainer_fixed.py", line 163, in train',
      '    yield from self._train_fabric(data_module, training_state)',
      'ValueError: boom',
      '[INFO] done',
    ].join('\n');
    expect(errors(log)).toEqual(log.split('\n').slice(1, 5));
  });

  it('keeps one entry per line, empty ones included', () => {
    expect(markLogLines('a\n\nb')).toEqual([
      { text: 'a', error: false },
      { text: '', error: false },
      { text: 'b', error: false },
    ]);
  });
});
