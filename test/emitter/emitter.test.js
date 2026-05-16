/**
 * @fileoverview WAT emitter tests.
 *
 * Tests that the WAT emitter produces structurally correct WAT text.
 * We check:
 *   - The output starts with (module and ends with )
 *   - Key WAT constructs appear for each WML feature
 *   - Operator mappings are correct (especially /s /u >>s >>u ! && ||)
 *   - Functions, memory, globals, tables appear in output
 *   - Short-circuit operators use if/else
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Lexer }       from '../../src/parser/lexer.js';
import { Parser }      from '../../src/parser/parser.js';
import { validateModule } from '../../src/validator/index.js';
import { WatEmitter }  from '../../src/emitter/wat.js';

// ── Helpers ───────────────────────────────────────────────────────────────

function emit(source) {
  const tokens  = new Lexer(source, 'test.wml').tokenize();
  const { ast } = new Parser(tokens, 'test.wml').parse();
  const { errors, symbols } = validateModule(ast, 'test.wml');
  // Allow warnings through, but abort on errors
  const errorDiags = errors.filter(e => e.severity === 'error');
  if (errorDiags.length > 0) {
    throw new Error(`Validation errors:\n${errorDiags.map(e => `${e.code}: ${e.message}`).join('\n')}`);
  }
  return new WatEmitter(ast, symbols).emit();
}

function contains(wat, substr) {
  return wat.includes(substr);
}

// ── Module structure ──────────────────────────────────────────────────────

describe('WAT module structure', () => {
  test('output starts with (module)', () => {
    const wat = emit('f(): () { }');
    assert.ok(wat.trimStart().startsWith('(module'), `WAT should start with (module), got: ${wat.slice(0, 40)}`);
  });

  test('output ends with )', () => {
    const wat = emit('f(): () { }');
    assert.ok(wat.trimEnd().endsWith(')'), 'WAT should end with )');
  });

  test('balanced parentheses', () => {
    const wat = emit('add(a: i32, b: i32): i32 { return a + b; }');
    let depth = 0;
    for (const ch of wat) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
    }
    assert.equal(depth, 0, `Unbalanced parentheses in:\n${wat}`);
  });
});

// ── Functions ─────────────────────────────────────────────────────────────

describe('Function emission', () => {
  test('function name appears in output', () => {
    const wat = emit('myFunc(): () { }');
    assert.ok(contains(wat, '$myFunc'), 'Function name should appear with $ prefix');
  });

  test('parameter appears in output', () => {
    const wat = emit('f(x: i32): i32 { return x; }');
    assert.ok(contains(wat, '$x'), 'Parameter name should appear');
    assert.ok(contains(wat, 'i32'), 'Parameter type should appear');
  });

  test('result type appears in output', () => {
    const wat = emit('f(): i32 { return 0; }');
    assert.ok(contains(wat, 'result i32'), 'Result type should appear');
  });

  test('local variable appears', () => {
    const wat = emit('f(): i32 { local x: i32; return x; }');
    assert.ok(contains(wat, 'local'), 'local keyword should appear');
  });

  test('@export emits export', () => {
    const wat = emit('@export f(): i32 { return 0; }');
    assert.ok(contains(wat, 'export'), 'export keyword should appear');
    assert.ok(contains(wat, '"f"'), 'Export name should be quoted string');
  });

  test('@export("customName") exports with custom name', () => {
    const wat = emit('@export("myFunc") fn(): i32 { return 0; }');
    assert.ok(contains(wat, 'export'), 'export keyword should appear');
    assert.ok(contains(wat, '"myFunc"'), 'Custom export name should appear');
    assert.ok(!contains(wat, '"fn"'), 'Original name should not be exported');
  });

  test('@import emits import', () => {
    const wat = emit('@import("env","log") log(n: i32): ();');
    assert.ok(contains(wat, 'import'), 'import keyword should appear');
    assert.ok(contains(wat, '"env"'), 'Module name should appear');
    assert.ok(contains(wat, '"log"'), 'Function name should appear');
  });

  test('multi-return function', () => {
    const wat = emit('f(): (i32, i32) { return (0, 1); }');
    // Two result declarations
    const resultCount = (wat.match(/result i32/g) ?? []).length;
    assert.ok(resultCount >= 2, `Expected at least 2 result i32, got ${resultCount}`);
  });
});

// ── Operators ─────────────────────────────────────────────────────────────

describe('Operator emission', () => {
  test('+ emits i32.add', () => {
    const wat = emit('f(a: i32, b: i32): i32 { return a + b; }');
    assert.ok(contains(wat, 'i32.add'));
  });

  test('- emits i32.sub', () => {
    const wat = emit('f(a: i32, b: i32): i32 { return a - b; }');
    assert.ok(contains(wat, 'i32.sub'));
  });

  test('* emits i32.mul', () => {
    const wat = emit('f(a: i32, b: i32): i32 { return a * b; }');
    assert.ok(contains(wat, 'i32.mul'));
  });

  test('/s emits i32.div_s', () => {
    const wat = emit('f(a: i32, b: i32): i32 { return a /s b; }');
    assert.ok(contains(wat, 'i32.div_s'));
  });

  test('/u emits i32.div_u', () => {
    const wat = emit('f(a: u32, b: u32): u32 { return a /u b; }');
    assert.ok(contains(wat, 'i32.div_u'));
  });

  test('%s emits i32.rem_s', () => {
    const wat = emit('f(a: i32, b: i32): i32 { return a %s b; }');
    assert.ok(contains(wat, 'i32.rem_s'));
  });

  test('%u emits i32.rem_u', () => {
    const wat = emit('f(a: u32, b: u32): u32 { return a %u b; }');
    assert.ok(contains(wat, 'i32.rem_u'));
  });

  test('>>s emits i32.shr_s', () => {
    const wat = emit('f(a: i32): i32 { return a >>s 1; }');
    assert.ok(contains(wat, 'i32.shr_s'));
  });

  test('>>u emits i32.shr_u', () => {
    const wat = emit('f(a: u32): u32 { return a >>u 1; }');
    assert.ok(contains(wat, 'i32.shr_u'));
  });

  test('<< emits i32.shl', () => {
    const wat = emit('f(a: i32): i32 { return a << 2; }');
    assert.ok(contains(wat, 'i32.shl'));
  });

  test('& emits i32.and', () => {
    const wat = emit('f(a: i32, b: i32): i32 { return a & b; }');
    assert.ok(contains(wat, 'i32.and'));
  });

  test('| emits i32.or', () => {
    const wat = emit('f(a: i32, b: i32): i32 { return a | b; }');
    assert.ok(contains(wat, 'i32.or'));
  });

  test('^ emits i32.xor', () => {
    const wat = emit('f(a: i32, b: i32): i32 { return a ^ b; }');
    assert.ok(contains(wat, 'i32.xor'));
  });

  test('! emits i32.eqz', () => {
    const wat = emit('f(a: i32): i32 { return !a; }');
    assert.ok(contains(wat, 'i32.eqz'), `Expected i32.eqz in:\n${wat}`);
  });

  test('~ emits xor with -1', () => {
    const wat = emit('f(a: i32): i32 { return ~a; }');
    assert.ok(contains(wat, 'i32.xor'), 'Bitwise not uses xor');
    assert.ok(contains(wat, 'i32.const -1'), 'Bitwise not uses -1 mask');
  });

  test('unary minus on int uses 0 - x', () => {
    const wat = emit('f(a: i32): i32 { return -a; }');
    assert.ok(contains(wat, 'i32.const 0'), 'Unary minus uses 0');
    assert.ok(contains(wat, 'i32.sub'), 'Unary minus uses sub');
  });

  test('unary minus on float uses f64.neg', () => {
    const wat = emit('f(a: f64): f64 { return -a; }');
    assert.ok(contains(wat, 'f64.neg'));
  });

  test('== emits i32.eq', () => {
    const wat = emit('f(a: i32, b: i32): i32 { return a == b; }');
    assert.ok(contains(wat, 'i32.eq'));
  });

  test('!= emits i32.ne', () => {
    const wat = emit('f(a: i32, b: i32): i32 { return a != b; }');
    assert.ok(contains(wat, 'i32.ne'));
  });

  test('< emits i32.lt_s', () => {
    const wat = emit('f(a: i32, b: i32): i32 { return a < b; }');
    assert.ok(contains(wat, 'i32.lt_s'));
  });

  test('>= emits i32.ge_s', () => {
    const wat = emit('f(a: i32, b: i32): i32 { return a >= b; }');
    assert.ok(contains(wat, 'i32.ge_s'));
  });

  test('f64 < emits f64.lt (no suffix)', () => {
    const wat = emit('f(a: f64, b: f64): i32 { return a < b; }');
    assert.ok(contains(wat, 'f64.lt'));
    assert.ok(!contains(wat, 'f64.lt_s'), 'Float comparisons have no signed suffix');
  });
});

// ── Short-circuit operators ────────────────────────────────────────────────

describe('Short-circuit operators', () => {
  test('&& emits if block with i32 result', () => {
    const wat = emit('f(a: i32, b: i32): i32 { return a && b; }');
    assert.ok(contains(wat, 'if (result i32)'), `Expected if (result i32) in:\n${wat}`);
    assert.ok(contains(wat, 'i32.const 0'), 'False branch should use i32.const 0');
  });

  test('|| emits if block with i32 result', () => {
    const wat = emit('f(a: i32, b: i32): i32 { return a || b; }');
    assert.ok(contains(wat, 'if (result i32)'), `Expected if (result i32) in:\n${wat}`);
    assert.ok(contains(wat, 'i32.const 1'), 'True branch should use i32.const 1');
  });
});

// ── Control flow ──────────────────────────────────────────────────────────

describe('Control flow emission', () => {
  test('if emits WAT if/then/end', () => {
    const wat = emit('f(c: i32): () { if (c) { nop; } }');
    assert.ok(contains(wat, 'if'));
    assert.ok(contains(wat, 'then'));
    assert.ok(contains(wat, 'end'));
  });

  test('if-else emits else branch', () => {
    const wat = emit('f(c: i32): () { if (c) { nop; } else { nop; } }');
    assert.ok(contains(wat, 'else'));
  });

  test('loop emits block and loop', () => {
    const wat = emit('f(): () { loop { { nop; } } }');
    assert.ok(contains(wat, 'block'), 'Loop exit block');
    assert.ok(contains(wat, 'loop'), 'Loop block');
  });

  test('break emits br to exit block', () => {
    const wat = emit('f(): () { loop { { break; } } }');
    assert.ok(contains(wat, 'br $__loop_exit'));
  });

  test('break if emits br_if', () => {
    const wat = emit('f(done: i32): () { loop { { break if (done); } } }');
    assert.ok(contains(wat, 'br_if $__loop_exit'));
  });

  test('goto emits br to label', () => {
    const wat = emit("f(): () { loop { { 'top nop; goto 'top if (0); } } }");
    assert.ok(contains(wat, 'br_if $top'));
  });

  test('goto table emits br_table', () => {
    const wat = emit("f(idx: i32): () { loop { { 'a nop; 'b nop; goto ['a,'b] idx; } } }");
    assert.ok(contains(wat, 'br_table'));
  });

  test('unreachable emits unreachable', () => {
    const wat = emit('f(): () { unreachable; }');
    assert.ok(contains(wat, 'unreachable'));
  });

  test('nop emits nop', () => {
    const wat = emit('f(): () { nop; }');
    assert.ok(contains(wat, 'nop'));
  });

  test('return emits return', () => {
    const wat = emit('f(): i32 { return 42; }');
    assert.ok(contains(wat, 'return'));
    assert.ok(contains(wat, 'i32.const 42'));
  });

  test('tail call emits return_call', () => {
    const wat = emit('f(n: i32): i32 { return n; }\ng(n: i32): i32 { return tail f(n); }');
    assert.ok(contains(wat, 'return_call'));
  });

  test('try/catch emits try/catch/end', () => {
    const wat = emit('tag E: (i32);\nf(): () { try { nop; } catch E(x) { nop; } }');
    assert.ok(contains(wat, 'try'));
    assert.ok(contains(wat, 'catch'));
    assert.ok(contains(wat, 'end'));
  });
});

// ── Memory ────────────────────────────────────────────────────────────────

describe('Memory emission', () => {
  test('memory declaration appears', () => {
    const wat = emit('memory Mem = 4;');
    assert.ok(contains(wat, 'memory'), 'memory keyword');
    assert.ok(contains(wat, '$Mem'), 'memory name');
    assert.ok(contains(wat, '4'), 'initial pages');
  });

  test('memory with range', () => {
    const wat = emit('memory Mem = 4..16;');
    assert.ok(contains(wat, '16'), 'max pages');
  });

  test('shared memory', () => {
    const wat = emit('shared memory Mem = 4;');
    assert.ok(contains(wat, 'shared'));
  });

  test('@export("customName") memory exports with custom name', () => {
    const wat = emit('@export("myMem") memory X = 4;');
    assert.ok(contains(wat, 'export'), 'export keyword should appear');
    assert.ok(contains(wat, '"myMem"'), 'Custom export name should appear');
  });

  test('@export("memory") memory memory = 1; — keyword name works', () => {
    const wat = emit('@export("memory") memory memory = 1;');
    assert.ok(contains(wat, '$memory'), 'Internal name should be $memory');
    assert.ok(contains(wat, '(export "memory")'), 'Export name should be "memory"');
  });

  test('global appears', () => {
    const wat = emit('global counter: i32 = 0;');
    assert.ok(contains(wat, 'global'));
    assert.ok(contains(wat, '$counter'));
  });

  test('mutable global uses mut', () => {
    const wat = emit('global mut counter: i32 = 0;');
    assert.ok(contains(wat, '(mut i32)'));
  });

  test('@export("customName") global exports with custom name', () => {
    const wat = emit('@export("myGlobal") global g: i32 = 42;');
    assert.ok(contains(wat, 'export'), 'export keyword should appear');
    assert.ok(contains(wat, '"myGlobal"'), 'Custom export name');
  });
});

// ── Types ─────────────────────────────────────────────────────────────────

describe('Type section emission', () => {
  test('struct type emits WAT struct', () => {
    const wat = emit('type Point = struct { x: i32; mut y: i32; };');
    assert.ok(contains(wat, 'struct'), 'struct keyword');
    assert.ok(contains(wat, '$Point'), 'type name');
    assert.ok(contains(wat, '$x'), 'field name');
    assert.ok(contains(wat, '(mut i32)'), 'mutable field');
  });

  test('array type emits WAT array', () => {
    const wat = emit('type IntArray = [i32];');
    assert.ok(contains(wat, 'array'), 'array keyword');
  });

  test('final struct emits sub final', () => {
    const wat = emit('type FinalPoint = final struct { x: i32; };');
    assert.ok(contains(wat, 'sub final'));
  });

  test('function typedef appears', () => {
    const wat = emit('type BinaryOp = (i32, i32) => i32;');
    assert.ok(contains(wat, '$BinaryOp'));
  });
});

// ── i64 types ─────────────────────────────────────────────────────────────

describe('i64 operations', () => {
  test('i64 add', () => {
    const wat = emit('f(a: i64, b: i64): i64 { return a + b; }');
    assert.ok(contains(wat, 'i64.add'));
  });

  test('i64 const', () => {
    const wat = emit('f(): i64 { return 1000000000000; }');
    assert.ok(contains(wat, 'i64.const'));
  });

  test('i64 shr_s', () => {
    const wat = emit('f(a: i64): i64 { return a >>s 1; }');
    assert.ok(contains(wat, 'i64.shr_s'));
  });
});

// ── f32 / f64 ─────────────────────────────────────────────────────────────

describe('Float operations', () => {
  test('f32 add', () => {
    const wat = emit('f(a: f32, b: f32): f32 { return a + b; }');
    assert.ok(contains(wat, 'f32.add'));
  });

  test('f64 mul', () => {
    const wat = emit('f(a: f64, b: f64): f64 { return a * b; }');
    assert.ok(contains(wat, 'f64.mul'));
  });

  test('f64 literal', () => {
    const wat = emit('f(): f64 { return 3.14; }');
    assert.ok(contains(wat, 'f64.const 3.14'));
  });
});

// ── Additional emitter features ─────────────────────────────────────────────

describe('Table and elem emission', () => {
  test('table declaration', () => {
    const wat = emit('table T: [funcref] = 8;');
    assert.ok(contains(wat, 'table'), 'table keyword');
    assert.ok(contains(wat, 'funcref'), 'funcref type');
  });

  test('elem segment', () => {
    const wat = emit('table T: [funcref] = 4;\nf(): i32 { return 0; }\nelem E: funcref[] = [f];');
    assert.ok(contains(wat, 'elem'));
  });
});

describe('Tag and exception emission', () => {
  test('tag declaration', () => {
    const wat = emit('tag DivError: (i32, i32);');
    assert.ok(contains(wat, 'tag'));
    assert.ok(contains(wat, '$DivError'));
  });

  test('exported tag', () => {
    const wat = emit('@export tag AppError: (i32);');
    assert.ok(contains(wat, 'export'));
    assert.ok(contains(wat, '"AppError"'));
  });

  test('@export("customName") tag exports with custom name', () => {
    const wat = emit('@export("myTag") tag T: (i32);');
    assert.ok(contains(wat, 'export'));
    assert.ok(contains(wat, '"myTag"'));
  });
});

describe('Select and sizeof emission', () => {
  test('select expression', () => {
    const wat = emit('f(c: i32, a: i32, b: i32): i32 { return select(c, a, b); }');
    assert.ok(contains(wat, 'select'));
  });

  test('sizeof expression emits computed constant', () => {
    const wat = emit('type T = struct { x: i32; y: i32; };\nf(): isize { return sizeof(T); }');
    // sizeof(T) for two i32 fields should be 8
    assert.ok(contains(wat, 'i32.const 8'));
  });
});

describe('New struct and array emission', () => {
  test('new struct', () => {
    const wat = emit('type Point = struct { x: i32; y: i32; };\nf(): Point { return new Point { x: 1, y: 2 }; }');
    assert.ok(contains(wat, 'struct.new'));
    assert.ok(contains(wat, '$Point'));
  });

  test('new array', () => {
    const wat = emit('type IntArray = [i32];\nf(n: i32): IntArray { return new IntArray(n); }');
    assert.ok(contains(wat, 'array.new'));
  });
});

describe('Section emission', () => {
  test('section @debug produces no errors', () => {
    // section @debug is a no-op during WAT emission
    const wat = emit('section @debug;');
    assert.ok(wat.includes('(module'));
  });

  test('custom section', () => {
    const wat = emit('section "mySection" { cstr "hello" }');
    assert.ok(contains(wat, 'mySection'));
  });
});

describe('Ref and goto emission', () => {
  test('goto to label uses br', () => {
    const wat = emit("f(): () { loop { { 'top nop; goto 'top if (0); } } }");
    assert.ok(contains(wat, 'br_if $top'));
  });

  test('cross-block goto uses relooper state machine', () => {
    const wat = emit(`f(): () {
      loop {
        { 'a nop; }
        { 'b goto 'a if (1); }
      }
    }`);
    // Cross-block goto must use $__state + br_table, not direct br
    assert.ok(!contains(wat, 'br $a'), 'should not emit direct br to other block');
    assert.ok(!contains(wat, 'br_if $a'), 'should not emit direct br_if to other block');
    assert.ok(contains(wat, 'br_table'), 'should emit br_table dispatcher');
    assert.ok(contains(wat, 'local.set $__state'), 'should set relooper state');
  });

  test('cross-block goto inside if uses relooper', () => {
    const wat = emit(`f(): () {
      loop {
        { 'a nop; }
        { 'b if (1) { goto 'a; } }
      }
    }`);
    assert.ok(contains(wat, 'br_table'), 'should emit br_table dispatcher');
    assert.ok(!contains(wat, 'br $a'), 'should not emit direct br to other block');
  });

  test('same-block goto still uses direct br', () => {
    const wat = emit("f(): () { loop { { 'top goto 'top if (0); } } }");
    assert.ok(contains(wat, 'br_if $top'), 'same-block goto uses direct br');
    assert.ok(!contains(wat, 'br_table'), 'no relooper for same-block goto');
  });

  test('ref function', () => {
    const wat = emit('f(x: i32): i32 { return x; }\ng(): funcref { return ref(f); }');
    assert.ok(contains(wat, 'ref.func'));
  });
});

describe('Data segment type variants', () => {
  test('i8[] data', () => {
    const wat = emit('memory Mem = 1;\ndata D: i8[] = [1, 2, 3];\nMem[0] = D;');
    assert.ok(contains(wat, 'data'));
  });

  test('cstr data emits hex-encoded string', () => {
    const wat = emit('memory Mem = 1;\ndata D: cstr = "hello";\nMem[0] = D;');
    // cstr is emitted as hex byte escapes
    assert.ok(contains(wat, '\\68'), 'should contain hex for h');
  });

  test('utf8_32 data emits hex-encoded string', () => {
    const wat = emit('memory Mem = 1;\ndata D: utf8_32 = "hi";\nMem[0] = D;');
    assert.ok(contains(wat, '\\68'), 'should contain hex for h');
  });
});

// ── Linear structs ──────────────────────────────────────────────────────────

describe('Linear struct emission', () => {
  test('#[linear] struct does not appear in type section', () => {
    const wat = emit(`
      #[linear]
      type Point = struct { x: i32; y: i32; };
      memory Mem = 1;
      f(ptr: *Point): i32 { return ptr[0].x; }
    `);
    // No (type $Point ...) emitted for #[linear] structs
    assert.ok(!contains(wat, '(type $Point'), 'Linear struct should not have type entry');
    // Regular GC struct should still have type entry
    const wat2 = emit(`
      type GC = struct { a: i32; };
      f(p: GC): i32 { return p.a; }
    `);
    assert.ok(contains(wat2, '(type $GC'), 'GC struct should have type entry');
  });

  test('#[linear] ptr[0].field emits i32.load with offset', () => {
    const wat = emit(`
      #[linear]
      type Point = struct { x: i32; y: i32; };
      memory Mem = 1;
      f(ptr: *Point): i32 { return ptr[0].x; }
    `);
    // Should emit i32.load with offset=0 for first field
    assert.ok(contains(wat, 'i32.load offset=0'),
      `Expected i32.load offset=0 in:\n${wat}`);
  });

  test('#[linear] ptr[0].field offset for second field', () => {
    const wat = emit(`
      #[linear]
      type Point = struct { x: i32; y: i32; };
      memory Mem = 1;
      f(ptr: *Point): i32 { return ptr[0].y; }
    `);
    // y field should be at offset=4
    assert.ok(contains(wat, 'i32.load offset=4'),
      `Expected i32.load offset=4 in:\n${wat}`);
  });

  test('#[linear] ptr[n].field with index', () => {
    const wat = emit(`
      #[linear]
      type Point = struct { x: i32; y: i32; };
      memory Mem = 1;
      f(ptr: *Point, n: i32): i32 { return ptr[n].x; }
    `);
    // Should multiply index by struct size (8 for two i32 fields)
    assert.ok(contains(wat, 'i32.const 8'),
      `Expected i32.const 8 (struct size) in:\n${wat}`);
    assert.ok(contains(wat, 'i32.mul'),
      `Expected i32.mul in:\n${wat}`);
    assert.ok(contains(wat, 'i32.load offset=0'),
      `Expected i32.load offset=0 in:\n${wat}`);
  });

  test('#[linear] ptr[0].field = val store', () => {
    const wat = emit(`
      #[linear]
      type Point = struct { x: i32; y: i32; };
      memory Mem = 1;
      f(ptr: *Point): () { ptr[0].x = 42; }
    `);
    // Should emit i32.store with offset=0
    assert.ok(contains(wat, 'i32.store offset=0'),
      `Expected i32.store offset=0 in:\n${wat}`);
  });

  test('#[linear] ptr[0].y = val store offset', () => {
    const wat = emit(`
      #[linear]
      type Point = struct { x: i32; y: i32; };
      memory Mem = 1;
      f(ptr: *Point): () { ptr[0].y = 99; }
    `);
    // y store should be at offset=4
    assert.ok(contains(wat, 'i32.store offset=4'),
      `Expected i32.store offset=4 in:\n${wat}`);
  });

  test('#[linear] struct with mixed field sizes', () => {
    const wat = emit(`
      #[linear]
      type Header = struct { magic: i8; version: i8; flags: i16; };
      memory Mem = 1;
      f(ptr: *Header): i32 { return ptr[0].flags; }
    `);
    // flags is at offset=2 (after two i8 fields)
    assert.ok(contains(wat, 'i32.load16_s offset=2') || contains(wat, 'i32.load offset=2'),
      `Expected load at offset=2 in:\n${wat}`);
  });

  test('#[linear] and GC structs coexist in same module', () => {
    const wat = emit(`
      #[linear]
      type Linear = struct { x: i32; y: i32; };
      type GC = struct { a: i32; };
      memory Mem = 1;
      f(ptr: *Linear): i32 { return ptr[0].x; }
    `);
    // GC struct should be in type section
    assert.ok(contains(wat, '(type $GC'), 'GC struct should have type entry');
    // #[linear] struct should not
    assert.ok(!contains(wat, '(type $Linear'), 'Linear struct should not have type entry');
  });
});

// ── Primitive conversion / arithmetic methods ──────────────────────────────

describe('Primitive method calls', () => {
  test('i32.toF64() emits f64.convert_i32_s', () => {
    const wat = emit('f(x: i32): f64 { return x.toF64(); }');
    assert.ok(contains(wat, 'f64.convert_i32_s'),
      `Expected f64.convert_i32_s in:\n${wat}`);
  });

  test('i64.toI32s() emits i32.wrap_i64', () => {
    const wat = emit('f(x: i64): i32 { return x.toI32s(); }');
    assert.ok(contains(wat, 'i32.wrap_i64'),
      `Expected i32.wrap_i64 in:\n${wat}`);
  });

  test('i32.toI64s() emits i64.extend_i32_s', () => {
    const wat = emit('f(x: i32): i64 { return x.toI64s(); }');
    assert.ok(contains(wat, 'i64.extend_i32_s'),
      `Expected i64.extend_i32_s in:\n${wat}`);
  });

  test('f64.toI64s() emits i64.trunc_f64_s', () => {
    const wat = emit('f(x: f64): i64 { return x.toI64s(); }');
    assert.ok(contains(wat, 'i64.trunc_f64_s'),
      `Expected i64.trunc_f64_s in:\n${wat}`);
  });

  test('f64.reinterpret emits i64.reinterpret_f64', () => {
    const wat = emit('f(x: f64): i64 { return x.reinterpret; }');
    assert.ok(contains(wat, 'i64.reinterpret_f64'),
      `Expected i64.reinterpret_f64 in:\n${wat}`);
  });

  test('i32.reinterpret emits f32.reinterpret_i32', () => {
    const wat = emit('f(x: i32): f32 { return x.reinterpret; }');
    assert.ok(contains(wat, 'f32.reinterpret_i32'),
      `Expected f32.reinterpret_i32 in:\n${wat}`);
  });

  test('same-type toF64 is no-op', () => {
    const wat = emit('f(x: f64): f64 { return x.toF64(); }');
    assert.ok(!contains(wat, 'convert'),
      `No conversion expected in:\n${wat}`);
    assert.ok(contains(wat, 'local.get $x'),
      `Expected local.get $x in:\n${wat}`);
  });

  test('i32.add() emits i32.add', () => {
    const wat = emit('f(x: i32, y: i32): i32 { return x.add(y); }');
    assert.ok(contains(wat, 'i32.add'),
      `Expected i32.add in:\n${wat}`);
  });

  test('f64.neg emits f64.neg', () => {
    const wat = emit('f(x: f64): f64 { return x.neg; }');
    assert.ok(contains(wat, 'f64.neg'),
      `Expected f64.neg in:\n${wat}`);
  });

  test('i32.eqz emits i32.eqz', () => {
    const wat = emit('f(x: i32): i32 { return x.eqz; }');
    assert.ok(contains(wat, 'i32.eqz'),
      `Expected i32.eqz in:\n${wat}`);
  });

  test('i32.div_s emits i32.div_s', () => {
    const wat = emit('f(x: i32, y: i32): i32 { return x.div_s(y); }');
    assert.ok(contains(wat, 'i32.div_s'),
      `Expected i32.div_s in:\n${wat}`);
  });

  test('i32.div_u emits i32.div_u', () => {
    const wat = emit('f(x: i32, y: i32): i32 { return x.div_u(y); }');
    assert.ok(contains(wat, 'i32.div_u'),
      `Expected i32.div_u in:\n${wat}`);
  });

  test('i32.rem_u emits i32.rem_u', () => {
    const wat = emit('f(x: i32, y: i32): i32 { return x.rem_u(y); }');
    assert.ok(contains(wat, 'i32.rem_u'),
      `Expected i32.rem_u in:\n${wat}`);
  });

  test('i64.div_u and rem_u emit correct instructions', () => {
    const wat = emit('f(x: i64, y: i64): i64 { return x.div_u(y); }');
    assert.ok(contains(wat, 'i64.div_u'),
      `Expected i64.div_u in:\n${wat}`);
  });

  test('i32.lt_u emits i32.lt_u', () => {
    const wat = emit('f(x: i32, y: i32): i32 { return x.lt_u(y); }');
    assert.ok(contains(wat, 'i32.lt_u'),
      `Expected i32.lt_u in:\n${wat}`);
  });

  test('/u on i32 emits i32.div_u', () => {
    const wat = emit('f(x: i32, y: i32): i32 { return x /u y; }');
    assert.ok(contains(wat, 'i32.div_u'),
      `Expected i32.div_u in:\n${wat}`);
  });

  test('%u on i64 emits i64.rem_u', () => {
    const wat = emit('f(x: i64, y: i64): i64 { return x %u y; }');
    assert.ok(contains(wat, 'i64.rem_u'),
      `Expected i64.rem_u in:\n${wat}`);
  });
});
