/**
 * @fileoverview CLI tests.
 *
 * Tests the CLI entry point by spawning the wml command.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CLI = 'node src/cli/index.js';

function run(args) {
  try {
    const stdout = execSync(`${CLI} ${args}`, { encoding: 'utf8', cwd: process.cwd() });
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    return {
      code: e.status,
      stdout: e.stdout?.toString() ?? '',
      stderr: e.stderr?.toString() ?? '',
    };
  }
}

describe('CLI help and version', () => {
  test('no args prints help and exits 0', () => {
    const r = run('');
    assert.equal(r.code, 0);
    assert.ok(r.stdout.includes('wml'));
  });

  test('--help exits 0', () => {
    const r = run('--help');
    assert.equal(r.code, 0);
    assert.ok(r.stdout.includes('wml'));
  });

  test('compile --version prints version', () => {
    const r = run('compile -v');
    assert.equal(r.code, 0);
    assert.ok(/wml \d+\.\d+\.\d+/.test(r.stdout.trim()));
  });
});

describe('CLI errors', () => {
  test('unknown command exits 1', () => {
    const r = run('bogus');
    assert.equal(r.code, 1);
    assert.ok(r.stderr.includes('Unknown command'));
  });

  test('unknown option flag exits 1', () => {
    const r = run('compile --bogus');
    assert.equal(r.code, 1);
    assert.ok(r.stderr.includes('Unknown option'));
  });

  test('compile with no files exits 1', () => {
    const r = run('compile');
    assert.equal(r.code, 1);
    assert.ok(r.stderr.includes('No input files'));
  });
});

describe('CLI compile', () => {
  let tmpDir;
  let testFile;

  test.before(() => {
    tmpDir   = mkdtempSync(join(tmpdir(), 'wml-test-'));
    testFile = join(tmpDir, 'test.wml');
    writeFileSync(testFile, '@export add(a: i32, b: i32): i32 { return a + b; }');
  });

  test.after(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  test('compile file to stdout produces WAT', () => {
    const r = run(`compile ${testFile}`);
    assert.equal(r.code, 0);
    assert.ok(r.stdout.includes('(module'));
  });
});
