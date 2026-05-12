/**
 * @fileoverview Linker tests.
 *
 * Tests the Linker class which merges multiple parsed WML modules
 * into a single coherent module AST.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Lexer }   from '../../src/parser/lexer.js';
import { Parser }  from '../../src/parser/parser.js';
import { validateModule } from '../../src/validator/index.js';
import { Linker }  from '../../src/linker.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

function parseSource(source, name = 'test.wml') {
  const tokens  = new Lexer(source, name).tokenize();
  const { ast } = new Parser(tokens, name).parse();
  const { errors, symbols } = validateModule(ast, name);
  // Allow warnings but error on actual errors — linker tests need valid ASTs
  const errs = errors.filter(e => e.severity === 'error');
  if (errs.length > 0) {
    throw new Error(`Validation errors in ${name}:\n${errs.map(e => `${e.code}: ${e.message}`).join('\n')}`);
  }
  return { ast, symbols, name };
}

function linkSources(sources) {
  const linker = new Linker(sources);
  return linker.link();
}

function linkerErrors(sources) {
  return linkSources(sources).errors;
}

function hasLinkerError(sources, code) {
  return linkerErrors(sources).some(e => e.code === code);
}

// ── Basic merging ───────────────────────────────────────────────────────────

describe('Basic linking', () => {
  test('single source passes through', () => {
    const { ast } = parseSource('f(): i32 { return 0; }');
    const result = linkSources([{ name: 'a.wml', ast: ast, symbols: new Map() }]);
    assert.equal(result.errors.length, 0);
    assert.equal(result.ast.decls.length, 1);
    assert.equal(result.ast.decls[0].name, 'f');
  });

  test('two sources merge declarations', () => {
    const a = parseSource('f(): i32 { return 0; }', 'a.wml');
    const b = parseSource('g(): i32 { return 1; }', 'b.wml');
    const result = linkSources([
      { name: 'a.wml', ast: a.ast, symbols: new Map() },
      { name: 'b.wml', ast: b.ast, symbols: new Map() },
    ]);
    assert.equal(result.errors.length, 0);
    assert.equal(result.ast.decls.length, 2);
    assert.equal(result.ast.decls[0].name, 'f');
    assert.equal(result.ast.decls[1].name, 'g');
  });
});

// ── Duplicate detection ─────────────────────────────────────────────────────

describe('Duplicate detection', () => {
  test('same name in two sources is E201', () => {
    const a = parseSource('global x: i32 = 0;', 'a.wml');
    const b = parseSource('global x: i32 = 0;', 'b.wml');
    assert.ok(hasLinkerError([
      { name: 'a.wml', ast: a.ast, symbols: new Map() },
      { name: 'b.wml', ast: b.ast, symbols: new Map() },
    ], 'E201'));
  });
});

// ── Exports last-wins ──────────────────────────────────────────────────────

describe('Export override', () => {
  test('exported function last-wins', () => {
    const a = parseSource('@export f(): i32 { return 0; }', 'a.wml');
    const b = parseSource('@export f(): i32 { return 1; }', 'b.wml');
    const result = linkSources([
      { name: 'a.wml', ast: a.ast, symbols: new Map() },
      { name: 'b.wml', ast: b.ast, symbols: new Map() },
    ]);
    assert.equal(result.errors.length, 0);
    // Both declarations present, last win means no E201 error
    assert.equal(result.ast.decls.length, 2);
  });
});

// ── Import deduplication ─────────────────────────────────────────────────────

describe('Import deduplication', () => {
  test('same import deduplicated', () => {
    const a = parseSource('@import("env","log") log(n: i32): ();', 'a.wml');
    const b = parseSource('@import("env","log") log(n: i32): ();', 'b.wml');
    const result = linkSources([
      { name: 'a.wml', ast: a.ast, symbols: new Map() },
      { name: 'b.wml', ast: b.ast, symbols: new Map() },
    ]);
    assert.equal(result.errors.length, 0);
    // Deduplicated — only one import declaration in output
    assert.equal(result.ast.decls.length, 1);
  });

  test('conflicting import signatures is E506', () => {
    const a = parseSource('@import("env","log") log(n: i32): ();', 'a.wml');
    const b = parseSource('@import("env","log") log(n: i64): ();', 'b.wml');
    assert.ok(hasLinkerError([
      { name: 'a.wml', ast: a.ast, symbols: new Map() },
      { name: 'b.wml', ast: b.ast, symbols: new Map() },
    ], 'E506'));
  });
});

// ── Synthetic __start ───────────────────────────────────────────────────────

describe('Synthetic __start', () => {
  test('multiple @start creates synthetic __start', () => {
    const a = parseSource('@start initA(): () { }', 'a.wml');
    const b = parseSource('@start initB(): () { }', 'b.wml');
    const result = linkSources([
      { name: 'a.wml', ast: a.ast, symbols: new Map() },
      { name: 'b.wml', ast: b.ast, symbols: new Map() },
    ]);
    assert.equal(result.errors.length, 0);
    const synStart = result.ast.decls.find(d => d.name === '__start');
    assert.ok(synStart != null, 'Expected synthetic __start function');
    assert.equal(synStart.decorators.some(d => d.name === 'start'), true);
  });

  test('single @start does not create synthetic', () => {
    const a = parseSource('@start init(): () { }', 'a.wml');
    const result = linkSources([
      { name: 'a.wml', ast: a.ast, symbols: new Map() },
    ]);
    assert.equal(result.errors.length, 0);
    const synStart = result.ast.decls.find(d => d.name === '__start');
    assert.equal(synStart, undefined);
  });
});

// ── Exposed symbols ─────────────────────────────────────────────────────────

describe('Exposed symbols', () => {
  test('expose ["*"] makes all symbols available', () => {
    const a = parseSource('global x: i32 = 0;\n@export f(): i32 { return x; }', 'a.wml');
    const b = parseSource('g(): i32 { return 1; }', 'b.wml');
    const symbols = new Map();
    symbols.set('x', { name: 'x', kind: 'Global' });
    symbols.set('f', { name: 'f', kind: 'Function' });
    const result = linkSources([
      { name: 'a.wml', ast: a.ast, symbols, expose: ['*'] },
      { name: 'b.wml', ast: b.ast, symbols: new Map() },
    ]);
    assert.equal(result.errors.length, 0);
    assert.ok(result.symbols.has('x'));
    assert.ok(result.symbols.has('f'));
  });

  test('expose unknown name is E200', () => {
    const a = parseSource('f(): i32 { return 0; }', 'a.wml');
    const symbols = new Map();
    symbols.set('f', { name: 'f', kind: 'Function' });
    assert.ok(hasLinkerError([
      { name: 'a.wml', ast: a.ast, symbols, expose: ['missing'] },
    ], 'E200'));
  });
});
