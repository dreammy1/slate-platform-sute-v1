import { describe, expect, it } from 'vitest';

import { MAX_ERROR_CAUSE_DEPTH, serializeError } from './errors.ts';

/** Builds an error whose `cause` chain is `depth` links deep. */
function wrap(depth: number): Error {
  let error = new Error('root failure');
  for (let level = 0; level < depth; level += 1) {
    error = new Error(`wrap ${level}`, { cause: error });
  }
  return error;
}

describe('serializeError', () => {
  it('keeps the name, message and stack of a real error', () => {
    const serialized = serializeError(new TypeError('booking total must be positive'));

    expect(serialized.name).toBe('TypeError');
    expect(serialized.message).toBe('booking total must be positive');
    expect(serialized.stack?.split('\n')[0]).toBe('TypeError: booking total must be positive');
  });

  it('normalizes an empty name to Error', () => {
    const error = new Error('anonymous');
    error.name = '';

    expect(serializeError(error).name).toBe('Error');
  });

  it('omits the stack when the error has none', () => {
    const error = new Error('no stack');
    delete error.stack;

    expect('stack' in serializeError(error)).toBe(false);
  });

  it('does not invent a cause for a plain error', () => {
    expect(serializeError(new Error('plain')).cause).toBeUndefined();
  });

  it('follows the cause chain and keeps it bounded', () => {
    let link = serializeError(wrap(MAX_ERROR_CAUSE_DEPTH + 3));
    let depth = 0;

    while (link.cause !== undefined) {
      depth += 1;
      link = link.cause;
    }

    expect(depth).toBe(MAX_ERROR_CAUSE_DEPTH);
    expect(link.message).toBe(`wrap ${MAX_ERROR_CAUSE_DEPTH - 3}`);
    expect(link.cause).toBeUndefined();
  });

  it('preserves whatever was thrown, even when it is not an error', () => {
    expect(serializeError('payment declined')).toEqual({
      name: 'NonError',
      message: 'payment declined',
    });
    expect(serializeError(undefined)).toEqual({ name: 'NonError', message: 'undefined' });
    expect(serializeError(null)).toEqual({ name: 'NonError', message: 'null' });
    expect(serializeError(42)).toEqual({ name: 'NonError', message: '42' });
    expect(serializeError(false)).toEqual({ name: 'NonError', message: 'false' });
    expect(serializeError(10n)).toEqual({ name: 'NonError', message: '10' });
    expect(serializeError({ status: 500 })).toEqual({
      name: 'NonError',
      message: '{"status":500}',
    });
    expect(serializeError([])).toEqual({ name: 'NonError', message: '[]' });
  });

  it('describes values JSON cannot express instead of losing them', () => {
    expect(serializeError(Symbol('tenant')).message).toBe('Symbol(tenant)');
    expect(
      serializeError(function forbidden() {
        return 1;
      }).message,
    ).toBe('[function forbidden]');
    expect(
      serializeError(function () {
        return 1;
      }).message,
    ).toBe('[function anonymous]');
  });

  it('survives a value that cannot be stringified', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;

    expect(serializeError(circular).message).toBe('[unserializable object]');
  });
});
