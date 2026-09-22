import { describe, it, expect, vi } from 'vitest';
import { serialReload } from './reloadgate';

/** A reload the test finishes by hand. */
function controlled() {
  const pending: (() => void)[] = [];
  const reload = vi.fn(() => new Promise<void>((r) => pending.push(r)));
  const finish = async () => {
    pending.shift()?.();
    // Let .finally and a trailing trigger run.
    await new Promise((r) => setTimeout(r, 0));
  };
  return { reload, finish };
}

describe('serialReload', () => {
  it('runs one reload at a time', async () => {
    const { reload, finish } = controlled();
    const trigger = serialReload(reload, () => {});
    trigger();
    trigger();
    expect(reload).toHaveBeenCalledTimes(1);
    await finish();
  });

  it('runs ONE more reload after a busy one when poked meanwhile, however many pokes', async () => {
    const { reload, finish } = controlled();
    const trigger = serialReload(reload, () => {});
    trigger();
    trigger();
    trigger();
    trigger();
    await finish();
    expect(reload).toHaveBeenCalledTimes(2);
    await finish();
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('runs no trailing reload when nothing asked during the first', async () => {
    const { reload, finish } = controlled();
    const trigger = serialReload(reload, () => {});
    trigger();
    await finish();
    expect(reload).toHaveBeenCalledTimes(1);
    trigger();
    expect(reload).toHaveBeenCalledTimes(2);
    await finish();
  });

  it('reports a failed reload and still serves the next request', async () => {
    const onError = vi.fn();
    let calls = 0;
    const trigger = serialReload(async () => {
      calls++;
      if (calls === 1) throw new Error('registry down');
    }, onError);
    trigger();
    await new Promise((r) => setTimeout(r, 0));
    expect(onError).toHaveBeenCalledOnce();
    trigger();
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toBe(2);
  });
});
