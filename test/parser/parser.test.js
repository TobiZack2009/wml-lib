/**
 * @fileoverview Parser tests.
 *
 * Tests cover:
 *   - All top-level declaration types
 *   - All statement types
 *   - Expression parsing and operator precedence
 *   - Error recovery on malformed input
 *   - Pragma parsing
 *   - Decorator parsing
 *   - Type expression parsing
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Lexer }   from '../../src/parser/lexer.js';
import { Parser }  from '../../src/parser/parser.js';

// ── Helpers ───────────────────────────────────────────────────────────────

function parse(source) {
  const tokens = new Lexer(source, 'test.wml').tokenize();
  return new Parser(tokens, 'test.wml').parse();
}

function parseOk(source) {
  const result = parse(source);
  assert.equal(result.errors.length, 0, `Expected no errors, got:\n${result.errors.map(e => e.message).join('\n')}`);
  return result.ast;
}

function parseErr(source) {
  const result = parse(source);
  assert.ok(result.errors.length > 0, 'Expected at least one error');
  return result;
}

function firstDecl(source) {
  return parseOk(source).decls[0];
}

// ── Functions ─────────────────────────────────────────────────────────────

describe('Function declarations', () => {
  test('simple function', () => {
    const decl = firstDecl('add(a: i32, b: i32): i32 { return a + b; }');
    assert.equal(decl.kind, 'FuncDecl');
    assert.equal(decl.name, 'add');
    assert.equal(decl.params.length, 2);
    assert.equal(decl.params[0].name, 'a');
    assert.equal(decl.results.length, 1);
  });

  test('void function', () => {
    const decl = firstDecl('noop(): () { }');
    assert.equal(decl.kind, 'FuncDecl');
    assert.equal(decl.results.length, 0);
  });

  test('multi-return function', () => {
    const decl = firstDecl('divmod(a: i32, b: i32): (i32, i32) { return (a /s b, a %s b); }');
    assert.equal(decl.results.length, 2);
  });

  test('@export decorator', () => {
    const decl = firstDecl('@export add(a: i32): i32 { return a; }');
    assert.ok(decl.decorators.some(d => d.name === 'export'));
  });

  test('@export("customName") decorator with export name arg', () => {
    const decl = firstDecl('@export("myFunc") fn(a: i32): i32 { return a; }');
    const exp = decl.decorators.find(d => d.name === 'export');
    assert.ok(exp, 'export decorator should exist');
    assert.equal(exp.args[0], 'myFunc', 'Custom export name should be stored');
  });

  test('@import decorator', () => {
    const decl = firstDecl('@import("env","log") log(n: i32): ();');
    assert.ok(decl.decorators.some(d => d.name === 'import'));
    assert.equal(decl.decorators.find(d => d.name === 'import').args[0], 'env');
    assert.equal(decl.decorators.find(d => d.name === 'import').args[1], 'log');
  });

  test('@start decorator', () => {
    const decl = firstDecl('@start init(): () { }');
    assert.ok(decl.decorators.some(d => d.name === 'start'));
  });

  test('@tail decorator', () => {
    const decl = firstDecl('@tail factorial(n: i32, acc: i32): i32 { return n; }');
    assert.ok(decl.decorators.some(d => d.name === 'tail'));
  });

  test('local declarations', () => {
    const decl = firstDecl('f(): i32 { local x: i32; local y: i32 = 5; return x + y; }');
    assert.equal(decl.locals.length, 2);
    assert.equal(decl.locals[0].name, 'x');
    assert.equal(decl.locals[1].name, 'y');
    assert.ok(decl.locals[1].init != null);
  });

  test('return tail call', () => {
    const decl = firstDecl('f(n: i32): i32 { return tail g(n); }');
    assert.equal(decl.body[0].kind, 'ReturnTailStmt');
  });
});

// ── Type declarations ─────────────────────────────────────────────────────

describe('Type declarations', () => {
  test('function typedef', () => {
    const decl = firstDecl('type BinaryOp = (i32, i32) => i32;');
    assert.equal(decl.kind, 'TypeDecl');
    assert.equal(decl.name, 'BinaryOp');
    assert.equal(decl.typeExpr.kind, 'FuncType');
  });

  test('struct type', () => {
    const decl = firstDecl('type Point = struct { x: i32; mut y: i32; };');
    assert.equal(decl.typeExpr.kind, 'StructType');
    assert.equal(decl.typeExpr.fields.length, 2);
    assert.equal(decl.typeExpr.fields[0].isMut, false);
    assert.equal(decl.typeExpr.fields[1].isMut, true);
  });

  test('final struct', () => {
    const decl = firstDecl('type FinalPoint = final struct { x: i32; y: i32; };');
    assert.equal(decl.typeExpr.isFinal, true);
  });

  test('struct with extends', () => {
    const decl = firstDecl('type Dog = struct extends Animal { breed: i32; };');
    assert.ok(decl.typeExpr.superType != null);
  });

  test('array type', () => {
    const decl = firstDecl('type IntArray = [i32];');
    assert.equal(decl.typeExpr.kind, 'ArrayType');
  });

  test('mutable array type', () => {
    const decl = firstDecl('type MutIntArray = [mut i32];');
    assert.equal(decl.typeExpr.isMut, true);
  });

  test('rec group', () => {
    const ast = parseOk('rec { type Node = struct { value: i32; }; }');
    assert.equal(ast.decls[0].kind, 'RecGroup');
    assert.equal(ast.decls[0].types.length, 1);
  });

  test('repr(packed) pragma', () => {
    const decl = firstDecl('#[repr(packed)]\ntype Packed = struct { x: i8; y: i8; };');
    assert.equal(decl.kind, 'TypeDecl');
    // Pragmas are attached to the type declaration node
    assert.equal(decl.typeExpr.kind, 'StructType');
  });

  test('repr(C) pragma', () => {
    const ast = parseOk('#[repr(C)]\ntype CLayout = struct { x: i32; y: i32; };');
    assert.ok(ast.decls.length > 0);
  });

  test('multiple pragmas comma-separated', () => {
    // Multiple pragmas: #[repr(packed), repr(C)] — currently an error but parser tolerates
    // By spec, #[repr(packed), repr(C)] is stacked pragmas
    const ast = parse('#[repr(packed)]\n#[repr(C)]\ntype X = struct { a: i8; };');
    // Should parse without internal parser crash
    assert.ok(ast.ast != null);
  });

  test('#[linear] pragma on struct', () => {
    const decl = firstDecl('#[linear]\ntype Linear = struct { x: i32; y: i32; };');
    assert.equal(decl.kind, 'TypeDecl');
    assert.equal(decl.typeExpr.kind, 'StructType');
    assert.ok(decl.typeExpr.pragmas.some(p => p.name === 'linear'));
  });

  test('#[linear] with repr(packed)', () => {
    const decl = firstDecl('#[linear]\n#[repr(packed)]\ntype Packed = struct { x: i8; y: i16; };');
    assert.equal(decl.typeExpr.kind, 'StructType');
    const pragmaNames = (decl.typeExpr.pragmas ?? []).map(p => p.name);
    assert.ok(pragmaNames.includes('linear'));
    assert.ok(pragmaNames.includes('repr'));
  });
});

// ── Memory and globals ────────────────────────────────────────────────────

describe('Memory, table, global declarations', () => {
  test('memory declaration', () => {
    const decl = firstDecl('memory Mem = 4;');
    assert.equal(decl.kind, 'MemoryDecl');
    assert.equal(decl.name, 'Mem');
    assert.equal(decl.min, 4);
    assert.equal(decl.max, null);
  });

  test('memory with range', () => {
    const decl = firstDecl('memory Mem = 4..16;');
    assert.equal(decl.min, 4);
    assert.equal(decl.max, 16);
  });

  test('shared memory', () => {
    const decl = firstDecl('shared memory Mem = 4;');
    assert.equal(decl.isShared, true);
    assert.equal(decl.name, 'Mem');
  });

  test('memory named with keyword "memory" works', () => {
    const decl = firstDecl('memory memory = 1;');
    assert.equal(decl.name, 'memory');
  });

  test('@export("memory") memory memory = 1; keyword name + custom export', () => {
    const decl = firstDecl('@export("memory") memory memory = 1;');
    assert.equal(decl.name, 'memory');
    const exp = decl.decorators.find(d => d.name === 'export');
    assert.ok(exp, 'export decorator should exist');
    assert.equal(exp.args[0], 'memory', 'Custom export name');
  });

  test('table declaration', () => {
    const decl = firstDecl('table FuncTable: [funcref] = 16;');
    assert.equal(decl.kind, 'TableDecl');
    assert.equal(decl.min, 16);
  });

  test('global declaration', () => {
    const decl = firstDecl('global counter: i32 = 0;');
    assert.equal(decl.kind, 'GlobalDecl');
    assert.equal(decl.isMut, false);
  });

  test('mutable global', () => {
    const decl = firstDecl('global mut counter: i32 = 0;');
    assert.equal(decl.isMut, true);
  });
});

// ── Data and element segments ─────────────────────────────────────────────

describe('Data and element declarations', () => {
  test('data with integer array', () => {
    const decl = firstDecl('data Magic: i8[] = [0x00, 0x61, 0x73, 0x6D];');
    assert.equal(decl.kind, 'DataDecl');
  });

  test('data with utf8_32 string', () => {
    const decl = firstDecl('data AppName: utf8_32 = "MyApp";');
    assert.equal(decl.name, 'AppName');
  });

  test('data with cstr', () => {
    const decl = firstDecl('data Greeting: cstr = "hello";');
    assert.equal(decl.name, 'Greeting');
  });

  test('element segment', () => {
    const decl = firstDecl('elem Handlers: funcref[] = [onClick, onResize];');
    assert.equal(decl.kind, 'ElemDecl');
    assert.equal(decl.items.length, 2);
  });

  test('memory placement', () => {
    const ast = parseOk('memory Mem = 1;\ndata D: i8[] = [1, 2, 3];\nMem[0] = D;');
    const init = ast.decls.find(d => d.kind === 'MemoryInit');
    assert.ok(init != null);
    assert.equal(init.memory, 'Mem');
  });
});

// ── Tags ──────────────────────────────────────────────────────────────────

describe('Tag declarations', () => {
  test('tag declaration', () => {
    const decl = firstDecl('tag DivError: (i32, i32);');
    assert.equal(decl.kind, 'TagDecl');
    assert.equal(decl.name, 'DivError');
    assert.equal(decl.params.length, 2);
  });

  test('exported tag', () => {
    const decl = firstDecl('@export tag AppError: (i32);');
    assert.ok(decl.decorators.some(d => d.name === 'export'));
  });
});

// ── Control flow statements ───────────────────────────────────────────────

describe('Control flow', () => {
  test('if statement', () => {
    const decl = firstDecl('f(): () { if (x == 0) { nop; } }');
    assert.equal(decl.body[0].kind, 'IfStmt');
  });

  test('if-else statement', () => {
    const decl = firstDecl('f(): () { if (x) { nop; } else { nop; } }');
    assert.ok(decl.body[0].else_ != null);
  });

  test('if-else-if chain', () => {
    const decl = firstDecl('f(): () { if (a) { nop; } else if (b) { nop; } else { nop; } }');
    assert.equal(decl.body[0].else_[0].kind, 'IfStmt');
  });

  test('loop with labels', () => {
    const decl = firstDecl("f(): () { loop { { 'start goto 'start if (1); } } }");
    assert.equal(decl.body[0].kind, 'LoopStmt');
    assert.equal(decl.body[0].blocks[0].labels[0].label, 'start');
  });

  test('break statement', () => {
    const decl = firstDecl('f(): () { loop { { break; } } }');
    assert.equal(decl.body[0].blocks[0].stmts[0].kind, 'BreakStmt');
  });

  test('break if', () => {
    const decl = firstDecl('f(): () { loop { { break if (done); } } }');
    assert.ok(decl.body[0].blocks[0].stmts[0].cond != null);
  });

  test('goto table', () => {
    const decl = firstDecl("f(): () { loop { { 'a nop; 'b nop; goto ['a,'b] idx; } } }");
    const stmts = decl.body[0].blocks[0].stmts;
    const gotoTable = stmts.find(s => s.kind === 'GotoTableStmt');
    assert.ok(gotoTable != null);
    assert.equal(gotoTable.labels.length, 2);
  });

  test('try-catch', () => {
    const decl = firstDecl('f(): () { try { nop; } catch DivError(a, b) { nop; } }');
    assert.equal(decl.body[0].kind, 'TryStmt');
    assert.equal(decl.body[0].catches[0].tag, 'DivError');
  });

  test('catch-all', () => {
    const decl = firstDecl('f(): () { try { nop; } catch { nop; } }');
    assert.equal(decl.body[0].catches[0].tag, null);
    assert.equal(decl.body[0].catches[0].params.length, 0);
  });

  test('throw statement', () => {
    const decl = firstDecl('f(): () { throw DivError(1, 2); }');
    assert.equal(decl.body[0].kind, 'ThrowStmt');
  });

  test('unreachable statement', () => {
    const decl = firstDecl('f(): () { unreachable; }');
    assert.equal(decl.body[0].kind, 'UnreachableStmt');
  });
});

// ── Expressions ───────────────────────────────────────────────────────────

describe('Expressions', () => {
  test('integer literal', () => {
    const decl = firstDecl('f(): i32 { return 42; }');
    assert.equal(decl.body[0].values[0].kind, 'IntLit');
    assert.equal(decl.body[0].values[0].value, 42n);
  });

  test('hex literal', () => {
    const decl = firstDecl('f(): i32 { return 0xFF; }');
    assert.equal(decl.body[0].values[0].value, 255n);
  });

  test('float literal', () => {
    const decl = firstDecl('f(): f64 { return 3.14; }');
    assert.equal(decl.body[0].values[0].kind, 'FloatLit');
  });

  test('null literal', () => {
    const decl = firstDecl('f(): anyref { return null; }');
    assert.equal(decl.body[0].values[0].kind, 'NullLit');
  });

  test('binary expression', () => {
    const decl = firstDecl('f(): i32 { return a + b; }');
    assert.equal(decl.body[0].values[0].kind, 'BinaryExpr');
    assert.equal(decl.body[0].values[0].op, '+');
  });

  test('unary minus', () => {
    const decl = firstDecl('f(): i32 { return -x; }');
    assert.equal(decl.body[0].values[0].kind, 'UnaryExpr');
    assert.equal(decl.body[0].values[0].op, '-');
  });

  test('logical not', () => {
    const decl = firstDecl('f(): i32 { return !x; }');
    assert.equal(decl.body[0].values[0].op, '!');
  });

  test('bitwise not', () => {
    const decl = firstDecl('f(): i32 { return ~x; }');
    assert.equal(decl.body[0].values[0].op, '~');
  });

  test('function call', () => {
    const decl = firstDecl('f(): i32 { return add(1, 2); }');
    assert.equal(decl.body[0].values[0].kind, 'CallExpr');
  });

  test('member access', () => {
    const decl = firstDecl('f(): i32 { return p.x; }');
    assert.equal(decl.body[0].values[0].kind, 'MemberExpr');
    assert.equal(decl.body[0].values[0].field, 'x');
  });

  test('index expression', () => {
    const decl = firstDecl('f(): i32 { return arr[0]; }');
    assert.equal(decl.body[0].values[0].kind, 'IndexExpr');
  });

  test('index field expression ptr[n].field', () => {
    const decl = firstDecl('f(): i32 { return ptr[0].x; }');
    assert.equal(decl.body[0].values[0].kind, 'IndexFieldExpr');
    assert.equal(decl.body[0].values[0].field, 'x');
  });

  test('select expression', () => {
    const decl = firstDecl('f(): i32 { return select(c, a, b); }');
    assert.equal(decl.body[0].values[0].kind, 'SelectExpr');
  });

  test('cast as', () => {
    const decl = firstDecl('f(): i32 { return r as Point; }');
    assert.equal(decl.body[0].values[0].kind, 'CastExpr');
    assert.equal(decl.body[0].values[0].isUnchecked, false);
  });

  test('cast as! unchecked', () => {
    const decl = firstDecl('f(): i32 { return r as! Point; }');
    // Parser consumes as!, sets isUnchecked
    assert.ok(decl.body[0].values[0] != null);
  });

  test('type test is', () => {
    const decl = firstDecl('f(): i32 { return r is Point; }');
    assert.equal(decl.body[0].values[0].kind, 'TestExpr');
  });

  test('new struct', () => {
    const decl = firstDecl('f(): i32 { return new Point { x: 1, y: 2 }; }');
    assert.equal(decl.body[0].values[0].kind, 'NewStructExpr');
  });

  test('new array', () => {
    const decl = firstDecl('f(): i32 { return new IntArray(10); }');
    assert.equal(decl.body[0].values[0].kind, 'NewArrayExpr');
  });

  test('sizeof expression', () => {
    const decl = firstDecl('f(): isize { return sizeof(Point); }');
    assert.equal(decl.body[0].values[0].kind, 'SizeofExpr');
  });

  test('ref(fn) expression', () => {
    const decl = firstDecl('f(): i32 { return ref(myFunc); }');
    assert.equal(decl.body[0].values[0].kind, 'RefFuncExpr');
    assert.equal(decl.body[0].values[0].name, 'myFunc');
  });

  test('if expression', () => {
    const decl = firstDecl('f(): i32 { return if (x > 0) { return x; } else { return 0; }; }');
    // if expression can appear in return
    assert.ok(decl.body[0] != null);
  });

  test('assignment statement', () => {
    const decl = firstDecl('f(): () { x = 5; }');
    assert.equal(decl.body[0].kind, 'AssignStmt');
    assert.equal(decl.body[0].op, '=');
  });

  test('compound assignment +=', () => {
    const decl = firstDecl('f(): () { x += 1; }');
    assert.equal(decl.body[0].op, '+=');
  });

  test('compound assignment -=', () => {
    const decl = firstDecl('f(): () { x -= 1; }');
    assert.equal(decl.body[0].op, '-=');
  });

  test('compound assignment *=', () => {
    const decl = firstDecl('f(): () { x *= 2; }');
    assert.equal(decl.body[0].op, '*=');
  });
});

// ── Operator precedence ───────────────────────────────────────────────────

describe('Operator precedence', () => {
  function exprOf(src) {
    return firstDecl(`f(): i32 { return ${src}; }`).body[0].values[0];
  }

  test('+ has lower precedence than *', () => {
    // a + b * c should parse as a + (b * c)
    const e = exprOf('a + b * c');
    assert.equal(e.kind, 'BinaryExpr');
    assert.equal(e.op, '+');
    assert.equal(e.right.op, '*');
  });

  test('&& has lower precedence than ==', () => {
    // a == b && c == d should parse as (a == b) && (c == d)
    const e = exprOf('a == b && c == d');
    assert.equal(e.op, '&&');
    assert.equal(e.left.op, '==');
  });

  test('|| has lower precedence than &&', () => {
    const e = exprOf('a || b && c');
    assert.equal(e.op, '||');
    assert.equal(e.right.op, '&&');
  });

  test('| has lower precedence than &', () => {
    const e = exprOf('a | b & c');
    assert.equal(e.op, '|');
    assert.equal(e.right.op, '&');
  });

  test('bitwise & has lower precedence than shift', () => {
    const e = exprOf('a & b << 2');
    assert.equal(e.op, '&');
    assert.equal(e.right.op, '<<');
  });

  test('unary minus has higher precedence than *', () => {
    const e = exprOf('-a * b');
    assert.equal(e.op, '*');
    assert.equal(e.left.op, '-');
  });

  test('parentheses override precedence', () => {
    const e = exprOf('(a + b) * c');
    assert.equal(e.op, '*');
    assert.equal(e.left.op, '+');
  });

  test('/s operator', () => {
    const e = exprOf('a /s b');
    assert.equal(e.op, '/s');
  });

  test('/u operator', () => {
    const e = exprOf('a /u b');
    assert.equal(e.op, '/u');
  });

  test('%s operator', () => {
    const e = exprOf('a %s b');
    assert.equal(e.op, '%s');
  });

  test('%u operator', () => {
    const e = exprOf('a %u b');
    assert.equal(e.op, '%u');
  });

  test('>>s operator', () => {
    const e = exprOf('a >>s 1');
    assert.equal(e.op, '>>s');
  });

  test('>>u operator', () => {
    const e = exprOf('a >>u 1');
    assert.equal(e.op, '>>u');
  });

  test('<< operator', () => {
    const e = exprOf('a << 2');
    assert.equal(e.op, '<<');
  });
});

// ── Error recovery ────────────────────────────────────────────────────────

describe('Error recovery', () => {
  test('missing semicolon is recovered', () => {
    const { ast, errors } = parse('f(): i32 { return 1 }');
    assert.ok(errors.length > 0);
    assert.ok(ast.decls.length > 0); // recovered
  });

  test('local in loop is an error', () => {
    const { errors } = parse('f(): () { loop { { local x: i32; } } }');
    assert.ok(errors.some(e => e.code === 'E218'));
  });

  test('unknown decorator is recovered', () => {
    const { ast, errors } = parse('@unknown f(): () { }');
    // Unknown decorator emits an error from lexer
    assert.ok(ast.decls.length > 0);
  });

  test('multiple errors collected', () => {
    const { errors } = parse('badDecl; anotherBadDecl;');
    assert.ok(errors.length >= 1);
  });

  test('valid code after error is parsed', () => {
    const { ast } = parse(';;;; f(): i32 { return 1; }');
    // At least one valid FuncDecl despite noise
    assert.ok(ast.decls.some(d => d.kind === 'FuncDecl'));
  });
});

// ── Pointers ──────────────────────────────────────────────────────────────

describe('Pointer types', () => {
  test('pointer type *T', () => {
    const decl = firstDecl('f(): () { local ptr: *Point; }');
    assert.equal(decl.locals[0].typeExpr.kind, 'PointerType');
    assert.equal(decl.locals[0].typeExpr.memory, null);
  });

  test('pointer type *T@Mem', () => {
    const decl = firstDecl('f(): () { local ptr: *Point@Mem; }');
    assert.equal(decl.locals[0].typeExpr.memory, 'Mem');
  });
});
