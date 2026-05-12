/**
 * @fileoverview Error diagnostic utilities tests.
 *
 * Tests for mkError, mkWarning, groupByFile, formatText, formatJSON.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkError,
  mkWarning,
  groupByFile,
  formatText,
  formatJSON,
} from '../../src/diagnostics/errors.js';

const LOC = { file: 'test.wml', line: 1, col: 5, endLine: 1, endCol: 10 };

// ── mkError / mkWarning ─────────────────────────────────────────────────────

describe('mkError', () => {
  test('creates error with correct properties', () => {
    const err = mkError('E100', 'type mismatch', 'expected i32, got f64', null, LOC);
    assert.equal(err.code, 'E100');
    assert.equal(err.category, 'TypeError');
    assert.equal(err.kind, 'TypeMismatch');
    assert.equal(err.severity, 'error');
    assert.equal(err.message, 'type mismatch');
    assert.equal(err.detail, 'expected i32, got f64');
    assert.equal(err.recovered, false);
  });

  test('uses metadata hint when hint param is null', () => {
    const err = mkError('E100', 'type mismatch', 'detail', null, LOC);
    assert.equal(err.hint, 'Check the types on both sides of the expression');
  });

  test('override hint with explicit value', () => {
    const err = mkError('E100', 'type mismatch', 'detail', 'custom hint', LOC);
    assert.equal(err.hint, 'custom hint');
  });

  test('recovered defaults to false', () => {
    const err = mkError('E001', 'unexpected', 'detail', null, LOC);
    assert.equal(err.recovered, false);
  });

  test('recovered can be set to true', () => {
    const err = mkError('E001', 'unexpected', 'detail', null, LOC, true);
    assert.equal(err.recovered, true);
  });

  test('unknown code gets fallback category and kind', () => {
    const err = mkError('E999', 'custom', 'detail', null, LOC);
    assert.equal(err.category, 'Error');
    assert.equal(err.kind, 'E999');
  });
});

describe('mkWarning', () => {
  test('creates warning with correct properties', () => {
    const warn = mkWarning('W001', 'unused data', 'Data segment never placed', null, LOC);
    assert.equal(warn.code, 'W001');
    assert.equal(warn.category, 'Warning');
    assert.equal(warn.kind, 'UnusedData');
    assert.equal(warn.severity, 'warning');
    assert.equal(warn.recovered, false);
  });

  test('warning hint defaults to metadata', () => {
    const warn = mkWarning('W001', 'unused', 'detail', null, LOC);
    assert.equal(warn.hint, null); // W001 has no hint in metadata
  });
});

// ── groupByFile ─────────────────────────────────────────────────────────────

describe('groupByFile', () => {
  test('empty array returns empty', () => {
    assert.deepEqual(groupByFile([]), []);
  });

  test('groups diagnostics by file', () => {
    const locA = { ...LOC, file: 'a.wml' };
    const locB = { ...LOC, file: 'b.wml' };
    const diags = [
      mkError('E001', 'msg', '', null, locA),
      mkWarning('W001', 'warn', '', null, locB),
      mkError('E100', 'type', '', null, locA),
    ];
    const grouped = groupByFile(diags);
    assert.equal(grouped.length, 2);
    const aGroup = grouped.find(g => g.file === 'a.wml');
    const bGroup = grouped.find(g => g.file === 'b.wml');
    assert.equal(aGroup.diagnostics.length, 2);
    assert.equal(bGroup.diagnostics.length, 1);
  });

  test('handles missing location file', () => {
    const diags = [mkError('E001', 'msg', '', null, { ...LOC, file: null })];
    const grouped = groupByFile(diags);
    assert.equal(grouped.length, 1);
    assert.equal(grouped[0].file, 'unknown');
  });

  test('sorts by line then column', () => {
    const diags = [
      mkError('E001', 'msg', '', null, { ...LOC, line: 5, col: 10 }),
      mkError('E002', 'msg', '', null, { ...LOC, line: 3, col: 5 }),
      mkError('E003', 'msg', '', null, { ...LOC, line: 3, col: 1 }),
    ];
    const grouped = groupByFile(diags);
    const sorted = grouped[0].diagnostics;
    assert.ok(sorted[0].location.line <= sorted[1].location.line);
  });
});

// ── formatText ──────────────────────────────────────────────────────────────

describe('formatText', () => {
  test('no diagnostics shows ok', () => {
    const output = formatText([], {});
    assert.ok(output.includes('0 errors'));
    assert.ok(output.includes('ok'));
  });

  test('error output includes code and message', () => {
    const diags = [mkError('E100', 'type mismatch', 'detail', null, LOC)];
    const output = formatText(diags, { 'test.wml': 'line 1\ntype mismatch here\nline 3' }, { color: false });
    assert.ok(output.includes('error[E100]'));
    assert.ok(output.includes('type mismatch'));
    assert.ok(output.includes('test.wml:1:5'));
    assert.ok(output.includes('1 error'));
  });

  test('warning output includes warning label', () => {
    const diags = [mkWarning('W001', 'unused', 'detail', null, LOC)];
    const output = formatText(diags, {}, { color: false });
    assert.ok(output.includes('warning[W001]'));
    assert.ok(output.includes('1 warning'));
  });

  test('hint appears in output', () => {
    const diags = [mkError('E100', 'type mismatch', 'detail', null, LOC)];
    const output = formatText(diags, {}, { color: false });
    assert.ok(output.includes('hint:'));
  });

  test('max errors truncates', () => {
    const diags = [
      mkError('E001', 'one', 'detail', null, { ...LOC, line: 1 }),
      mkError('E001', 'two', 'detail', null, { ...LOC, line: 2 }),
    ];
    const output = formatText(diags, {}, { color: false, maxErrors: 1 });
    assert.ok(output.includes('more errors not shown'));
  });

  test('error + warning summary both counted', () => {
    const diags = [
      mkError('E001', 'err', '', null, { ...LOC, line: 1 }),
      mkWarning('W001', 'warn', '', null, { ...LOC, line: 2 }),
    ];
    const output = formatText(diags, {}, { color: false });
    assert.ok(output.includes('1 error'));
    assert.ok(output.includes('1 warning'));
  });
});

// ── formatJSON ──────────────────────────────────────────────────────────────

describe('formatJSON', () => {
  test('no diagnostics produces only summary', () => {
    const output = formatJSON([]);
    const lines = output.trim().split('\n');
    assert.equal(lines.length, 1);
    const summary = JSON.parse(lines[0]);
    assert.equal(summary.type, 'summary');
    assert.equal(summary.success, true);
  });

  test('each diagnostic becomes one JSON line', () => {
    const diags = [
      mkError('E001', 'err', '', null, LOC),
      mkWarning('W001', 'warn', '', null, { ...LOC, line: 2 }),
    ];
    const output = formatJSON(diags);
    const lines = output.trim().split('\n');
    assert.equal(lines.length, 3); // 2 diags + summary
    const first = JSON.parse(lines[0]);
    assert.equal(first.code, 'E001');
    assert.equal(first.severity, 'error');
    const second = JSON.parse(lines[1]);
    assert.equal(second.code, 'W001');
    assert.equal(second.severity, 'warning');
  });

  test('summary reports correct error count and success', () => {
    const diags = [
      mkError('E001', 'err', '', null, LOC),
    ];
    const output = formatJSON(diags);
    const lines = output.trim().split('\n');
    const summary = JSON.parse(lines[lines.length - 1]);
    assert.equal(summary.errors, 1);
    assert.equal(summary.success, false);
  });

  test('max errors truncates', () => {
    const diags = [
      mkError('E001', 'one', '', null, { ...LOC, line: 1 }),
      mkError('E001', 'two', '', null, { ...LOC, line: 2 }),
    ];
    const output = formatJSON(diags, { maxErrors: 1 });
    const lines = output.trim().split('\n');
    assert.equal(lines.length, 2); // 1 diag + summary
    const summary = JSON.parse(lines[1]);
    assert.equal(summary.limitReached, true);
  });
});
