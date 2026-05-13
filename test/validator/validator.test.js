/**
 * @fileoverview Validator tests.
 *
 * Tests cover:
 *   - Scope errors (undefined names, duplicate declarations, label scoping)
 *   - Type errors (mismatched types, bad operators, invalid casts)
 *   - Const expression errors
 *   - Memory validation errors
 *   - Link validation errors
 *   - Warning detection
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Lexer }   from '../../src/parser/lexer.js';
import { Parser }  from '../../src/parser/parser.js';
import { validateModule } from '../../src/validator/index.js';

// ── Helpers ───────────────────────────────────────────────────────────────

function validateSrc(source) {
  const tokens = new Lexer(source, 'test.wml').tokenize();
  const { ast } = new Parser(tokens, 'test.wml').parse();
  return validateModule(ast, 'test.wml');
}

function errCodes(source) {
  const { errors } = validateSrc(source);
  return errors.map(e => e.code);
}

function hasErr(source, code) {
  return errCodes(source).includes(code);
}

function noErrors(source) {
  const { errors } = validateSrc(source);
  const errorsDiags = errors.filter(e => e.severity === 'error');
  assert.equal(errorsDiags.length, 0,
    `Expected no errors, got:\n${errors.map(e => `${e.code}: ${e.message}`).join('\n')}`);
}

function hasCode(source, code) {
  assert.ok(hasErr(source, code), `Expected error ${code} in:\n${source}`);
}

// ── Scope errors ──────────────────────────────────────────────────────────

describe('Scope errors', () => {
  test('undefined name', () => {
    hasCode('f(): i32 { return undeclared; }', 'E200');
  });

  test('defined name does not error', () => {
    noErrors('global x: i32 = 0;\nf(): i32 { return x; }');
  });

  test('parameter in scope', () => {
    noErrors('f(a: i32): i32 { return a; }');
  });

  test('local in scope', () => {
    noErrors('f(): i32 { local x: i32 = 0; return x; }');
  });

  test('duplicate global', () => {
    hasCode('global x: i32 = 0;\nglobal x: i32 = 1;', 'E201');
  });

  test('duplicate param', () => {
    hasCode('f(a: i32, a: i32): i32 { return a; }', 'E201');
  });

  test('duplicate local', () => {
    hasCode('f(): i32 { local x: i32; local x: i32; return x; }', 'E201');
  });

  test('undefined type', () => {
    hasCode('f(): () { local p: UnknownType; }', 'E202');
  });

  test('defined type resolves', () => {
    noErrors('type MyInt = i32;\nf(): () { local x: MyInt; }');
  });

  test('break outside loop', () => {
    hasCode('f(): () { break; }', 'E209');
  });

  test('goto outside loop', () => {
    hasCode("f(): () { goto 'label; }", 'E209');
  });

  test('goto undefined label', () => {
    hasCode("f(): () { loop { { goto 'missing; } } }", 'E215');
  });

  test('goto outer loop label is E216', () => {
    hasCode("f(): () { loop { { 'outer loop { { goto 'outer; } } } } }", 'E216');
  });

  test('goto same loop label works', () => {
    noErrors("f(): () { loop { { 'top goto 'top if (0); } } }");
  });

  test('duplicate label in same loop', () => {
    hasCode("f(): () { loop { { 'a nop; 'a nop; } } }", 'E217');
  });

  test('@start duplicate in same file', () => {
    hasCode('@start init1(): () { }\n@start init2(): () { }', 'E213');
  });

  test('@start in different files merges (no error)', () => {
    // Linking multiple @start across files is handled by linker (no error per-file)
    // Just check single @start is fine
    noErrors('@start init(): () { }');
  });

  test('mutable global in const expr', () => {
    hasCode('global mut x: i32 = 0;\nglobal y: i32 = x;', 'E301');
  });

  test('local in const expr (global init)', () => {
    // Function call in global init — E302
    hasCode('f(): i32 { return 1; }\nglobal y: i32 = f();', 'E302');
  });
});

// ── Type errors ───────────────────────────────────────────────────────────

describe('Type errors', () => {
  test('type mismatch in return', () => {
    hasCode('f(): i32 { return 1.0; }', 'E102');
  });

  test('type mismatch in assignment', () => {
    hasCode('global mut x: i32 = 0;\nf(): () { x = 1.0; }', 'E100');
  });

  test('immutable global assignment', () => {
    hasCode('global x: i32 = 0;\nf(): () { x = 1; }', 'E113');
  });

  test('arithmetic type mismatch', () => {
    // i32 + f64 is a type error
    hasCode('f(): i32 { local a: i32 = 0; local b: f64 = 0.0; return a + b; }', 'E101');
  });

  test('correct arithmetic does not error', () => {
    noErrors('f(): i32 { local a: i32 = 0; local b: i32 = 0; return a + b; }');
  });

  test('select operand mismatch', () => {
    hasCode('f(): i32 { local a: i32 = 0; local b: f64 = 0.0; return select(1, a, b); }', 'E109');
  });

  test('select same type ok', () => {
    noErrors('f(): i32 { return select(1, 0, 1); }');
  });

  test('return count mismatch', () => {
    hasCode('f(): (i32, i32) { return 1; }', 'E111');
  });

  test('return type mismatch', () => {
    hasCode('f(): i32 { return 1.5; }', 'E102');
  });

  test('function call arg count mismatch', () => {
    hasCode('add(a: i32, b: i32): i32 { return a + b; }\nf(): i32 { return add(1); }', 'E108');
  });

  test('function call arg type mismatch', () => {
    hasCode('add(a: i32, b: i32): i32 { return a + b; }\nf(): i32 { return add(1.0, 2); }', 'E100');
  });

  test('/u and %u work on i32 and i64', () => {
    noErrors('f(): i32 { local a: i32 = 10; local b: i32 = 3; return a /u b; }');
    noErrors('f(): i64 { local a: i64 = 10i64; local b: i64 = 3i64; return a %u b; }');
  });

  test('logical not returns i32', () => {
    noErrors('f(): i32 { local a: i32 = 0; return !a; }');
  });

  test('bitwise not on float is error', () => {
    hasCode('f(): f64 { local a: f64 = 0.0; return ~a; }', 'E101');
  });

  test('@start with params is E504', () => {
    hasCode('@start init(n: i32): () { }', 'E504');
  });

  test('@start with return is E504', () => {
    hasCode('@start init(): i32 { return 0; }', 'E504');
  });

  test('@start with no params/returns is ok', () => {
    noErrors('@start init(): () { }');
  });

  test('import with body is E501', () => {
    hasCode('@import("env","log") log(n: i32): () { nop; }', 'E501');
  });
});

// ── Memory validation ─────────────────────────────────────────────────────

describe('Memory validation', () => {
  test('invalid memory range', () => {
    hasCode('memory Mem = 8..4;', 'E404');
  });

  test('valid memory range', () => {
    noErrors('memory Mem = 4..16;');
  });

  test('pascal string too long', () => {
    const longStr = 'x'.repeat(256);
    hasCode(`memory Mem = 1;\ndata D: pascal = "${longStr}";\nMem[0] = D;`, 'E403');
  });

  test('pascal string max length ok', () => {
    const maxStr = 'x'.repeat(255);
    noErrors(`memory Mem = 1;\ndata D: pascal = "${maxStr}";\nMem[0] = D;`);
  });

  test('unused data segment warns W001', () => {
    const { errors } = validateSrc('memory Mem = 1;\ndata D: i8[] = [1, 2];');
    // Data declared but not placed — warning
    assert.ok(errors.some(e => e.code === 'W001'));
  });

  test('used data segment no warning', () => {
    const { errors } = validateSrc('memory Mem = 1;\ndata D: i8[] = [1, 2];\nMem[0] = D;');
    assert.ok(!errors.some(e => e.code === 'W001'));
  });

  test('unused elem warns W002', () => {
    const { errors } = validateSrc('table T: [funcref] = 8;\nelem Handlers: funcref[] = [];');
    assert.ok(errors.some(e => e.code === 'W002'));
  });

  test('undefined memory in placement', () => {
    hasCode('data D: i8[] = [1];\nNoMem[0] = D;', 'E204');
  });
});

// ── Link validation ───────────────────────────────────────────────────────

describe('Link validation', () => {
  test('duplicate export in same file', () => {
    hasCode('@export f(): i32 { return 0; }\n@export f(): i32 { return 1; }', 'E500');
  });

  test('tag with invalid param type', () => {
    // Struct types can be params, but data layout types (cstr, utf8_32) cannot
    hasCode('tag Bad: (cstr);', 'E505');
  });

  test('valid tag params', () => {
    noErrors('tag DivError: (i32, i32);');
  });

  test('import with body is E501', () => {
    hasCode('@import("env","log") log(n: i32): () { nop; }', 'E501');
  });
});

// ── Warnings ──────────────────────────────────────────────────────────────

describe('Warnings', () => {
  test('W001 unused data', () => {
    const { errors } = validateSrc('data D: i8[] = [0x00];');
    assert.ok(errors.some(e => e.code === 'W001' && e.severity === 'warning'));
  });

  test('W002 unused elem', () => {
    const { errors } = validateSrc('table T: [funcref] = 4;\nelem E: funcref[] = [];');
    assert.ok(errors.some(e => e.code === 'W002' && e.severity === 'warning'));
  });
});

// ── Valid programs ────────────────────────────────────────────────────────

describe('Valid programs', () => {
  test('fibonacci', () => {
    noErrors(`
      fib(n: i32): i32 {
        local result: i32;
        local a: i32 = 0;
        local b: i32 = 1;
        local i: i32 = 0;
        loop {
          { 'done
            break if (i >= n);
            result = a + b;
            a = b;
            b = result;
            i += 1;
            goto 'done if (0);
          }
        }
        return b;
      }
    `);
  });

  test('struct with field access', () => {
    noErrors(`
      type Point = struct { x: i32; mut y: i32; };
      make(x: i32, y: i32): Point {
        return new Point { x: x, y: y };
      }
    `);
  });

  test('global counter', () => {
    noErrors(`
      global mut counter: i32 = 0;
      @export increment(): () {
        counter += 1;
      }
      @export getCount(): i32 {
        return counter;
      }
    `);
  });

  test('table call_indirect', () => {
    noErrors(`
      type BinaryOp = (i32, i32) => i32;
      table FuncTable: [funcref] = 4;
      dispatch(op: i32, a: i32, b: i32): i32 {
        return FuncTable[op]<BinaryOp>(a, b);
      }
    `);
  });

  test('exception handling', () => {
    noErrors(`
      tag DivError: (i32, i32);
      safeDiv(a: i32, b: i32): i32 {
        if (b == 0) {
          throw DivError(a, b);
        }
        return a /s b;
      }
    `);
  });

  test('memory load/store', () => {
    noErrors(`
      memory Mem = 1;
      writeInt(ptr: i32, val: i32): () {
        Mem.store<i32>(ptr, val);
      }
      readInt(ptr: i32): i32 {
        return Mem.load<i32>(ptr);
      }
    `);
  });
});

// ── More type errors ────────────────────────────────────────────────────────

describe('Additional type errors', () => {
  test('immutable field assignment is E105', () => {
    hasCode(`
      type Point = struct { x: i32; };
      f(p: Point): () { p.x = 5; }
    `, 'E105');
  });

  test('empty br_table is E619', () => {
    hasCode("f(): () { loop { { goto []; } } }", 'E619');
  });

  test('unreachable code after return', () => {
    // Code after return should parse but validation context may differ
    const { errors } = validateSrc('f(): i32 { return 1; 42; }');
    assert.equal(errors.filter(e => e.severity === 'error').length, 0);
  });
});

// ── Linear struct errors ───────────────────────────────────────────────────

describe('Linear struct errors', () => {
  test('E607 new on #[linear] struct', () => {
    hasCode(`
      #[linear]
      type Point = struct { x: i32; y: i32; };
      f(): () { local p: Point = new Point { x: 1, y: 2 }; }
    `, 'E607');
  });

  test('E609 cast to #[linear] struct', () => {
    hasCode(`
      #[linear]
      type Point = struct { x: i32; y: i32; };
      f(r: anyref): () { local p: Point = r as Point; }
    `, 'E609');
  });

  test('E609 type test on #[linear] struct', () => {
    hasCode(`
      #[linear]
      type Point = struct { x: i32; y: i32; };
      f(r: anyref): i32 { return r is Point; }
    `, 'E609');
  });

  test('E609 #[linear] struct extends another type', () => {
    hasCode(`
      #[linear]
      type Base = struct { x: i32; };
      #[linear]
      type Derived = struct extends Base { y: i32; };
    `, 'E609');
  });

  test('E610 #[linear] struct as param type', () => {
    hasCode(`
      #[linear]
      type Point = struct { x: i32; y: i32; };
      f(p: Point): () { nop; }
    `, 'E610');
  });

  test('E610 #[linear] struct as local type', () => {
    hasCode(`
      #[linear]
      type Point = struct { x: i32; y: i32; };
      f(): () { local p: Point; }
    `, 'E610');
  });

  test('E610 #[linear] struct as return type', () => {
    hasCode(`
      #[linear]
      type Point = struct { x: i32; y: i32; };
      f(): Point { return 0; }
    `, 'E610');
  });

  test('pointer to #[linear] struct is valid', () => {
    noErrors(`
      #[linear]
      type Point = struct { x: i32; y: i32; };
      memory Mem = 1;
      f(ptr: *Point): () { nop; }
    `);
  });
});
