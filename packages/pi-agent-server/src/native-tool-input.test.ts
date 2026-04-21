import { describe, expect, it } from 'bun:test';
import { validateNativeToolInput } from './native-tool-input.ts';

describe('validateNativeToolInput', () => {
  it('rejects Bash when command is missing', () => {
    const result = validateNativeToolInput('Bash', {});
    expect(result).toEqual({
      ok: false,
      missing: 'command',
      message: 'Invalid Bash tool input: missing required field "command".',
    });
    if (!result.ok) {
      expect(result.message).toContain('missing required field "command"');
    }
  });

  it('rejects Bash when command is blank', () => {
    const result = validateNativeToolInput('Bash', { command: '   ' });
    expect(result).toEqual({
      ok: false,
      missing: 'command',
      message: 'Invalid Bash tool input: missing required field "command".',
    });
  });

  it('accepts Bash when command is present', () => {
    const result = validateNativeToolInput('Bash', { command: 'pwd' });
    expect(result).toEqual({ ok: true });
  });

  it('rejects Read when path is missing', () => {
    const result = validateNativeToolInput('Read', {});
    expect(result).toEqual({
      ok: false,
      missing: 'path',
      message: 'Invalid Read tool input: missing required field "path".',
    });
    if (!result.ok) {
      expect(result.message).toContain('missing required field "path"');
    }
  });

  it('rejects Read when path is blank', () => {
    const result = validateNativeToolInput('Read', { path: '   ' });
    expect(result).toEqual({
      ok: false,
      missing: 'path',
      message: 'Invalid Read tool input: missing required field "path".',
    });
  });

  it('accepts Read when path is present', () => {
    const result = validateNativeToolInput('Read', { path: '/tmp/example.txt' });
    expect(result).toEqual({ ok: true });
  });

  it('ignores unrelated tools', () => {
    const result = validateNativeToolInput('Write', {});
    expect(result).toEqual({ ok: true });
  });
});
