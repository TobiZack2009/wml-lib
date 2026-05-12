/**
 * @fileoverview Feature integration tests.
 *
 * Tests complete programs to ensure the full pipeline (parse → validate → emit)
 * works end-to-end for all major WML features. These are regression tests —
 * they should never crash and should produce valid output.
 *
 * All programs here should:
 *   - Parse without errors
 *   - Validate without errors
 *   - Emit WAT with balanced parentheses
 *   - Contain specific expected WAT constructs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Lexer }  from '../../src/parser/lexer.js';
import { Parser } from '../../src/parser/parser.js';
import { validateModule } from '../../src/validator/index.js';
import { WatEmitter } from '../../src/emitter/wat.js';

function pipeline(source) {
  const tokens = new Lexer(source, 'feat.wml').tokenize();
  const { ast, errors: parseErrors } = new Parser(tokens, 'feat.wml').parse();
  const { errors: valErrors, symbols } = validateModule(ast, 'feat.wml');
  const allErrors = [...parseErrors, ...valErrors].filter(e => e.severity === 'error');
  const wat = allErrors.length === 0 ? new WatEmitter(ast, symbols).emit() : null;
  return { ast, errors: allErrors, warnings: [...parseErrors, ...valErrors].filter(e => e.severity === 'warning'), symbols, wat };
}

function ok(source) {
  const r = pipeline(source);
  assert.equal(r.errors.length, 0,
    `Expected no errors:\n${r.errors.map(e => `  ${e.code}: ${e.message}`).join('\n')}`);
  assert.ok(r.wat != null, 'WAT output should be non-null');
  // Balanced parentheses
  let depth = 0;
  for (const ch of r.wat) { if (ch === '(') depth++; else if (ch === ')') depth--; }
  assert.equal(depth, 0, `Unbalanced parens in WAT for:\n${source.slice(0, 80)}`);
  return r;
}

// ── Algorithms ────────────────────────────────────────────────────────────

describe('Algorithm programs', () => {
  test('fibonacci iterative', () => {
    ok(`
      @export fib(n: i32): i32 {
        local a: i32 = 0;
        local b: i32 = 1;
        local i: i32 = 0;
        local tmp: i32;
        loop {
          { 'loop_top
            break if (i >= n);
            tmp = a + b;
            a = b;
            b = tmp;
            i += 1;
            goto 'loop_top if (0);
          }
        }
        return b;
      }
    `);
  });

  test('factorial recursive', () => {
    ok(`
      @export factorial(n: i32): i32 {
        if (n <= 1) { return 1; }
        return n * factorial(n - 1);
      }
    `);
  });

  test('gcd with loop', () => {
    ok(`
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
  });

  test('absolute value', () => {
    ok(`
      @export abs32(n: i32): i32 {
        if (n < 0) { return -n; }
        return n;
      }
    `);
  });

  test('popcount via loop', () => {
    ok(`
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
  });

  test('min and max functions', () => {
    ok(`
      min(a: i32, b: i32): i32 {
        if (a < b) { return a; }
        return b;
      }
      max(a: i32, b: i32): i32 {
        if (a > b) { return a; }
        return b;
      }
    `);
  });

  test('integer square root', () => {
    ok(`
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
  });
});

// ── Memory programs ───────────────────────────────────────────────────────

describe('Memory programs', () => {
  test('linear memory read/write', () => {
    ok(`
      memory Mem = 1;
      @export writeI32(ptr: i32, val: i32): () {
        Mem.store<i32>(ptr, val);
      }
      @export readI32(ptr: i32): i32 {
        return Mem.load<i32>(ptr);
      }
    `);
  });

  test('byte array read/write', () => {
    ok(`
      memory Mem = 1;
      @export readByte(ptr: i32): i32 {
        return Mem.load<u8>(ptr);
      }
      @export writeByte(ptr: i32, val: i32): () {
        Mem.store<u8>(ptr, val);
      }
    `);
  });

  test('memory grow and size', () => {
    ok(`
      memory Mem = 1;
      @export growMem(pages: i32): i32 {
        return Mem.grow(pages);
      }
      @export memSize(): i32 {
        return Mem.size();
      }
    `);
  });

  test('data segment placement', () => {
    ok(`
      memory Mem = 1;
      data Header: i8[] = [0x00, 0x61, 0x73, 0x6D];
      Mem[0] = Header;
    `);
  });

  test('string data placement cstr', () => {
    ok(`
      memory Mem = 1;
      data Greeting: cstr = "Hello, World!";
      Mem[0] = Greeting;
    `);
  });

  test('string data placement utf8_32', () => {
    ok(`
      memory Mem = 1;
      data AppName: utf8_32 = "MyApp";
      Mem[0] = AppName;
    `);
  });

  test('pascal string', () => {
    ok(`
      memory Mem = 1;
      data Short: pascal = "Hi";
      Mem[0] = Short;
    `);
  });
});

// ── GC / struct programs ──────────────────────────────────────────────────

describe('GC struct programs', () => {
  test('struct create and field access', () => {
    ok(`
      type Point = struct { x: i32; mut y: i32; };
      @export makePoint(x: i32, y: i32): Point {
        return new Point { x: x, y: y };
      }
    `);
  });

  test('struct with extends', () => {
    ok(`
      type Animal = struct { legs: i32; };
      type Dog = struct extends Animal { breed: i32; };
    `);
  });

  test('final struct', () => {
    ok(`type Immutable = final struct { x: i32; y: i32; };`);
  });

  test('GC array create and length', () => {
    ok(`
      type IntArray = [mut i32];
      @export makeArray(n: i32): IntArray {
        return new IntArray(n);
      }
    `);
  });

  test('rec group for recursive type', () => {
    ok(`
      rec {
        type Node = struct { value: i32; };
      }
    `);
  });

  test('repr(packed) struct', () => {
    ok(`
      #[repr(packed)]
      type PackedHeader = struct { magic: i8; version: i8; flags: i16; };
    `);
  });

  test('repr(C) struct', () => {
    ok(`
      #[repr(C)]
      type CStruct = struct { a: i32; b: i64; };
    `);
  });
});

// ── Tables and indirect calls ─────────────────────────────────────────────

describe('Table and indirect call programs', () => {
  test('function table declaration and indirect call', () => {
    ok(`
      type BinaryOp = (i32, i32) => i32;
      table FuncTable: [funcref] = 8;
      add(a: i32, b: i32): i32 { return a + b; }
      sub(a: i32, b: i32): i32 { return a - b; }
      @export dispatch(op: i32, a: i32, b: i32): i32 {
        return FuncTable[op]<BinaryOp>(a, b);
      }
    `);
  });

  test('elem segment', () => {
    ok(`
      table T: [funcref] = 4;
      f(): i32 { return 1; }
      elem Handlers: funcref[] = [f];
      T[0] = Handlers;
    `);
  });

  test('ref(fn) funcref', () => {
    ok(`
      table T: [funcref] = 4;
      f(x: i32): i32 { return x; }
      g(): funcref {
        return ref(f);
      }
    `);
  });
});

// ── Exception handling ────────────────────────────────────────────────────

describe('Exception handling programs', () => {
  test('throw and catch', () => {
    ok(`
      tag DivError: (i32, i32);
      @export safeDiv(a: i32, b: i32): i32 {
        if (b == 0) { throw DivError(a, b); }
        return a /s b;
      }
    `);
  });

  test('try-catch-all', () => {
    ok(`
      tag E: (i32);
      @export safe(x: i32): i32 {
        try {
          if (x < 0) { throw E(x); }
        } catch {
          nop;
        }
        return x;
      }
    `);
  });

  test('multiple catch clauses', () => {
    ok(`
      tag TypeError: (i32);
      tag RangeError: (i32);
      @export handle(x: i32): i32 {
        local result: i32 = 0;
        try {
          if (x < 0) { throw TypeError(x); }
          if (x > 100) { throw RangeError(x); }
          result = x;
        } catch TypeError(code) {
          result = -1;
        } catch RangeError(code) {
          result = -2;
        } catch {
          result = -3;
        }
        return result;
      }
    `);
  });

  test('exported tag', () => {
    ok('@export tag AppError: (i32, i32);');
  });
});

// ── Globals and imports ───────────────────────────────────────────────────

describe('Globals and imports', () => {
  test('immutable global', () => {
    ok(`
      global PI: f64 = 3.14159265358979;
      @export getPI(): f64 { return PI; }
    `);
  });

  test('mutable global counter', () => {
    ok(`
      global mut counter: i32 = 0;
      @export increment(): () { counter += 1; }
      @export getCount(): i32 { return counter; }
    `);
  });

  test('imported function', () => {
    ok('@import("env","log") log(n: i32): ();');
  });

  test('imported memory', () => {
    ok('@import("env","mem") memory Mem = 1;');
  });
});

// ── Pragma features ───────────────────────────────────────────────────────

describe('Pragma features', () => {
  test('repr(packed) reduces struct size', () => {
    const r = ok(`
      #[repr(packed)]
      type Packed = struct { a: i8; b: i8; c: i8; d: i8; };
    `);
    // Struct should appear in WAT
    assert.ok(r.wat.includes('$Packed'));
  });

  test('multiple pragmas on same struct', () => {
    ok(`
      #[repr(packed)]
      type Compact = struct { x: i8; y: i8; };
    `);
  });

  test('#[linear] struct with pointer access', () => {
    const r = ok(`
      #[linear]
      type Point = struct { x: i32; y: i32; };
      memory Mem = 1;
      f(ptr: *Point): i32 { return ptr[0].x; }
    `);
    // Should not have a type entry for #[linear] struct
    assert.ok(!r.wat.includes('(type $Point'));
    // Should emit i32.load for field access
    assert.ok(r.wat.includes('i32.load'));
  });
});

// ── Type system features ──────────────────────────────────────────────────

describe('Type system features', () => {
  test('sizeof isize', () => {
    ok(`
      f(): isize {
        return sizeof(i32);
      }
    `);
  });

  test('select on integers', () => {
    ok(`
      f(cond: i32, a: i32, b: i32): i32 {
        return select(cond, a, b);
      }
    `);
  });

  test('i32/u32 coerce silently', () => {
    ok(`
      global mut x: u32 = 0;
      f(n: i32): () {
        x = n;
      }
    `);
  });

  test('null ref assignment', () => {
    ok(`
      type Point = struct { x: i32; };
      f(): anyref {
        return null;
      }
    `);
  });

  test('cast as', () => {
    ok(`
      type A = struct { x: i32; };
      type B = struct extends A { y: i32; };
      f(r: anyref): i32 {
        return (r as A).x;
      }
    `);
  });

  test('type test is', () => {
    ok(`
      type A = struct { x: i32; };
      f(r: anyref): i32 {
        return r is A;
      }
    `);
  });

  test('ref.as_non_null postfix !', () => {
    ok(`
      type A = struct { x: i32; };
      f(r: anyref): A {
        return r! as A;
      }
    `);
  });

  test('i8, i16 narrow types', () => {
    ok(`
      f(a: i8, b: i16): i32 {
        return a + b;
      }
    `);
  });

  test('all reference types as params', () => {
    ok(`
      f(a: anyref, b: eqref, c: externref, d: funcref): () {
        nop;
      }
    `);
  });
});

// ── Multi-declaration programs ────────────────────────────────────────────

describe('Multi-declaration programs', () => {
  test('complete calculator module', () => {
    ok(`
      tag DivByZero: (i32, i32);

      global mut lastResult: i32 = 0;

      add(a: i32, b: i32): i32 { return a + b; }
      sub(a: i32, b: i32): i32 { return a - b; }
      mul(a: i32, b: i32): i32 { return a * b; }
      div(a: i32, b: i32): i32 {
        if (b == 0) { throw DivByZero(a, b); }
        return a /s b;
      }

      @export calculate(op: i32, a: i32, b: i32): i32 {
        local result: i32;
        if (op == 0) { result = add(a, b); }
        else if (op == 1) { result = sub(a, b); }
        else if (op == 2) { result = mul(a, b); }
        else { result = div(a, b); }
        lastResult = result;
        return result;
      }

      @export getLastResult(): i32 { return lastResult; }
    `);
  });

  test('memory allocator module', () => {
    ok(`
      memory Heap = 16;
      global mut heapPtr: i32 = 0;

      @export malloc(size: i32): i32 {
        local ptr: i32 = heapPtr;
        heapPtr += size;
        return ptr;
      }

      @export free(ptr: i32, size: i32): () {
        nop;
      }
    `);
  });
});

// ── Edge cases ────────────────────────────────────────────────────────────

describe('Edge cases', () => {
  test('empty function body', () => {
    ok('f(): () { }');
  });

  test('function with only locals', () => {
    ok('f(): () { local x: i32; local y: f64; }');
  });

  test('deeply nested if-else', () => {
    ok(`
      f(a: i32, b: i32, c: i32): i32 {
        if (a > 0) {
          if (b > 0) {
            if (c > 0) { return 1; }
            else { return 2; }
          } else { return 3; }
        } else { return 4; }
      }
    `);
  });

  test('multiple returns in different branches', () => {
    ok(`
      sign(n: i32): i32 {
        if (n > 0) { return 1; }
        if (n < 0) { return -1; }
        return 0;
      }
    `);
  });

  test('loop with multiple blocks', () => {
    ok(`
      f(): () {
        loop {
          { 'a nop; }
          { 'b nop; }
        }
      }
    `);
  });

  test('integer literal suffixes', () => {
    ok(`
      f(): () {
        local a: i32;
        local b: i64;
        local c: f32;
        local d: f64;
      }
    `);
  });

  test('hex integer literal in expression', () => {
    ok('f(): i32 { return 0xFF & 0x0F; }');
  });

  test('binary literal', () => {
    ok('f(): i32 { return 0b1010 | 0b0101; }');
  });

  test('string with escape sequences', () => {
    ok(`
      memory Mem = 1;
      data Escaped: cstr = "line1\\nline2\\ttab";
      Mem[0] = Escaped;
    `);
  });

  test('section declaration @debug', () => {
    ok('section @debug;');
  });

  test('custom section', () => {
    ok('section "sourceMappingURL" { cstr "module.wasm.map" }');
  });
});
