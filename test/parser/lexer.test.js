/**
 * @fileoverview Lexer unit tests.
 *
 * Tests the Lexer class directly by tokenizing inputs and checking
 * the resulting token stream for correct types, values, and locations.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Lexer } from '../../src/parser/lexer.js';

function tokenize(source) {
  return new Lexer(source, 'test.wml').tokenize();
}

function collected(source) {
  return tokenize(source).filter(t => t.type !== 'EOF');
}

function typesOf(source) {
  return collected(source).map(t => t.type);
}

// ── Basic tokens ────────────────────────────────────────────────────────────

describe('Basic tokens', () => {
  test('empty source produces only EOF', () => {
    const tokens = tokenize('');
    assert.equal(tokens.length, 1);
    assert.equal(tokens[0].type, 'EOF');
  });

  test('identifier', () => {
    const tokens = collected('hello');
    assert.equal(tokens.length, 1);
    assert.equal(tokens[0].type, 'IDENT');
    assert.equal(tokens[0].value, 'hello');
  });

  test('integer literal', () => {
    const tokens = collected('42');
    assert.equal(tokens[0].type, 'INT_LIT');
  });

  test('hex literal', () => {
    const tokens = collected('0xFF');
    assert.equal(tokens[0].type, 'INT_LIT');
  });

  test('binary literal', () => {
    const tokens = collected('0b1010');
    assert.equal(tokens[0].type, 'INT_LIT');
  });

  test('float literal', () => {
    const tokens = collected('3.14');
    assert.equal(tokens[0].type, 'FLOAT_LIT');
  });

  test('string literal', () => {
    const tokens = collected('"hello"');
    assert.equal(tokens[0].type, 'STRING_LIT');
    assert.equal(tokens[0].value, 'hello');
  });
});

// ── Keywords ────────────────────────────────────────────────────────────────

describe('Keywords', () => {
  const keywords = [
    'return', 'if', 'else', 'loop', 'break', 'goto',
    'local', 'global', 'mut', 'memory', 'table',
    'type', 'struct', 'final', 'extends', 'rec',
    'data', 'elem', 'tag', 'try', 'catch', 'throw',
    'nop', 'unreachable', 'select', 'null', 'new', 'sizeof',
    'shared', 'section', 'tail',
  ];

  for (const kw of keywords) {
    test(kw, () => {
      const tokens = collected(kw);
      assert.equal(tokens[0].type, kw, `Expected keyword type '${kw}'`);
    });
  }

  test('ref is parsed as IDENT (not a keyword)', () => {
    const tokens = collected('ref');
    assert.equal(tokens[0].type, 'IDENT');
  });
});

// ── Operators and punctuation ───────────────────────────────────────────────

describe('Operators and punctuation', () => {
  const ops = ['+', '-', '*', '(', ')', '{', '}', '[', ']', ';', ':', ',', '=', '.'];

  for (const op of ops) {
    test(op, () => {
      const tokens = collected(op);
      assert.equal(tokens[0].type, op);
    });
  }

  test('! resolves as NOT', () => {
    const tokens = collected('!');
    assert.equal(tokens[0].type, '!');
  });
});

// ── Multi-char operators ────────────────────────────────────────────────────

describe('Multi-char operators', () => {
  test('==', () => {
    const t = collected('==');
    assert.equal(t[0].type, '==');
  });

  test('!=', () => {
    const t = collected('!=');
    assert.equal(t[0].type, '!=');
  });

  test('<=', () => {
    const t = collected('<=');
    assert.equal(t[0].type, '<=');
  });

  test('>=', () => {
    const t = collected('>=');
    assert.equal(t[0].type, '>=');
  });

  test('->', () => {
    const t = collected('->');
    assert.equal(t[0].type, '->');
  });

  test('..', () => {
    const t = collected('..');
    assert.equal(t[0].type, '..');
  });

  test('&&', () => {
    const t = collected('&&');
    assert.equal(t[0].type, '&&');
  });

  test('||', () => {
    const t = collected('||');
    assert.equal(t[0].type, '||');
  });

  test('/s', () => {
    const t = collected('/s');
    assert.equal(t[0].type, '/s');
  });

  test('/u', () => {
    const t = collected('/u');
    assert.equal(t[0].type, '/u');
  });

  test('>>s', () => {
    const t = collected('>>s');
    assert.equal(t[0].type, '>>s');
  });

  test('>>u', () => {
    const t = collected('>>u');
    assert.equal(t[0].type, '>>u');
  });

  test('<<', () => {
    const t = collected('<<');
    assert.equal(t[0].type, '<<');
  });

  test('+=', () => {
    const t = collected('+=');
    assert.equal(t[0].type, '+=');
  });
});

// ── Comments ────────────────────────────────────────────────────────────────

describe('Comments', () => {
  test('line comment is skipped', () => {
    const t = collected('// comment\n42');
    assert.equal(t.length, 1);
    assert.equal(t[0].type, 'INT_LIT');
  });

  test('block comment is skipped', () => {
    const t = collected('/* comment */42');
    assert.equal(t.length, 1);
    assert.equal(t[0].type, 'INT_LIT');
  });

  test('multi-line block comment', () => {
    const t = collected('/* line1\nline2 */42');
    assert.equal(t.length, 1);
    assert.equal(t[0].type, 'INT_LIT');
  });
});

// ── Decorators ──────────────────────────────────────────────────────────────

describe('Decorators', () => {
  test('@export', () => {
    const t = collected('@export');
    assert.equal(t[0].type, '@export');
  });

  test('@import', () => {
    const t = collected('@import');
    assert.equal(t[0].type, '@import');
  });

  test('@start', () => {
    const t = collected('@start');
    assert.equal(t[0].type, '@start');
  });
});

// ── Location tracking ───────────────────────────────────────────────────────

describe('Location tracking', () => {
  test('tokens track line and column', () => {
    const tokens = collected('a\nb\nc');
    assert.equal(tokens[0].line, 1);
    assert.equal(tokens[0].col, 1);
    assert.equal(tokens[1].line, 2);
    assert.equal(tokens[1].col, 1);
    assert.equal(tokens[2].line, 3);
    assert.equal(tokens[2].col, 1);
  });
});

// ── String escapes ──────────────────────────────────────────────────────────

describe('String escapes', () => {
  test('basic escape sequences', () => {
    const t = collected('"a\\nb\\tc"');
    assert.equal(t[0].value, 'a\nb\tc');
  });

  test('hex escape', () => {
    const t = collected('"\\x41"');
    assert.equal(t[0].value, 'A');
  });
});
