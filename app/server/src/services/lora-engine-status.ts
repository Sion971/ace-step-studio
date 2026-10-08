// services/lora-engine-status.ts
//
// What the engine says when asked to load a LoRA. It answers in words, with a mark in front ("✅ …", "❌ Failed to load LoRA: …"), and it answers
// with a normal reply even when it did not load anything: the route used to take any reply for a success and record `loaded: true`, so a refused
// LoRA showed as "LoRA loaded" in the panel (which then also switched off `thinking` and `useAdg` for a LoRA that was not there).
//
// The one failure worth explaining is the name of the folder. The engine uses the folder's name as the name of the adapter, and PEFT stores it in
// a module dictionary whose keys cannot contain a ".": a folder called "lo_fi-acestep1.5-v1" fails with
//   'module name can't contain ".", got: lo_fi-acestep1.5-v1'
// which says nothing about what to change. (The same message was long blamed on the name of the weights file; that one is renamed by
// GET /api/lora/available, and the message names the FOLDER.)
//
// It is only blamed on the folder when the engine says so AND the folder has a ".": a load is never refused on a guess about the name.

export interface LoadFailure {
  code: 'invalid_adapter_name' | 'lora_load_failed';
  message: string;
}

export const folderNameOf = (loraPath: string): string => loraPath.replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() ?? '';

/** The name this folder should have for the engine to accept it: the dots are what it cannot take. */
export const adapterSafeName = (folder: string): string => folder.replace(/\./g, '_');

const FAILURE_MARK = /^[\s]*(❌|✗|✖)/u;

/** Null when the reply does not announce a failure (a success, or something this does not recognize: no failure is invented). */
export function describeLoadFailure(status: unknown, loraPath: string): LoadFailure | null {
  const text = typeof status === 'string' ? status.trim() : '';
  const failed = FAILURE_MARK.test(text) || /\bfailed to load\b/i.test(text);
  if (!failed) return null;

  const folder = folderNameOf(loraPath);
  // The engine's text is the str() of a Python KeyError, which is the repr() of its message: the apostrophe comes with a backslash, can\'t.
  if (/module name can\\?'?t contain/i.test(text) && folder.includes('.')) {
    return {
      code: 'invalid_adapter_name',
      message: `The folder name "${folder}" contains a ".", and the engine uses the folder name as the adapter name, which cannot contain one. Rename the folder to "${adapterSafeName(folder)}" (in ACE-Step-1.5/lora_output) and try again.`,
    };
  }
  const readable = text.replace(/^[\s❌✗✖]+/u, '').trim();
  return { code: 'lora_load_failed', message: readable || 'The engine could not load this LoRA.' };
}
