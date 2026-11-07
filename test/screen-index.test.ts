/** IND/NEL must record a line ending only when the native terminal advances. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ParsedLine } from '../src/core/types.js';
import { ScreenModel } from '../src/terminal/screen.js';

function fixture() {
  const lines: ParsedLine[] = [];
  const model = new ScreenModel({
    nonce: 'index-regression', cols: 80, rows: 3,
    onLine: line => lines.push(line),
  });
  return {
    model,
    body: () => lines.map(line => line.text + (line.newline ? '\n' : '')).join(''),
  };
}

for (const final of ['D', 'E']) {
  for (const alternate of [false, true]) {
    test(`${final}: no movement below a partial scroll region does not repeat body (${alternate ? 'alternate' : 'normal'})`, async () => {
      const f = fixture();
      try {
        await f.model.write((alternate ? '\x1b[?1049h' : '') + '\x1b[1;2r\x1b[3;1HABC');
        // Separate writes also verify that partial-line flushing retains identity.
        f.model.flushLine();
        await f.model.write('\x1b' + final + '\x1b' + final);
        f.model.flushLine();
        assert.equal(f.body(), 'ABC');
        assert.equal(f.model.snapshot().cursor.y, 2);
        assert.equal(f.model.snapshot().cursor.x, final === 'D' ? 3 : 0);
      } finally { f.model.dispose(); }
    });
  }

  test(`${final}: real movement still terminates the old line`, async () => {
    const f = fixture();
    try {
      await f.model.write('ABC\x1b' + final + 'DEF');
      f.model.flushLine();
      assert.equal(f.body(), final === 'D' ? 'ABC\n   DEF' : 'ABC\nDEF');
      assert.equal(f.model.snapshot().cursor.y, 1);
    } finally { f.model.dispose(); }
  });

  test(`${final}: indexing at the scroll margin retains the line before scrolling`, async () => {
    const f = fixture();
    try {
      await f.model.write('\x1b[1;2r\x1b[2;1HABC\x1b' + final);
      f.model.flushLine();
      assert.equal(f.body(), 'ABC\n');
      assert.equal(f.model.snapshot().cursor.y, 1);
    } finally { f.model.dispose(); }
  });

  test(`${final}: invalid margins do not replace the active region`, async () => {
    const f = fixture();
    try {
      await f.model.write('\x1b[1;2r\x1b[3;2r\x1b[3;1HABC\x1b' + final);
      f.model.flushLine();
      assert.equal(f.body(), 'ABC');
    } finally { f.model.dispose(); }
  });

  test(`${final}: restored full-height margins allow scrolling at the last row`, async () => {
    const f = fixture();
    try {
      await f.model.write('\x1b[1;2r\x1b[r\x1b[3;1HABC\x1b' + final);
      f.model.flushLine();
      assert.equal(f.body(), 'ABC\n');
    } finally { f.model.dispose(); }
  });
}

for (const alternate of [false, true]) {
  for (const replacement of ['XYZ', 'ABC']) {
    for (const split of [false, true]) {
      test(`non-advancing NEL preserves overwritten body (${alternate ? 'alternate' : 'normal'}, ${replacement}, ${split ? 'split' : 'single'})`, async () => {
        const f = fixture();
        try {
          const before = (alternate ? '\x1b[?1049h' : '') + '\x1b[1;2r\x1b[3;1HABC\x1b';
          const after = 'E' + replacement;
          if (split) {
            await f.model.write(before);
            f.model.flushLine();
            await f.model.write(after);
          } else {
            await f.model.write(before + after);
          }
          f.model.flushLine();
          assert.equal(f.body(), 'ABC' + replacement);
        } finally { f.model.dispose(); }
      });
    }
  }
}

for (const ignored of ['\x07', '\x7f']) {
  for (const split of [false, true]) {
    test(`NEL with an intervening control preserves an identical rewrite (${ignored.charCodeAt(0)}, ${split ? 'split' : 'single'})`, async () => {
      const f = fixture();
      try {
        const before = '\x1b[1;2r\x1b[3;1HABC\x1b';
        const after = ignored + 'EABC';
        if (split) {
          await f.model.write(before);
          await f.model.write(after);
        } else {
          await f.model.write(before + after);
        }
        f.model.flushLine();
        assert.equal(f.body(), 'ABCABC');
      } finally { f.model.dispose(); }
    });
  }
}

test('repeated non-advancing NEL cannot hide an identical rewrite in one write', async () => {
  const f = fixture();
  try {
    await f.model.write('\x1b[1;2r\x1b[3;1HABC\x1bEABC\x1bE');
    f.model.flushLine();
    assert.equal(f.body(), 'ABCABC');
  } finally { f.model.dispose(); }
});

test('non-advancing IND retains a full row before its native wrap-column clamp', async () => {
  const f = fixture();
  try {
    const body = 'A'.repeat(80);
    await f.model.write('\x1b[1;2r\x1b[3;1H' + body + '\x1bDZ');
    f.model.flushLine();
    assert.equal(f.body(), body + 'A'.repeat(79) + 'Z');
  } finally { f.model.dispose(); }
});

test('soft reset restores the native full-height scroll margin', async () => {
  const f = fixture();
  try {
    await f.model.write('\x1b[1;2r\x1b[!p\x1b[3;1HABC\x1bD');
    f.model.flushLine();
    assert.equal(f.body(), 'ABC\n');
  } finally { f.model.dispose(); }
});

test('resize restores full-height margins without changing earlier output', async () => {
  const f = fixture();
  try {
    await f.model.write('\x1b[1;2r');
    f.model.resize(80, 4);
    await f.model.write('\x1b[4;1HABC\x1bD');
    f.model.flushLine();
    assert.equal(f.body(), 'ABC\n');
  } finally { f.model.dispose(); }
});

for (const cols of [80, 81]) {
  test(`${cols === 80 ? 'unchanged' : 'column-only'} resize keeps scroll-margin tracking aligned`, async () => {
    const f = fixture();
    try {
      await f.model.write('\x1b[1;2r');
      f.model.resize(cols, 3);
      await f.model.write('\x1b[3;1HABC\x1bD');
      f.model.flushLine();
      assert.equal(f.body(), cols === 80 ? 'ABC' : 'ABC\n');
    } finally { f.model.dispose(); }
  });
}

test('hard reset restores the native full-height scroll margin', async () => {
  const f = fixture();
  try {
    await f.model.write('\x1b[1;2r\x1bc\x1b[3;1HABC\x1bD');
    f.model.flushLine();
    assert.equal(f.body(), 'ABC\n');
  } finally { f.model.dispose(); }
});

test('alternate-buffer margin changes do not overwrite the normal-buffer margin', async () => {
  const f = fixture();
  try {
    await f.model.write('\x1b[1;2r\x1b[?1049h\x1b[r\x1b[?1049l\x1b[3;1HABC\x1bD');
    f.model.flushLine();
    assert.equal(f.body(), 'ABC');
  } finally { f.model.dispose(); }
});


test('checkpoint redraw controls reach READY within the initialization budget', { timeout: 10_000 }, async () => {
  const lines: ParsedLine[] = [];
  const markers: string[] = [];
  const model = new ScreenModel({
    nonce: 'checkpoint-redraw', cols: 80, rows: 3,
    onLine: line => lines.push(line),
    onMarker: marker => markers.push(marker.kind),
  });
  try {
    // A non-advancing NEL keeps a witness for an eventual same-glyph rewrite.
    // Pure cursor controls must not discard it. This stream used to restart a
    // native write timer per byte, starving even a READY already in the input.
    await model.write('\x1b[1;2r\x1b[3;1HABC\x1bE');
    await model.write('\x1b[3;1H'.repeat(1000) +
      'ABC\x1b]777;LSSH;checkpoint-redraw;READY;fish\x07');
    model.flushLine();
    assert.deepEqual(markers, ['ready']);
    assert.equal(lines.map(line => line.text + (line.newline ? '\n' : '')).join(''), 'ABCABC');
  } finally { model.dispose(); }
});
