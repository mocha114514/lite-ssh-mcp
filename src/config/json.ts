import { LiteSshError } from '../core/errors.js';

/**
 * Strict JSON parsing for the on-disk configuration.
 *
 * `JSON.parse` silently keeps the last of two duplicate keys, so it cannot tell
 * whether an operator wrote an ambiguous file. This parser walks the same
 * grammar but rejects duplicate keys, comparing the *decoded* key text, so an
 * escaped spelling such as `"\u0061"` still collides with `"a"`.
 *
 * Error messages deliberately report only a reason and a character offset; they
 * never echo file content, because the configuration can contain passphrases.
 */
export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;

export interface JsonObject {
  [key: string]: JsonValue;
}

const WHITESPACE = ' \t\n\r';

const SIMPLE_ESCAPES: Record<string, string> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
};

function fail(reason: string, offset: number): never {
  throw new LiteSshError('CONFIG_INVALID', `The configuration is not valid JSON (${reason} at character ${offset}).`);
}

function isDigit(character: string | undefined): boolean {
  return character !== undefined && character >= '0' && character <= '9';
}

function hexValue(character: string): number {
  if (character >= '0' && character <= '9') return character.charCodeAt(0) - 48;
  if (character >= 'a' && character <= 'f') return character.charCodeAt(0) - 87;
  if (character >= 'A' && character <= 'F') return character.charCodeAt(0) - 55;
  return -1;
}

class StrictJsonParser {
  private index = 0;

  constructor(private readonly text: string) {}

  parseDocument(): JsonValue {
    const value = this.parseValue();
    this.skipWhitespace();
    if (this.index < this.text.length) fail('unexpected trailing content', this.index);
    return value;
  }

  private parseValue(): JsonValue {
    this.skipWhitespace();
    if (this.index >= this.text.length) fail('unexpected end of input', this.index);
    const character = this.text[this.index]!;
    if (character === '{') return this.parseObject();
    if (character === '[') return this.parseArray();
    if (character === '"') return this.parseString();
    if (character === 't') return this.parseLiteral('true', true);
    if (character === 'f') return this.parseLiteral('false', false);
    if (character === 'n') return this.parseLiteral('null', null);
    return this.parseNumber();
  }

  private parseObject(): JsonObject {
    this.index += 1; // consume '{'
    // Null-prototype objects keep keys like "__proto__" from touching a prototype.
    const result = Object.create(null) as JsonObject;
    const seenKeys = new Set<string>();
    this.skipWhitespace();
    if (this.text[this.index] === '}') {
      this.index += 1;
      return result;
    }
    for (;;) {
      this.skipWhitespace();
      if (this.text[this.index] !== '"') fail('expected a string object key', this.index);
      const keyOffset = this.index;
      const key = this.parseString();
      if (seenKeys.has(key)) fail('duplicate object key', keyOffset);
      seenKeys.add(key);
      this.skipWhitespace();
      if (this.text[this.index] !== ':') fail('expected ":" after an object key', this.index);
      this.index += 1;
      result[key] = this.parseValue();
      this.skipWhitespace();
      const separator = this.text[this.index];
      if (separator === ',') {
        this.index += 1;
        continue;
      }
      if (separator === '}') {
        this.index += 1;
        return result;
      }
      fail('expected "," or "}" in an object', this.index);
    }
  }

  private parseArray(): JsonValue[] {
    this.index += 1; // consume '['
    const result: JsonValue[] = [];
    this.skipWhitespace();
    if (this.text[this.index] === ']') {
      this.index += 1;
      return result;
    }
    for (;;) {
      result.push(this.parseValue());
      this.skipWhitespace();
      const separator = this.text[this.index];
      if (separator === ',') {
        this.index += 1;
        continue;
      }
      if (separator === ']') {
        this.index += 1;
        return result;
      }
      fail('expected "," or "]" in an array', this.index);
    }
  }

  private parseString(): string {
    this.index += 1; // consume opening quote
    let value = '';
    for (;;) {
      if (this.index >= this.text.length) fail('unterminated string', this.index);
      const character = this.text[this.index]!;
      if (character === '"') {
        this.index += 1;
        return value;
      }
      if (character === '\\') {
        value += this.parseEscape();
        continue;
      }
      if (character.charCodeAt(0) <= 0x1f) fail('unescaped control character in a string', this.index);
      value += character;
      this.index += 1;
    }
  }

  private parseEscape(): string {
    this.index += 1; // consume backslash
    if (this.index >= this.text.length) fail('unterminated escape sequence', this.index);
    const character = this.text[this.index]!;
    const simple = SIMPLE_ESCAPES[character];
    if (simple !== undefined) {
      this.index += 1;
      return simple;
    }
    if (character !== 'u') fail('unknown escape sequence in a string', this.index);
    this.index += 1;
    return this.parseUnicodeEscape();
  }

  private parseUnicodeEscape(): string {
    let codePoint = this.readHex4();
    if (codePoint >= 0xd800 && codePoint <= 0xdbff) {
      // A high surrogate must be followed by its low surrogate in a second \u escape.
      if (this.text[this.index] !== '\\' || this.text[this.index + 1] !== 'u') {
        fail('unpaired high surrogate in a string', this.index);
      }
      this.index += 2;
      const low = this.readHex4();
      if (low < 0xdc00 || low > 0xdfff) fail('invalid low surrogate in a string', this.index);
      codePoint = 0x10000 + ((codePoint - 0xd800) << 10) + (low - 0xdc00);
    }
    return String.fromCodePoint(codePoint);
  }

  private readHex4(): number {
    const offset = this.index;
    let value = 0;
    for (let digitIndex = 0; digitIndex < 4; digitIndex += 1) {
      const digit = hexValue(this.text[this.index] ?? '');
      if (digit < 0) fail('invalid \\u escape in a string', offset);
      value = value * 16 + digit;
      this.index += 1;
    }
    return value;
  }

  private parseLiteral<T extends boolean | null>(literal: string, value: T): T {
    if (this.text.startsWith(literal, this.index)) {
      this.index += literal.length;
      return value;
    }
    fail(`invalid literal; expected "${literal}"`, this.index);
  }

  private parseNumber(): number {
    const offset = this.index;
    if (this.text[this.index] === '-') this.index += 1;
    if (this.text[this.index] === '0') {
      this.index += 1;
      if (isDigit(this.text[this.index])) fail('leading zeros are not allowed in a number', offset);
    } else if (isDigit(this.text[this.index])) {
      while (isDigit(this.text[this.index])) this.index += 1;
    } else {
      fail('expected a JSON value', offset);
    }
    if (this.text[this.index] === '.') {
      this.index += 1;
      if (!isDigit(this.text[this.index])) fail('a fraction needs at least one digit', offset);
      while (isDigit(this.text[this.index])) this.index += 1;
    }
    const exponent = this.text[this.index];
    if (exponent === 'e' || exponent === 'E') {
      this.index += 1;
      const sign = this.text[this.index];
      if (sign === '+' || sign === '-') this.index += 1;
      if (!isDigit(this.text[this.index])) fail('an exponent needs at least one digit', offset);
      while (isDigit(this.text[this.index])) this.index += 1;
    }
    const parsed = Number(this.text.slice(offset, this.index));
    if (!Number.isFinite(parsed)) fail('number is out of range', offset);
    return parsed;
  }

  private skipWhitespace(): void {
    while (this.index < this.text.length && WHITESPACE.includes(this.text[this.index]!)) this.index += 1;
  }
}

export function parseJsonStrict(text: string): JsonValue {
  const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  return new StrictJsonParser(withoutBom).parseDocument();
}
