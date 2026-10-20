import { encodeMarkerOsc } from '../../src/shell/protocol.js';

const MAX_SEQUENCE = 2_147_483_647;

/**
 * One allocator per synthetic shell/nonce, independent of input/Enter counts.
 * Negative tests must use encodeMarkerOsc directly: this helper never repairs
 * an explicitly supplied bad wire sequence or turns it into a different round.
 */
export function createShellMarkers(nonce: string, firstSequence = 1) {
  let next = firstSequence;
  let active: number | undefined;

  const sequence = (): number => {
    const value = active ?? next;
    if (!Number.isInteger(value) || value < 1 || value > MAX_SEQUENCE) {
      throw new Error('The owned shell-marker fixture exhausted its sequence range.');
    }
    return value;
  };

  const begin = (): string => {
    active = sequence();
    return encodeMarkerOsc(nonce, `BEGIN;${active}`);
  };

  const end = (exitCode = 0, hookHealthy = true): string => {
    const current = sequence();
    active = undefined;
    next = current + 1;
    return encodeMarkerOsc(nonce, `END;${current};${exitCode};${hookHealthy ? 1 : 0}`);
  };

  return {
    begin,
    end,
    /** Migrate old semantic fixtures only; explicit wire negatives stay raw. */
    marker(payload: string): string {
      if (payload === 'BEGIN') return begin();
      const legacyEnd = /^END;(\d+)(?:;([01]))?$/.exec(payload);
      if (legacyEnd) return end(Number(legacyEnd[1]), legacyEnd[2] !== '0');
      return encodeMarkerOsc(nonce, payload);
    },
  };
}
