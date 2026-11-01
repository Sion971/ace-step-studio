// Marks the lines of a training log that report a failure, so that the journal can show them in red.
//
// A line is an error when the trainer or PyTorch says so ("[FAIL]", "Training failed", "CUDA out of memory", the
// "[Side-Step] ... Error:" messages, a Python exception line). After a "Traceback" line, the indented lines that follow
// belong to it and are marked too.
const ERROR_LINE =
  /\[FAIL\]|TRAINING FAILED|Training failed|CUDA out of memory|OutOfMemoryError|Traceback \(most recent call last\)|\[Side-Step\][^\n]*\bError:|^[A-Za-z_.]*(?:Error|Exception)\b[^\n]*:/;

export interface LogLine {
  text: string;
  error: boolean;
}

export function markLogLines(log: string): LogLine[] {
  const marked: LogLine[] = [];
  let inTraceback = false;
  for (const text of log.split('\n')) {
    let error = ERROR_LINE.test(text);
    if (/Traceback \(most recent call last\)/.test(text)) {
      inTraceback = true;
    } else if (inTraceback && /^\s+\S/.test(text)) {
      error = true;
    } else if (inTraceback) {
      inTraceback = false;
    }
    marked.push({ text, error });
  }
  return marked;
}
