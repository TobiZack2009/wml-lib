/**
 * @fileoverview WASM execution tests.
 *
 * Full-pipeline: WML source → parse → validate → WAT → WASM binary
 * → instantiate → call exports → assert return values.
 *
 * These tests verify the compiler produces semantically correct WASM.
 * They require the binaryen peer dependency for WAT→WASM compilation.
 * Only basic WASM features are tested (no GC, exceptions, or SIMD).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Lexer }   from '../../src/parser/lexer.js';
import { Parser }  from '../../src/parser/parser.js';
import { validateModule } from '../../src/validator/index.js';
import { WatEmitter } from '../../src/emitter/wat.js';

let binaryen;
try {
  binaryen = (await import('binaryen')).default;
} catch {
  binaryen = null;
}

function skipIfNoBinaryen() {
  if (!binaryen) return true;
  return false;
}

const FEATURES = binaryen
  ? (binaryen.Features.MVP | binaryen.Features.MutableGlobals |
     binaryen.Features.Multivalue | binaryen.Features.ReferenceTypes |
     binaryen.Features.BulkMemory | binaryen.Features.SignExt |
     binaryen.Features.TailCall | binaryen.Features.ExceptionHandling |
     binaryen.Features.GC)
  : 0;

function compileToWasm(source) {
  const tokens  = new Lexer(source, 'test.wml').tokenize();
  const { ast, errors: parseErrors } = new Parser(tokens, 'test.wml').parse();
  const { errors: valErrors, symbols } = validateModule(ast, 'test.wml');
  const allErrors = [...parseErrors, ...valErrors].filter(e => e.severity === 'error');
  if (allErrors.length > 0) {
    throw new Error(`Compilation errors:\n${allErrors.map(e => `${e.code}: ${e.message}`).join('\n')}`);
  }
  let wat = new WatEmitter(ast, symbols).emit();
  // Binaryen does not accept the optional "then" keyword on its own line
  wat = wat.replace(/^\s*then\s*$/gm, '');
  // Binaryen does not accept (memory $Name) on load/store instructions
  wat = wat.replace(/\(memory\s+\$\w+\)/g, '');
  const mod = binaryen.parseText(wat);
  mod.setFeatures(FEATURES);
  if (!mod.validate()) {
    mod.dispose();
    throw new Error('Binaryen validation failed on generated WAT');
  }
  const wasm = mod.emitBinary();
  mod.dispose();
  return wasm;
}

async function instantiate(source) {
  const wasm = compileToWasm(source);
  const { instance } = await WebAssembly.instantiate(wasm);
  return instance.exports;
}

// ── Arithmetic ──────────────────────────────────────────────────────────────

describe('Arithmetic', { skip: skipIfNoBinaryen() }, () => {
  test('i32 add', async () => {
    const { add } = await instantiate('@export add(a: i32, b: i32): i32 { return a + b; }');
    assert.equal(add(3, 4), 7);
    assert.equal(add(0, 0), 0);
    assert.equal(add(-5, 5), 0);
  });

  test('i32 sub', async () => {
    const { sub } = await instantiate('@export sub(a: i32, b: i32): i32 { return a - b; }');
    assert.equal(sub(10, 3), 7);
    assert.equal(sub(0, 5), -5);
  });

  test('i32 mul', async () => {
    const { mul } = await instantiate('@export mul(a: i32, b: i32): i32 { return a * b; }');
    assert.equal(mul(6, 7), 42);
    assert.equal(mul(-2, 3), -6);
  });

  test('i32 signed div', async () => {
    const { div } = await instantiate('@export div(a: i32, b: i32): i32 { return a /s b; }');
    assert.equal(div(10, 3), 3);
    assert.equal(div(-10, 3), -3);
  });

  test('i32 unsigned div', async () => {
    const { div } = await instantiate('@export div(a: u32, b: u32): u32 { return a /u b; }');
    assert.equal(div(10, 3), 3);
  });

  test('i32 signed rem', async () => {
    const { rem } = await instantiate('@export rem(a: i32, b: i32): i32 { return a %s b; }');
    assert.equal(rem(10, 3), 1);
    assert.equal(rem(-10, 3), -1);
  });

  test('i32 unsigned rem', async () => {
    const { rem } = await instantiate('@export rem(a: u32, b: u32): u32 { return a %u b; }');
    assert.equal(rem(10, 3), 1);
  });
});

// ── Bitwise and shift ───────────────────────────────────────────────────────

describe('Bitwise operations', { skip: skipIfNoBinaryen() }, () => {
  test('i32 and', async () => {
    const { bwAnd } = await instantiate('@export bwAnd(a: i32, b: i32): i32 { return a & b; }');
    assert.equal(bwAnd(0xFF, 0x0F), 0x0F);
    assert.equal(bwAnd(0xFF, 0xF0), 0xF0);
  });

  test('i32 or', async () => {
    const { bwOr } = await instantiate('@export bwOr(a: i32, b: i32): i32 { return a | b; }');
    assert.equal(bwOr(0xF0, 0x0F), 0xFF);
  });

  test('i32 xor', async () => {
    const { bwXor } = await instantiate('@export bwXor(a: i32, b: i32): i32 { return a ^ b; }');
    assert.equal(bwXor(0xFF, 0xFF), 0);
    assert.equal(bwXor(0xF0, 0x0F), 0xFF);
  });

  test('i32 not', async () => {
    const { bwNot } = await instantiate('@export bwNot(a: i32): i32 { return ~a; }');
    assert.equal(bwNot(0), -1);
    assert.equal(bwNot(-1), 0);
  });

  test('i32 logical not', async () => {
    const { lNot } = await instantiate('@export lNot(a: i32): i32 { return !a; }');
    assert.equal(lNot(0), 1);
    assert.equal(lNot(1), 0);
    assert.equal(lNot(42), 0);
  });

  test('i32 shift left', async () => {
    const { shl } = await instantiate('@export shl(a: i32, b: i32): i32 { return a << b; }');
    assert.equal(shl(1, 3), 8);
    assert.equal(shl(2, 2), 8);
  });

  test('i32 signed shift right', async () => {
    const { shr } = await instantiate('@export shr(a: i32, b: i32): i32 { return a >>s b; }');
    assert.equal(shr(8, 2), 2);
    assert.equal(shr(-8, 2), -2);
  });

  test('i32 unsigned shift right', async () => {
    const { shr } = await instantiate('@export shr(a: u32, b: u32): u32 { return a >>u b; }');
    assert.equal(shr(8, 2), 2);
  });
});

// ── Comparisons ─────────────────────────────────────────────────────────────

describe('Comparisons', { skip: skipIfNoBinaryen() }, () => {
  test('i32 eq', async () => {
    const { eq } = await instantiate('@export eq(a: i32, b: i32): i32 { return a == b; }');
    assert.equal(eq(5, 5), 1);
    assert.equal(eq(5, 6), 0);
  });

  test('i32 ne', async () => {
    const { ne } = await instantiate('@export ne(a: i32, b: i32): i32 { return a != b; }');
    assert.equal(ne(5, 5), 0);
    assert.equal(ne(5, 6), 1);
  });

  test('i32 lt', async () => {
    const { lt } = await instantiate('@export lt(a: i32, b: i32): i32 { return a < b; }');
    assert.equal(lt(3, 5), 1);
    assert.equal(lt(5, 3), 0);
    assert.equal(lt(3, 3), 0);
  });

  test('i32 gt', async () => {
    const { gt } = await instantiate('@export gt(a: i32, b: i32): i32 { return a > b; }');
    assert.equal(gt(5, 3), 1);
    assert.equal(gt(3, 5), 0);
  });

  test('i32 le', async () => {
    const { le } = await instantiate('@export le(a: i32, b: i32): i32 { return a <= b; }');
    assert.equal(le(3, 5), 1);
    assert.equal(le(3, 3), 1);
    assert.equal(le(5, 3), 0);
  });

  test('i32 ge', async () => {
    const { ge } = await instantiate('@export ge(a: i32, b: i32): i32 { return a >= b; }');
    assert.equal(ge(5, 3), 1);
    assert.equal(ge(3, 3), 1);
    assert.equal(ge(3, 5), 0);
  });
});

// ── Control flow and recursion ──────────────────────────────────────────────

describe('Control flow and recursion', { skip: skipIfNoBinaryen() }, () => {
  test('factorial recursive', async () => {
    const { factorial } = await instantiate(`
      @export factorial(n: i32): i32 {
        if (n <= 1) { return 1; }
        return n * factorial(n - 1);
      }
    `);
    assert.equal(factorial(0), 1);
    assert.equal(factorial(1), 1);
    assert.equal(factorial(5), 120);
    assert.equal(factorial(10), 3628800);
  });

  test('fibonacci iterative', async () => {
    const { fib } = await instantiate(`
      @export fib(n: i32): i32 {
        local a: i32 = 0;
        local b: i32 = 1;
        local i: i32 = 0;
        local tmp: i32;
        loop {
          { 'top
            break if (i >= n);
            tmp = a + b;
            a = b;
            b = tmp;
            i += 1;
            goto 'top if (0);
          }
        }
        return a;
      }
    `);
    assert.equal(fib(0), 0);
    assert.equal(fib(1), 1);
    assert.equal(fib(10), 55);
    assert.equal(fib(20), 6765);
  });

  test('gcd', async () => {
    const { gcd } = await instantiate(`
      @export gcd(a: i32, b: i32): i32 {
        local tmp: i32;
        loop {
          { 'top
            break if (b == 0);
            tmp = b;
            b = a %s b;
            a = tmp;
            goto 'top if (0);
          }
        }
        return a;
      }
    `);
    assert.equal(gcd(12, 8), 4);
    assert.equal(gcd(54, 24), 6);
    assert.equal(gcd(7, 13), 1);
    assert.equal(gcd(100, 0), 100);
  });
});

// ── Algorithms ──────────────────────────────────────────────────────────────

describe('Algorithm programs', { skip: skipIfNoBinaryen() }, () => {
  test('is_prime', async () => {
    const { isPrime } = await instantiate(`
      @export isPrime(n: i32): i32 {
        local i: i32;
        if (n <= 1) { return 0; }
        if (n == 2) { return 1; }
        i = 2;
        loop {
          { 'top
            if (i * i > n) { return 1; }
            if (n %s i == 0) { return 0; }
            i += 1;
            goto 'top if (0);
          }
        }
        return 1;
      }
    `);
    assert.equal(isPrime(1), 0);
    assert.equal(isPrime(2), 1);
    assert.equal(isPrime(3), 1);
    assert.equal(isPrime(4), 0);
    assert.equal(isPrime(17), 1);
    assert.equal(isPrime(97), 1);
  });

  test('nth_prime', async () => {
    const { nthPrime } = await instantiate(`
      @export nthPrime(n: i32): i32 {
        local count: i32 = 0;
        local num: i32 = 2;
        local i: i32;
        local isPrime: i32;
        loop {
          { 'outer
            break if (count >= n);
            isPrime = 1;
            i = 2;
            loop {
              { 'inner
                if (i * i > num) { break; }
                if (num %s i == 0) { isPrime = 0; break; }
                i += 1;
                goto 'inner if (0);
              }
            }
            if (isPrime) {
              count += 1;
              if (count >= n) { return num; }
            }
            num += 1;
            goto 'outer if (0);
          }
        }
        return 0;
      }
    `);
    assert.equal(nthPrime(1), 2);
    assert.equal(nthPrime(2), 3);
    assert.equal(nthPrime(5), 11);
    assert.equal(nthPrime(10), 29);
  });

  test('collatz steps', async () => {
    const { collatz } = await instantiate(`
      @export collatz(n: i32): i32 {
        local steps: i32 = 0;
        loop {
          { 'top
            break if (n <= 1);
            if (n %s 2 == 0) {
              n = n /s 2;
            } else {
              n = 3 * n + 1;
            }
            steps += 1;
            goto 'top if (0);
          }
        }
        return steps;
      }
    `);
    assert.equal(collatz(1), 0);
    assert.equal(collatz(6), 8);
  });

  test('integer square root', async () => {
    const { isqrt } = await instantiate(`
      @export isqrt(n: i32): i32 {
        local x: i32 = n;
        local y: i32 = (n + 1) /s 2;
        loop {
          { 'loop
            break if (y >= x);
            x = y;
            y = (x + n /s x) /s 2;
            goto 'loop if (0);
          }
        }
        return x;
      }
    `);
    assert.equal(isqrt(0), 0);
    assert.equal(isqrt(1), 1);
    assert.equal(isqrt(16), 4);
    assert.equal(isqrt(25), 5);
    assert.equal(isqrt(100), 10);
  });

  test('absolute value', async () => {
    const { abs } = await instantiate(`
      @export abs(n: i32): i32 {
        if (n < 0) { return -n; }
        return n;
      }
    `);
    assert.equal(abs(5), 5);
    assert.equal(abs(-5), 5);
    assert.equal(abs(0), 0);
  });

  test('popcount via loop', async () => {
    const { popcount } = await instantiate(`
      @export popcount(n: i32): i32 {
        local count: i32 = 0;
        loop {
          { 'top
            break if (n == 0);
            count += n & 1;
            n = n >>u 1;
            goto 'top if (0);
          }
        }
        return count;
      }
    `);
    assert.equal(popcount(0), 0);
    assert.equal(popcount(255), 8);
    assert.equal(popcount(1), 1);
    assert.equal(popcount(1024), 1);
  });

  test('min and max functions', async () => {
    const { min, max } = await instantiate(`
      @export min(a: i32, b: i32): i32 {
        if (a < b) { return a; }
        return b;
      }
      @export max(a: i32, b: i32): i32 {
        if (a > b) { return a; }
        return b;
      }
    `);
    assert.equal(min(3, 7), 3);
    assert.equal(min(7, 3), 3);
    assert.equal(max(3, 7), 7);
    assert.equal(max(7, 3), 7);
  });

  test('sum of first n numbers', async () => {
    const { sumN } = await instantiate(`
      @export sumN(n: i32): i32 {
        local sum: i32 = 0;
        local i: i32 = 1;
        loop {
          { 'top
            break if (i > n);
            sum += i;
            i += 1;
            goto 'top if (0);
          }
        }
        return sum;
      }
    `);
    assert.equal(sumN(0), 0);
    assert.equal(sumN(1), 1);
    assert.equal(sumN(10), 55);
    assert.equal(sumN(100), 5050);
  });
});

// ── Memory operations ────────────────────────────────────────────────────────

describe('Memory operations', { skip: skipIfNoBinaryen() }, () => {
  test('i32 store/load', async () => {
    const { write, read } = await instantiate(`
      memory Mem = 1;
      @export write(ptr: i32, val: i32): () { Mem.store<i32>(ptr, val); }
      @export read(ptr: i32): i32 { return Mem.load<i32>(ptr); }
    `);
    write(0, 42);
    assert.equal(read(0), 42);
    write(4, 100);
    assert.equal(read(4), 100);
  });

  test('u8 store/load', async () => {
    const { write, read } = await instantiate(`
      memory Mem = 1;
      @export write(ptr: i32, val: i32): () { Mem.store<u8>(ptr, val); }
      @export read(ptr: i32): i32 { return Mem.load<u8>(ptr); }
    `);
    write(0, 255);
    assert.equal(read(0), 255);
    write(0, 256);
    assert.equal(read(0), 0);
  });

  test('grow and size', async () => {
    const { grow, size } = await instantiate(`
      memory Mem = 1;
      @export grow(n: i32): i32 { return Mem.grow(n); }
      @export size(): i32 { return Mem.size(); }
    `);
    assert.equal(size(), 1);
    const oldSize = grow(2);
    assert.equal(oldSize, 1);
    assert.equal(size(), 3);
  });
});

// ── Short-circuit operators ─────────────────────────────────────────────────

describe('Short-circuit operators', { skip: skipIfNoBinaryen() }, () => {
  test('&& returns first falsy or last truthy', async () => {
    const { and } = await instantiate(`
      @export and(a: i32, b: i32): i32 { return a && b; }
    `);
    assert.equal(and(0, 0), 0);
    assert.equal(and(0, 1), 0);
    assert.equal(and(1, 0), 0);
    assert.equal(and(1, 1), 1);
  });

  test('|| returns first truthy or last falsy', async () => {
    const { or } = await instantiate(`
      @export or(a: i32, b: i32): i32 { return a || b; }
    `);
    assert.equal(or(0, 0), 0);
    assert.equal(or(0, 1), 1);
    assert.equal(or(1, 0), 1);
    assert.equal(or(1, 1), 1);
  });
});

// ── Globals ─────────────────────────────────────────────────────────────────

describe('Global variables', { skip: skipIfNoBinaryen() }, () => {
  test('immutable global', async () => {
    const { getVal } = await instantiate(`
      global VAL: i32 = 42;
      @export getVal(): i32 { return VAL; }
    `);
    assert.equal(getVal(), 42);
  });

  test('mutable global increment', async () => {
    const { inc, get } = await instantiate(`
      global mut counter: i32 = 0;
      @export inc(): () { counter += 1; }
      @export get(): i32 { return counter; }
    `);
    assert.equal(get(), 0);
    inc();
    assert.equal(get(), 1);
    inc();
    inc();
    assert.equal(get(), 3);
  });
});

// ── Multi-return ────────────────────────────────────────────────────────────

describe('Multi-return', { skip: skipIfNoBinaryen() }, () => {
  test('function returning two i32 values', async () => {
    const { divmod } = await instantiate(`
      @export divmod(a: i32, b: i32): (i32, i32) {
        return (a /s b, a %s b);
      }
    `);
    const result = divmod(10, 3);
    assert.equal(result[0], 3);
    assert.equal(result[1], 1);
  });
});

// ── Conditionals ────────────────────────────────────────────────────────────

describe('Conditionals', { skip: skipIfNoBinaryen() }, () => {
  test('sign function with if-else chain', async () => {
    const { sign } = await instantiate(`
      @export sign(n: i32): i32 {
        if (n > 0) { return 1; }
        if (n < 0) { return -1; }
        return 0;
      }
    `);
    assert.equal(sign(5), 1);
    assert.equal(sign(-3), -1);
    assert.equal(sign(0), 0);
  });
});

// ── Nested loops ────────────────────────────────────────────────────────────

describe('Nested loops', { skip: skipIfNoBinaryen() }, () => {
  test('nested loop counter', async () => {
    const { count } = await instantiate(`
      @export count(a: i32, b: i32): i32 {
        local result: i32 = 0;
        local i: i32 = 0;
        local j: i32;
        loop {
          { 'outer
            break if (i >= a);
            j = 0;
            loop {
              { 'inner
                break if (j >= b);
                result += 1;
                j += 1;
                goto 'inner if (0);
              }
            }
            i += 1;
            goto 'outer if (0);
          }
        }
        return result;
      }
    `);
    assert.equal(count(3, 4), 12);
  });
});

// ── Float operations ────────────────────────────────────────────────────────

describe('Float operations', { skip: skipIfNoBinaryen() }, () => {
  test('f64 add and sub', async () => {
    const { add, sub } = await instantiate(`
      @export add(a: f64, b: f64): f64 { return a + b; }
      @export sub(a: f64, b: f64): f64 { return a - b; }
    `);
    assert.equal(add(3.14, 2.86), 6.0);
    assert.equal(sub(10.5, 3.2), 7.3);
  });
});
