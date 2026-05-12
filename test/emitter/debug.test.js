/**
 * @fileoverview DebugEmitter tests.
 *
 * Tests the DebugEmitter class which builds name sections and source maps.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Lexer }    from '../../src/parser/lexer.js';
import { Parser }   from '../../src/parser/parser.js';
import { DebugEmitter } from '../../src/emitter/debug.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

function parseSource(source) {
  const tokens  = new Lexer(source, 'test.wml').tokenize();
  const { ast } = new Parser(tokens, 'test.wml').parse();
  return ast;
}

// ── BuildNameSection ────────────────────────────────────────────────────────

describe('buildNameSection', () => {
  test('empty ast produces empty maps', () => {
    const ast = { decls: [] };
    const names = DebugEmitter.buildNameSection(ast, new Map());
    assert.equal(names.functions.size, 0);
    assert.equal(names.locals.size, 0);
    assert.equal(names.types.size, 0);
  });

  test('single function gets correct index', () => {
    const ast = parseSource('f(): i32 { return 0; }');
    const names = DebugEmitter.buildNameSection(ast, new Map());
    assert.equal(names.functions.size, 1);
    assert.equal(names.functions.get(0), 'f');
  });

  test('two functions get sequential indices', () => {
    const ast = parseSource('f(): i32 { return 0; }\ng(): i32 { return 1; }');
    const names = DebugEmitter.buildNameSection(ast, new Map());
    assert.equal(names.functions.size, 2);
    assert.equal(names.functions.get(0), 'f');
    assert.equal(names.functions.get(1), 'g');
  });

  test('param names appear as locals', () => {
    const ast = parseSource('f(a: i32, b: i32): i32 { return a + b; }');
    const names = DebugEmitter.buildNameSection(ast, new Map());
    const func0 = names.locals.get(0);
    assert.ok(func0 != null);
    assert.equal(func0.get(0), 'a');
    assert.equal(func0.get(1), 'b');
  });

  test('local names appear after params', () => {
    const ast = parseSource('f(): i32 { local x: i32; local y: i32; return x; }');
    const names = DebugEmitter.buildNameSection(ast, new Map());
    const func0 = names.locals.get(0);
    assert.ok(func0 != null);
    assert.equal(func0.get(0), 'x');
    assert.equal(func0.get(1), 'y');
  });

  test('type declarations get indices', () => {
    const ast = parseSource('type Point = struct { x: i32; y: i32; };');
    const names = DebugEmitter.buildNameSection(ast, new Map());
    assert.equal(names.types.size, 1);
    assert.equal(names.types.get(0), 'Point');
  });

  test('type and func mix', () => {
    const ast = parseSource(`
      type BinaryOp = (i32, i32) => i32;
      type Point = struct { x: i32; };
      f(): i32 { return 0; }
    `);
    const names = DebugEmitter.buildNameSection(ast, new Map());
    assert.equal(names.types.size, 2);
    assert.equal(names.types.get(0), 'BinaryOp');
    assert.equal(names.types.get(1), 'Point');
    assert.equal(names.functions.size, 1);
    assert.equal(names.functions.get(0), 'f');
  });
});

// ── BuildSourceMap ──────────────────────────────────────────────────────────

describe('buildSourceMap', () => {
  test('empty ast creates v3 source map', () => {
    const ast = { decls: [] };
    const mapStr = DebugEmitter.buildSourceMap(ast, new Map(), 'in.wml', 'out.wasm');
    const map = JSON.parse(mapStr);
    assert.equal(map.version, 3);
    assert.equal(map.file, 'out.wasm');
    assert.deepEqual(map.sources, ['in.wml']);
  });

  test('function with body creates source entries', () => {
    const ast = parseSource('f(): i32 { return 0; }');
    const mapStr = DebugEmitter.buildSourceMap(ast, new Map(), 'test.wml', 'out.wasm');
    const map = JSON.parse(mapStr);
    assert.equal(map.version, 3);
    assert.ok(map.mappings.length > 0);
  });

  test('name field contains symbol keys', () => {
    const symbols = new Map();
    symbols.set('f', { name: 'f' });
    const ast = parseSource('f(): i32 { return 0; }');
    const mapStr = DebugEmitter.buildSourceMap(ast, symbols, 'test.wml', 'out.wasm');
    const map = JSON.parse(mapStr);
    assert.ok(map.names.includes('f'));
  });
});

// ── VLQ encoding ────────────────────────────────────────────────────────────

describe('VLQ encoding (internal)', () => {
  // Access the internal encodeVLQ via buildSourceMap with known input
  test('empty mappings produce empty string', () => {
    const ast = { decls: [] };
    const mapStr = DebugEmitter.buildSourceMap(ast, new Map(), 'test.wml', 'out.wasm');
    const map = JSON.parse(mapStr);
    assert.equal(map.mappings, '');
  });

  test('non-empty mappings are base64-encoded', () => {
    const ast = parseSource('f(): i32 { return 0; }');
    const mapStr = DebugEmitter.buildSourceMap(ast, new Map(), 'test.wml', 'out.wasm');
    const map = JSON.parse(mapStr);
    assert.ok(map.mappings.length > 0);
    // VLQ uses A-Z/a-z/0-9/+/
    assert.ok(/^[A-Za-z0-9+/;,]*$/.test(map.mappings), 'Mappings should be valid base64 VLQ');
  });
});
