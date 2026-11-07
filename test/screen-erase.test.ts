/**
 * Readable-history regressions for ED/EL. The emulator and recorder run entirely
 * in memory; no user files, terminal sessions or private credentials are used.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FileHandle } from 'node:fs/promises';
import { ReadableRecorder } from '../src/cache/recorder.js';
import type { ParsedLine } from '../src/core/types.js';
import { ScreenModel } from '../src/terminal/screen.js';

async function bodyOf(chunks: string[], cols = 80, rows = 24): Promise<string> {
  const lines: ParsedLine[] = [];
  const model = new ScreenModel({
    nonce: 'erase-regression', cols, rows,
    onLine: line => lines.push(line),
  });
  try {
    for (const chunk of chunks) await model.write(chunk);
    model.flushLine();
    return lines.map(line => line.text + (line.newline ? '\n' : '')).join('');
  } finally {
    model.dispose();
  }
}

for (const erase of ['\x1b[K', '\x1b[0K', '\x1b[J', '\x1b[0J']) {
  test(`unused trailing cells erased by ${JSON.stringify(erase)} do not repeat body`, async () => {
    assert.equal(await bodyOf(['abc' + erase + '\r\n']), 'abc\n');
    assert.equal(await bodyOf(['abc\x1b[', erase.slice(2), '\r', '\n']), 'abc\n');
  });
}

for (const erase of ['\x1b[2K', '\x1b[2J']) {
  test(`actual erase ${JSON.stringify(erase)} keeps identical rewritten glyphs`, async () => {
    assert.equal(await bodyOf(['abc' + erase + '\x1b[1Gabc\r\n']), 'abcabc\n');
  });
}

test('erase-before-cursor over unused leading cells keeps the recorded later text', async () => {
  for (const erase of ['\x1b[1K', '\x1b[1J']) {
    assert.equal(await bodyOf(['\x1b[6GZ\x1b[1G' + erase + '\r\n']), '     Z\n');
  }
});

test('ED erasing a later row does not invalidate an unchanged earlier row', async () => {
  const body = await bodyOf(['ABC\r\nDEF\x1b[1;4H\x1b[J\r\n']);
  assert.equal(body, 'ABC\nDEF\n');
});

test('EL touching a wide-glyph continuation preserves its genuine rewrite', async () => {
  assert.equal(await bodyOf(['中\x1b[2G\x1b[K\x1b[1G中\r\n']), '中中\n');
});

test('ED scrollback-only erase does not repeat the surviving visible body', async () => {
  assert.equal(await bodyOf(['old\r\nmore\r\nabc\x1b[3J\r\n'], 80, 2), 'old\nmore\nabc\n');
});

for (const split of [false, true]) {
  test(`ED3 followed by a real soft-wrap scroll preserves body (${split ? 'split' : 'single'} write)`, async () => {
    const before = 'x\r\ny\r\naaa\x1b[3J';
    const after = 'aaa\r\n';
    assert.equal(await bodyOf(split ? [before, after] : [before + after], 3, 2), 'x\ny\naaaaaa\n');
  });
}

for (const body of ['x'.repeat(501), '😀'.repeat(999), '😀'.repeat(1000)]) {
  test(`EL keeps the actual Unicode count and preview threshold (${[...body].length} body code points)`, async () => {
    // No stat method: this is only a writer seam, not an acquired disk object.
    const handle = {
      write: async (buffer: Buffer, _offset: number, length: number) => ({ bytesWritten: length, buffer }),
      close: async () => undefined,
    } as unknown as FileHandle;
    const recorder = await ReadableRecorder.createWithHandle(
      handle,
      'vb-test/erase-regression/memory-only-not-created.context.log',
      { ip: '192.0.2.10', port: 22, username: 'synthetic', codename: 'erase_regression' },
    );
    const model = new ScreenModel({
      nonce: 'erase-regression', cols: 80, rows: 24,
      onLine: line => recorder.recordLine(line),
    });
    try {
      recorder.beginRound();
      await model.write(body + '\x1b[K\r\n');
      model.flushLine();
      const result = await recorder.endRound(0);
      const expected = body + '\n';
      assert.equal(result.outputCharacters, [...expected].length);
      assert.equal(result.outputOmitted, [...expected].length > 1000);
      assert.equal(result.output, [...expected].length > 1000 ? null : expected);
    } finally {
      model.dispose();
      await recorder.close({ remove: false });
    }
  });
}
