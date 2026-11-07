import type { IDisposable, IFunctionIdentifier } from '@xterm/headless';

/**
 * @xterm/headless 6.0.0 ships boolean-only hook declarations, although its
 * parser supports the documented Promise<boolean> contract. Extend only the
 * two hooks we use; no dependency replacement, private API, or runtime cast.
 * The pinned runtime is exercised by terminal-backpressure.test.ts.
 * Reference: https://xtermjs.org/docs/guides/hooks/#async-actions-in-parser-hooks
 */
declare module '@xterm/headless' {
  interface IParser {
    registerCsiHandler(
      id: IFunctionIdentifier,
      callback: (params: (number | number[])[]) => boolean | Promise<boolean>,
    ): IDisposable;
    registerEscHandler(
      id: IFunctionIdentifier,
      callback: () => boolean | Promise<boolean>,
    ): IDisposable;
  }
}
