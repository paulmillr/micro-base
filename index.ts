/*! scure-base - MIT License (c) 2022 Paul Miller (paulmillr.com) */

// Utilities
export function assertNumber(n: number) {
  if (!Number.isSafeInteger(n)) throw new Error(`Wrong integer: ${n}`);
}
export interface Coder<F, T> {
  encode(from: F): T;
  decode(to: T): F;
}

export interface BytesCoder extends Coder<Uint8Array, string> {
  encode: (data: Uint8Array) => string;
  decode: (str: string) => Uint8Array;
}

function isBytes(a: unknown): a is Uint8Array {
  return a instanceof Uint8Array || (ArrayBuffer.isView(a) && a.constructor.name === 'Uint8Array');
}

function isArrayOf(type: 'string' | 'number', arr: any[]) {
  if (!Array.isArray(arr)) return false;
  if (arr.length === 0) return true;
  if (type === 'string') return arr.every((item) => typeof item === 'string');
  if (type === 'number') return arr.every((item) => Number.isSafeInteger(item));
  return false;
}

// no abytes: seems to have 10% slowdown. Why?!

function afn(input: Function): input is Function {
  if (typeof input !== 'function') throw new Error('function expected');
  return true;
}

function astr(label: string, input: unknown): input is string {
  if (typeof input !== 'string') throw new Error(`${label}: string expected`);
  return true;
}

function astrArr(label: string, input: string[]): input is string[] {
  if (!isArrayOf('string', input)) throw new Error(`${label}: array of strings expected`);
  return true;
}
function anumArr(label: string, input: number[]): input is number[] {
  if (!isArrayOf('number', input)) throw new Error(`${label}: array of strings expected`);
  return true;
}

// TODO: some recusive type inference so it would check correct order of input/output inside rest?
// like <string, number>, <number, bytes>, <bytes, float>
type Chain = [Coder<any, any>, ...Coder<any, any>[]];
// Extract info from Coder type
type Input<F> = F extends Coder<infer T, any> ? T : never;
type Output<F> = F extends Coder<any, infer T> ? T : never;
// Generic function for arrays
type First<T> = T extends [infer U, ...any[]] ? U : never;
type Last<T> = T extends [...any[], infer U] ? U : never;
type Tail<T> = T extends [any, ...infer U] ? U : never;

type AsChain<C extends Chain, Rest = Tail<C>> = {
  // C[K] = Coder<Input<C[K]>, Input<Rest[k]>>
  [K in keyof C]: Coder<Input<C[K]>, Input<K extends keyof Rest ? Rest[K] : any>>;
};

function chain<T extends Chain & AsChain<T>>(...args: T): Coder<Input<First<T>>, Output<Last<T>>> {
  const id = (a: any) => a;
  // Wrap call in closure so JIT can inline calls
  const wrap = (a: any, b: any) => (c: any) => a(b(c));
  // Construct chain of args[-1].encode(args[-2].encode([...]))
  const encode = args.map((x) => x.encode).reduceRight(wrap, id);
  // Construct chain of args[0].decode(args[1].decode(...))
  const decode = args.map((x) => x.decode).reduce(wrap, id);
  return { encode, decode };
}

/**
 * Encodes integer radix representation to array of strings using alphabet and back.
 * Could also be array of strings.
 */
function alphabet(letters: string | string[]): Coder<number[], string[]> {
  // mapping 1 to "b"
  const lettersA = typeof letters === 'string' ? letters.split('') : letters;
  const len = lettersA.length;
  astrArr('alphabet', lettersA);

  // mapping "b" to 1
  const indexes = new Map(lettersA.map((l, i) => [l, i]));
  return {
    encode: (digits: number[]) => {
      if (!Array.isArray(digits)) throw new Error('array expected');
      return digits.map((i) => {
        if (!Number.isSafeInteger(i) || i < 0 || i >= len)
          throw new Error(
            `alphabet.encode: digit index outside alphabet "${i}". Allowed: ${letters}`
          );
        return lettersA[i]!;
      });
    },
    decode: (input: string[]): number[] => {
      if (!Array.isArray(input)) throw new Error('array expected');
      return input.map((letter) => {
        astr('alphabet.decode', letter);
        const i = indexes.get(letter);
        if (i === undefined) throw new Error(`Unknown letter: "${letter}". Allowed: ${letters}`);
        return i;
      });
    },
  };
}

function join(separator = ''): Coder<string[], string> {
  astr('join', separator);
  return {
    encode: (from) => {
      astrArr('join.decode', from);
      return from.join(separator);
    },
    decode: (to) => {
      astr('join.decode', to);
      return to.split(separator);
    },
  };
}

/**
 * Pad strings array so it has integer number of bits
 */
function padding(bits: number, chr = '='): Coder<string[], string[]> {
  assertNumber(bits);
  astr('padding', chr);
  return {
    encode(data: string[]): string[] {
      astrArr('padding.encode', data);
      while ((data.length * bits) % 8) data.push(chr);
      return data;
    },
    decode(input: string[]): string[] {
      astrArr('padding.decode', input);
      let end = input.length;
      if ((end * bits) % 8)
        throw new Error('padding: invalid, string should have whole number of bytes');
      for (; end > 0 && input[end - 1] === chr; end--) {
        const last = end - 1;
        const byte = last * bits;
        if (byte % 8 === 0) throw new Error('padding: invalid, string has too much padding');
      }
      return input.slice(0, end);
    },
  };
}

function normalize<T>(fn: (val: T) => T): Coder<T, T> {
  afn(fn);
  return { encode: (from: T) => from, decode: (to: T) => fn(to) };
}

/**
 * Slow: O(n^2) time complexity
 */
function convertRadix(data: number[], from: number, to: number): number[] {
  // base 1 is impossible
  if (from < 2) throw new Error(`convertRadix: wrong from=${from}, base cannot be less than 2`);
  if (to < 2) throw new Error(`convertRadix: wrong to=${to}, base cannot be less than 2`);
  if (!Array.isArray(data)) throw new Error('convertRadix: data should be array');
  if (!data.length) return [];
  let pos = 0;
  const res = [];
  const digits = Array.from(data);
  digits.forEach((d) => {
    assertNumber(d);
    if (d < 0 || d >= from) throw new Error(`Wrong integer: ${d}`);
  });
  const dlen = digits.length;
  while (true) {
    let carry = 0;
    let done = true;
    for (let i = pos; i < dlen; i++) {
      const digit = digits[i]!;
      const digitBase = from * carry + digit;
      if (
        !Number.isSafeInteger(digitBase) ||
        (from * carry) / from !== carry ||
        digitBase - digit !== from * carry
      ) {
        throw new Error('convertRadix: carry overflow');
      }
      let div = digitBase / to;
      carry = digitBase % to;
      const rounded = Math.floor(div);
      digits[i] = rounded;
      if (!Number.isSafeInteger(rounded) || rounded * to + carry !== digitBase)
        throw new Error('convertRadix: carry overflow');
      if (!done) continue;
      else if (!rounded) pos = i;
      else done = false;
    }
    res.push(carry);
    if (done) break;
  }
  for (let i = 0; i < data.length - 1 && data[i] === 0; i++) res.push(0);
  return res.reverse();
}

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
const radix2carry = /*@__NO_SIDE_EFFECTS__ */ (from: number, to: number) =>
  from + (to - gcd(from, to));
const powers: number[] = /* @__PURE__ */ (() => {
  let res = [];
  for (let i = 0; i < 40; i++) res.push(2 ** i);
  return res;
})();
/**
 * Implemented with numbers, because BigInt is 5x slower
 */
function convertRadix2(data: number[], from: number, to: number, padding: boolean): number[] {
  if (!Array.isArray(data)) throw new Error('convertRadix2: data should be array');
  if (from <= 0 || from > 32) throw new Error(`convertRadix2: wrong from=${from}`);
  if (to <= 0 || to > 32) throw new Error(`convertRadix2: wrong to=${to}`);
  if (radix2carry(from, to) > 32) {
    throw new Error(
      `convertRadix2: carry overflow from=${from} to=${to} carryBits=${radix2carry(from, to)}`
    );
  }
  let carry = 0;
  let pos = 0; // bitwise position in current element
  const max = powers[from]!;
  const mask = powers[to]! - 1;
  const res: number[] = [];
  for (const n of data) {
    assertNumber(n);
    if (n >= max) throw new Error(`convertRadix2: invalid data word=${n} from=${from}`);
    carry = (carry << from) | n;
    if (pos + from > 32) throw new Error(`convertRadix2: carry overflow pos=${pos} from=${from}`);
    pos += from;
    for (; pos >= to; pos -= to) res.push(((carry >> (pos - to)) & mask) >>> 0);
    const pow = powers[pos];
    if (pow === undefined) throw new Error('invalid carry');
    carry &= pow - 1; // clean carry, otherwise it will cause overflow
  }
  carry = (carry << (to - pos)) & mask;
  if (!padding && pos >= from) throw new Error('Excess padding');
  if (!padding && carry > 0) throw new Error(`Non-zero padding: ${carry}`);
  if (padding && pos > 0) res.push(carry >>> 0);
  return res;
}

function radix(num: number): Coder<Uint8Array, number[]> {
  assertNumber(num);
  const _256 = 2 ** 8;
  return {
    encode: (bytes: Uint8Array) => {
      if (!isBytes(bytes)) throw new Error('radix.encode input should be Uint8Array');
      return convertRadix(Array.from(bytes), _256, num);
    },
    decode: (digits: number[]) => {
      anumArr('radix.decode', digits);
      return Uint8Array.from(convertRadix(digits, num, _256));
    },
  };
}

/**
 * If both bases are power of same number (like `2**8 <-> 2**64`),
 * there is a linear algorithm. For now we have implementation for power-of-two bases only.
 */
function radix2(bits: number, revPadding = false): Coder<Uint8Array, number[]> {
  assertNumber(bits);
  if (bits <= 0 || bits > 32) throw new Error('radix2: bits should be in (0..32]');
  if (radix2carry(8, bits) > 32 || radix2carry(bits, 8) > 32)
    throw new Error('radix2: carry overflow');
  return {
    encode: (bytes: Uint8Array) => {
      if (!isBytes(bytes)) throw new Error('radix2.encode input should be Uint8Array');
      return convertRadix2(Array.from(bytes), 8, bits, !revPadding);
    },
    decode: (digits: number[]) => {
      anumArr('radix2.decode', digits);
      return Uint8Array.from(convertRadix2(digits, bits, 8, revPadding));
    },
  };
}

type ArgumentTypes<F extends Function> = F extends (...args: infer A) => any ? A : never;
function unsafeWrapper<T extends (...args: any) => any>(fn: T) {
  afn(fn);
  return function (...args: ArgumentTypes<T>): ReturnType<T> | void {
    try {
      return fn.apply(null, args);
    } catch (e) {}
  };
}

function checksum(
  len: number,
  fn: (data: Uint8Array) => Uint8Array
): Coder<Uint8Array, Uint8Array> {
  assertNumber(len);
  afn(fn);
  return {
    encode(data: Uint8Array) {
      if (!isBytes(data)) throw new Error('checksum.encode: input should be Uint8Array');
      const checksum = fn(data).slice(0, len);
      const res = new Uint8Array(data.length + len);
      res.set(data);
      res.set(checksum, data.length);
      return res;
    },
    decode(data: Uint8Array) {
      if (!isBytes(data)) throw new Error('checksum.decode: input should be Uint8Array');
      const payload = data.slice(0, -len);
      const newChecksum = fn(payload).slice(0, len);
      const oldChecksum = data.slice(-len);
      for (let i = 0; i < len; i++)
        if (newChecksum[i] !== oldChecksum[i]) throw new Error('Invalid checksum');
      return payload;
    },
  };
}

// prettier-ignore
export const utils = {
  alphabet, chain, checksum, convertRadix, convertRadix2, radix, radix2, join, padding,
};

// RFC 4648 aka RFC 3548
// ---------------------

/**
 * base16 encoding.
 */
export const base16: BytesCoder = /* @__PURE__ */ chain(
  radix2(4),
  alphabet('0123456789ABCDEF'),
  join('')
);
export const base32: BytesCoder = /* @__PURE__ */ chain(
  radix2(5),
  alphabet('ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'),
  padding(5),
  join('')
);
export const base32nopad: BytesCoder = /* @__PURE__ */ chain(
  radix2(5),
  alphabet('ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'),
  join('')
);
export const base32hex: BytesCoder = /* @__PURE__ */ chain(
  radix2(5),
  alphabet('0123456789ABCDEFGHIJKLMNOPQRSTUV'),
  padding(5),
  join('')
);
export const base32hexnopad: BytesCoder = /* @__PURE__ */ chain(
  radix2(5),
  alphabet('0123456789ABCDEFGHIJKLMNOPQRSTUV'),
  join('')
);
export const base32crockford: BytesCoder = /* @__PURE__ */ chain(
  radix2(5),
  alphabet('0123456789ABCDEFGHJKMNPQRSTVWXYZ'),
  join(''),
  normalize((s: string) => s.toUpperCase().replace(/O/g, '0').replace(/[IL]/g, '1'))
);
/**
 * base64 with padding. For no padding, use `base64nopad`.
 * @example
 * const b = base64.decode('A951'); // Uint8Array.from([ 3, 222, 117 ])
 * base64.encode(b); // 'A951'
 */
export const base64: BytesCoder = /* @__PURE__ */ chain(
  radix2(6),
  alphabet('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'),
  padding(6),
  join('')
);
/**
 * base64 without padding.
 */
export const base64nopad: BytesCoder = /* @__PURE__ */ chain(
  radix2(6),
  alphabet('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'),
  join('')
);
export const base64url: BytesCoder = /* @__PURE__ */ chain(
  radix2(6),
  alphabet('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'),
  padding(6),
  join('')
);
export const base64urlnopad: BytesCoder = /* @__PURE__ */ chain(
  radix2(6),
  alphabet('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'),
  join('')
);

// base58 code
// -----------
const genBase58 = (abc: string) => chain(radix(58), alphabet(abc), join(''));

/**
 * Base58: base64 without characters +, /, 0, O, I, l.
 * Quadratic (O(n^2)) - so, can't be used on large inputs.
 */
export const base58: BytesCoder = /* @__PURE__ */ genBase58(
  '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
);
export const base58flickr: BytesCoder = /* @__PURE__ */ genBase58(
  '123456789abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ'
);
export const base58xrp: BytesCoder = /* @__PURE__ */ genBase58(
  'rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz'
);

// Data len (index) -> encoded block len
const XMR_BLOCK_LEN = [0, 2, 3, 5, 6, 7, 9, 10, 11];

/**
 * XMR version of base58.
 * Done in 8-byte blocks (which equals 11 chars in decoding). Last (non-full) block padded with '1' to size in XMR_BLOCK_LEN.
 * Block encoding significantly reduces quadratic complexity of base58.
 */
export const base58xmr: BytesCoder = {
  encode(data: Uint8Array) {
    let res = '';
    for (let i = 0; i < data.length; i += 8) {
      const block = data.subarray(i, i + 8);
      res += base58.encode(block).padStart(XMR_BLOCK_LEN[block.length]!, '1');
    }
    return res;
  },
  decode(str: string) {
    let res: number[] = [];
    for (let i = 0; i < str.length; i += 11) {
      const slice = str.slice(i, i + 11);
      const blockLen = XMR_BLOCK_LEN.indexOf(slice.length);
      const block = base58.decode(slice);
      for (let j = 0; j < block.length - blockLen; j++) {
        if (block[j] !== 0) throw new Error('base58xmr: wrong padding');
      }
      res = res.concat(Array.from(block.slice(block.length - blockLen)));
    }
    return Uint8Array.from(res);
  },
};

export const createBase58check = (sha256: (data: Uint8Array) => Uint8Array): BytesCoder =>
  chain(
    checksum(4, (data) => sha256(sha256(data))),
    base58
  );

/**
 * Use `createBase58check` instead.
 * @deprecated
 */
export const base58check = createBase58check;

// Bech32 code
// -----------
export interface Bech32Decoded<Prefix extends string = string> {
  prefix: Prefix;
  words: number[];
}
export interface Bech32DecodedWithArray<Prefix extends string = string> {
  prefix: Prefix;
  words: number[];
  bytes: Uint8Array;
}

const BECH_ALPHABET: Coder<number[], string> = /* @__PURE__ */ chain(
  alphabet('qpzry9x8gf2tvdw0s3jn54khce6mua7l'),
  join('')
);

const POLYMOD_GENERATORS = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
function bech32Polymod(pre: number): number {
  const b = pre >> 25;
  let chk = (pre & 0x1ffffff) << 5;
  for (let i = 0; i < POLYMOD_GENERATORS.length; i++) {
    if (((b >> i) & 1) === 1) chk ^= POLYMOD_GENERATORS[i]!;
  }
  return chk;
}

function bechChecksum(prefix: string, words: number[], encodingConst = 1): string {
  const len = prefix.length;
  let chk = 1;
  for (let i = 0; i < len; i++) {
    const c = prefix.charCodeAt(i);
    if (c < 33 || c > 126) throw new Error(`Invalid prefix (${prefix})`);
    chk = bech32Polymod(chk) ^ (c >> 5);
  }
  chk = bech32Polymod(chk);
  for (let i = 0; i < len; i++) chk = bech32Polymod(chk) ^ (prefix.charCodeAt(i) & 0x1f);
  for (let v of words) chk = bech32Polymod(chk) ^ v;
  for (let i = 0; i < 6; i++) chk = bech32Polymod(chk);
  chk ^= encodingConst;
  return BECH_ALPHABET.encode(convertRadix2([chk % powers[30]!], 30, 5, false));
}

export interface Bech32 {
  encode<Prefix extends string>(
    prefix: Prefix,
    words: number[] | Uint8Array,
    limit?: number | false
  ): `${Lowercase<Prefix>}1${string}`;
  decode<Prefix extends string>(
    str: `${Prefix}1${string}`,
    limit?: number | false
  ): Bech32Decoded<Prefix>;
  encodeFromBytes(prefix: string, bytes: Uint8Array): string;
  decodeToBytes(str: string): Bech32DecodedWithArray;
  decodeUnsafe(str: string, limit?: number | false): void | Bech32Decoded<string>;
  fromWords(to: number[]): Uint8Array;
  fromWordsUnsafe(to: number[]): void | Uint8Array;
  toWords(from: Uint8Array): number[];
}
function genBech32(encoding: 'bech32' | 'bech32m'): Bech32 {
  const ENCODING_CONST = encoding === 'bech32' ? 1 : 0x2bc830a3;
  const _words = radix2(5);
  const fromWords = _words.decode;
  const toWords = _words.encode;
  const fromWordsUnsafe = unsafeWrapper(fromWords);

  function encode<Prefix extends string>(
    prefix: Prefix,
    words: number[] | Uint8Array,
    limit: number | false = 90
  ): `${Lowercase<Prefix>}1${string}` {
    astr('bech32.encode prefix', prefix);
    if (isBytes(words)) words = Array.from(words);
    anumArr('bech32.encode', words);
    const plen = prefix.length;
    if (plen === 0) throw new TypeError(`Invalid prefix length ${plen}`);
    const actualLength = plen + 7 + words.length;
    if (limit !== false && actualLength > limit)
      throw new TypeError(`Length ${actualLength} exceeds limit ${limit}`);
    const lowered = prefix.toLowerCase();
    const sum = bechChecksum(lowered, words, ENCODING_CONST);
    return `${lowered}1${BECH_ALPHABET.encode(words)}${sum}` as `${Lowercase<Prefix>}1${string}`;
  }

  function decode<Prefix extends string>(
    str: `${Prefix}1${string}`,
    limit?: number | false
  ): Bech32Decoded<Prefix>;
  function decode(str: string, limit?: number | false): Bech32Decoded;
  function decode(str: string, limit: number | false = 90): Bech32Decoded {
    astr('bech32.decode input', str);
    const slen = str.length;
    if (slen < 8 || (limit !== false && slen > limit))
      throw new TypeError(`Wrong string length: ${slen} (${str}). Expected (8..${limit})`);
    // don't allow mixed case
    const lowered = str.toLowerCase();
    if (str !== lowered && str !== str.toUpperCase())
      throw new Error(`String must be lowercase or uppercase`);
    const sepIndex = lowered.lastIndexOf('1');
    if (sepIndex === 0 || sepIndex === -1)
      throw new Error(`Letter "1" must be present between prefix and data only`);
    const prefix = lowered.slice(0, sepIndex);
    const data = lowered.slice(sepIndex + 1);
    if (data.length < 6) throw new Error('Data must be at least 6 characters long');
    const words = BECH_ALPHABET.decode(data).slice(0, -6);
    const sum = bechChecksum(prefix, words, ENCODING_CONST);
    if (!data.endsWith(sum)) throw new Error(`Invalid checksum in ${str}: expected "${sum}"`);
    return { prefix, words };
  }

  const decodeUnsafe = unsafeWrapper(decode);

  function decodeToBytes(str: string): Bech32DecodedWithArray {
    const { prefix, words } = decode(str, false);
    return { prefix, words, bytes: fromWords(words) };
  }

  function encodeFromBytes(prefix: string, bytes: Uint8Array) {
    return encode(prefix, toWords(bytes));
  }

  return {
    encode,
    decode,
    encodeFromBytes,
    decodeToBytes,
    decodeUnsafe,
    fromWords,
    fromWordsUnsafe,
    toWords,
  };
}

/**
 * Low-level bech32 operations. Operates on words.
 */
export const bech32: Bech32 = /* @__PURE__ */ genBech32('bech32');
export const bech32m: Bech32 = /* @__PURE__ */ genBech32('bech32m');

declare const TextEncoder: any;
declare const TextDecoder: any;

/**
 * UTF-8-to-byte decoder. Uses built-in TextDecoder / TextEncoder.
 * @example
 * const b = utf8.decode("hey"); // => new Uint8Array([ 104, 101, 121 ])
 * const str = utf8.encode(b); // "hey"
 */
export const utf8: BytesCoder = {
  encode: (data) => new TextDecoder().decode(data),
  decode: (str) => new TextEncoder().encode(str),
};

/**
 * hex string decoder.
 * @example
 * const b = hex.decode("0102ff"); // => new Uint8Array([ 1, 2, 255 ])
 * const str = hex.encode(b); // "0102ff"
 */
export const hex: BytesCoder = /* @__PURE__ */ chain(
  radix2(4),
  alphabet('0123456789abcdef'),
  join(''),
  normalize((s: string) => {
    if (typeof s !== 'string' || s.length % 2 !== 0)
      throw new TypeError(`hex.decode: expected string, got ${typeof s} with length ${s.length}`);
    return s.toLowerCase();
  })
);

// prettier-ignore
const CODERS = {
  utf8, hex, base16, base32, base64, base64url, base58, base58xmr
};
type CoderType = keyof typeof CODERS;
const coderTypeError =
  'Invalid encoding type. Available types: utf8, hex, base16, base32, base64, base64url, base58, base58xmr';

export const bytesToString = (type: CoderType, bytes: Uint8Array): string => {
  if (typeof type !== 'string' || !CODERS.hasOwnProperty(type)) throw new TypeError(coderTypeError);
  if (!isBytes(bytes)) throw new TypeError('bytesToString() expects Uint8Array');
  return CODERS[type].encode(bytes);
};
export const str = bytesToString; // as in python, but for bytes only

export const stringToBytes = (type: CoderType, str: string): Uint8Array => {
  if (!CODERS.hasOwnProperty(type)) throw new TypeError(coderTypeError);
  if (typeof str !== 'string') throw new TypeError('stringToBytes() expects string');
  return CODERS[type].decode(str);
};
export const bytes = stringToBytes;
