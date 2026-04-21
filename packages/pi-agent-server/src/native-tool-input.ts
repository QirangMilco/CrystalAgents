export type NativeToolValidationResult =
  | { ok: true }
  | { ok: false; missing: 'command' | 'path'; message: string };

export function validateNativeToolInput(
  toolName: string,
  input: Record<string, unknown>,
): NativeToolValidationResult {
  if (toolName === 'Bash') {
    const command = typeof input.command === 'string' ? input.command.trim() : '';
    if (!command) {
      return {
        ok: false,
        missing: 'command',
        message: 'Invalid Bash tool input: missing required field "command".',
      };
    }
  }

  if (toolName === 'Read') {
    const path = typeof input.path === 'string' ? input.path.trim() : '';
    if (!path) {
      return {
        ok: false,
        missing: 'path',
        message: 'Invalid Read tool input: missing required field "path".',
      };
    }
  }

  return { ok: true };
}
