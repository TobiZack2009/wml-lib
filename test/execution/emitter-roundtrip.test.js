/**
 * @fileoverview Emitter roundtrip tests.
 *
 * Validates the WAT emitter produces syntactically valid WAT by
 * round-tripping through Binaryen's parseText + validate.
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

function compileAndRoundtrip(source) {
  const tokens  = new Lexer(source, 'test.wml').tokenize();
  const { ast, errors: parseErrors } = new Parser(tokens, 'test.wml').parse();
  const { errors: valErrors, symbols } = validateModule(ast, 'test.wml');
  const allErrors = [...parseErrors, ...valErrors].filter(e => e.severity === 'error');
  const errorsOk  = allErrors.length === 0;

  let wat = errorsOk ? new WatEmitter(ast, symbols).emit() : null;

  // Binaryen does not accept the optional "then" keyword on its own line
  if (wat) wat = wat.replace(/^\s*then\s*$/gm, '');
  // Binaryen does not accept (memory $Name) on load/store instructions
  if (wat) wat = wat.replace(/\(memory\s+\$\w+\)/g, '');

  let watOk = false;
  let watError = null;
  if (wat) {
    try {
      const mod = binaryen.parseText(wat);
      mod.setFeatures(FEATURES);
      watOk = mod.validate();
      mod.dispose();
    } catch (e) {
      watError = e.message;
    }
  }

  return { errors: allErrors, wat, watOk, watError };
}

describe('Emitter roundtrip', { skip: skipIfNoBinaryen() }, () => {
  test('simple function roundtrips', () => {
    const r = compileAndRoundtrip('f(): () { }');
    assert.equal(r.errors.length, 0);
    assert.ok(r.watOk, `WAT validation failed: ${r.watError}`);
  });

  test('arithmetic roundtrips', () => {
    const r = compileAndRoundtrip('add(a: i32, b: i32): i32 { return a + b; }');
    assert.equal(r.errors.length, 0);
    assert.ok(r.watOk, `WAT validation failed: ${r.watError}`);
  });

  test('control flow roundtrips', () => {
    const r = compileAndRoundtrip(`
      f(c: i32): i32 {
        local r: i32 = 0;
        if (c) { r = 1; } else { r = 2; }
        loop { { 'top break if (r >= 10); r += 1; goto 'top if (0); } }
        return r;
      }
    `);
    assert.equal(r.errors.length, 0);
    assert.ok(r.watOk, `WAT validation failed: ${r.watError}`);
  });

  test('global and import roundtrip', () => {
    const r = compileAndRoundtrip(`
      @import("env","log") log(n: i32): ();
      global counter: i32 = 0;
      @export f(): i32 { return counter; }
    `);
    assert.equal(r.errors.length, 0);
    assert.ok(r.watOk, `WAT validation failed: ${r.watError}`);
  });

  test('table and call_indirect roundtrip', () => {
    const r = compileAndRoundtrip(`
      type BinaryOp = (i32, i32) => i32;
      table FuncTable: [funcref] = 4;
      f(op: i32, a: i32, b: i32): i32 { return FuncTable[op]<BinaryOp>(a, b); }
    `);
    assert.equal(r.errors.length, 0);
    assert.ok(r.watOk, `WAT validation failed: ${r.watError}`);
  });

  test('struct type roundtrips', () => {
    const r = compileAndRoundtrip(`
      type Point = struct { x: i32; mut y: i32; };
      f(): Point { return new Point { x: 1, y: 2 }; }
    `);
    assert.equal(r.errors.length, 0);
    assert.ok(r.watOk, `WAT validation failed: ${r.watError}`);
  });

  test('multi-return roundtrips', () => {
    const r = compileAndRoundtrip('f(): (i32, i32) { return (1, 2); }');
    assert.equal(r.errors.length, 0);
    assert.ok(r.watOk, `WAT validation failed: ${r.watError}`);
  });
});
