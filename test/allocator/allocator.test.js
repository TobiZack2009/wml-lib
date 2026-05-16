/**
 * @fileoverview Allocator integration tests.
 *
 * Tests the pool allocator through the full pipeline.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Lexer } from '../../src/parser/lexer.js';
import { Parser } from '../../src/parser/parser.js';
import { validateModule } from '../../src/validator/index.js';
import { WatEmitter } from '../../src/emitter/wat.js';

let binaryen;
try {
  binaryen = (await import('binaryen')).default;
} catch {
  binaryen = null;
}

function skipIfNoBinaryen() {
  return !binaryen;
}

function compileToWasm(source) {
  const tokens = new Lexer(source, 'allocator.wml').tokenize();
  const { ast, errors: parseErrors } = new Parser(tokens, 'allocator.wml').parse();
  const { errors: valErrors, symbols } = validateModule(ast, 'allocator.wml');
  const allErrors = [...parseErrors, ...valErrors].filter(e => e.severity === 'error');
  if (allErrors.length > 0) {
    throw new Error(`Compilation errors:\n${allErrors.map(e => `${e.code}: ${e.message}`).join('\n')}`);
  }
  let wat = new WatEmitter(ast, symbols).emit();
  wat = wat.replace(/^\s*then\s*$/gm, '');
  wat = wat.replace(/\(memory\s+\$\w+\)/g, '');
  const FEATURES = binaryen.Features.MVP | binaryen.Features.MutableGlobals |
    binaryen.Features.Multivalue | binaryen.Features.ReferenceTypes |
    binaryen.Features.BulkMemory | binaryen.Features.SignExt |
    binaryen.Features.TailCall | binaryen.Features.ExceptionHandling |
    binaryen.Features.GC;
  const mod = binaryen.parseText(wat);
  mod.setFeatures(FEATURES);
  if (!mod.validate()) {
    mod.dispose();
    throw new Error('Binaryen validation failed');
  }
  const wasm = mod.emitBinary();
  mod.dispose();
  return wasm;
}

async function instantiate(source) {
  const wasm = compileToWasm(source);
  const { instance } = await WebAssembly.instantiate(wasm);
  return instance.exports;
}

const ALLOCATOR_SOURCE = `
@export memory Mem = 64;

global HDR: i32 = 4;
global LHDR: i32 = 8;
global TAG_BIG: i32 = 0xFF;
global NPOOL: i32 = 8;
global META: i32 = 20;
global PGSZ: i32 = 65536;

global B00: i32 = 16;
global B01: i32 = 32;
global B02: i32 = 64;
global B03: i32 = 128;
global B04: i32 = 256;
global B05: i32 = 512;
global B06: i32 = 1024;
global B07: i32 = 2048;

global mut g_base: i32 = 0;
global mut g_limit: i32 = 0;
global mut g_brk: i32 = 0;
global mut g_large: i32 = 0;
global mut g_ready: i32 = 0;

poolField(pool: i32, field: i32): i32 {
  return g_base + pool * 20 + field * 4;
}

blockSize(idx: i32): i32 {
  if (idx == 0) { return 16; }
  if (idx == 1) { return 32; }
  if (idx == 2) { return 64; }
  if (idx == 3) { return 128; }
  if (idx == 4) { return 256; }
  if (idx == 5) { return 512; }
  if (idx == 6) { return 1024; }
  return 2048;
}

findPool(n: i32): i32 {
  local need: i32 = n + 4;
  if (need <= 16) { return 0; }
  if (need <= 32) { return 1; }
  if (need <= 64) { return 2; }
  if (need <= 128) { return 3; }
  if (need <= 256) { return 4; }
  if (need <= 512) { return 5; }
  if (need <= 1024) { return 6; }
  if (need <= 2048) { return 7; }
  return -1;
}

growPool(idx: i32): i32 {
  local bsize: i32;
  local pageAddr: i32;
  local newBrk: i32;
  local deficit: i32;
  local pages: i32;
  local oldSz: i32;
  local addr: i32;
  local pageEnd: i32;
  local last: i32;
  local nxt: i32;
  local oldHead: i32;
  local pc: i32;
  local fc: i32;

  bsize = blockSize(idx);
  pageAddr = g_brk;
  newBrk = g_brk + 65536;

  if (newBrk > g_limit) {
    deficit = newBrk - g_limit;
    pages = (deficit + 65535) / 65536;
    oldSz = Mem.grow(pages);
    if (oldSz < 0) { return 0; }
    g_limit += pages * 65536;
  }
  g_brk = newBrk;

  addr = pageAddr;
  pageEnd = pageAddr + 65536;
  loop {
    { 'walk
      nxt = addr + bsize;
      break if (nxt >= pageEnd);
      addr = nxt;
      goto 'walk if (0);
    }
  }
  last = addr;

  oldHead = Mem.load<i32>(poolField(idx, 1));
  Mem.store<i32>(last, oldHead);

  addr = pageAddr;
  loop {
    { 'link
      nxt = addr + bsize;
      break if (nxt > last);
      Mem.store<i32>(addr, nxt);
      addr = nxt;
      goto 'link if (0);
    }
  }

  Mem.store<i32>(poolField(idx, 1), pageAddr);

  pc = Mem.load<i32>(poolField(idx, 2));
  Mem.store<i32>(poolField(idx, 2), pc + 1);

  fc = Mem.load<i32>(poolField(idx, 4));
  Mem.store<i32>(poolField(idx, 4), fc + 65536 / bsize);

  return pageAddr;
}

@export heap_init(start: i32, size: i32): () {
  local i: i32;

  g_base = start;
  g_limit = start + size;
  g_brk = start + 8 * 20;
  g_large = g_brk;
  g_ready = 1;

  i = 0;
  loop {
    { 'init
      break if (i >= 8);
      Mem.store<i32>(poolField(i, 0), blockSize(i));
      Mem.store<i32>(poolField(i, 1), 0);
      Mem.store<i32>(poolField(i, 2), 0);
      Mem.store<i32>(poolField(i, 3), 0);
      Mem.store<i32>(poolField(i, 4), 0);
      i += 1;
      goto 'init if (0);
    }
  }
}

@export wmalloc(n: i32): i32 {
  local pool: i32;
  local head: i32;
  local addr: i32;
  local next: i32;
  local used: i32;
  local fcnt: i32;
  local allocSize: i32;
  local result: i32;
  local newLarge: i32;
  local deficit: i32;
  local pages: i32;
  local oldSz: i32;

  if (!g_ready) { return 0; }
  if (n <= 0) { return 0; }

  pool = findPool(n);
  if (pool >= 0) {
    loop {
      { 'tryPool
        head = Mem.load<i32>(poolField(pool, 1));
        break if (head != 0);
        addr = growPool(pool);
        if (addr == 0) { return 0; }
        goto 'tryPool if (0);
      }
    }

    next = Mem.load<i32>(head);
    Mem.store<i32>(poolField(pool, 1), next);

    Mem.store<i32>(head, pool);

    used = Mem.load<i32>(poolField(pool, 3));
    fcnt = Mem.load<i32>(poolField(pool, 4));
    Mem.store<i32>(poolField(pool, 3), used + 1);
    Mem.store<i32>(poolField(pool, 4), fcnt - 1);

    return head + 4;
  }

  allocSize = n + 8;
  result = g_large;
  newLarge = g_large + allocSize;
  if (newLarge > g_limit) {
    deficit = newLarge - g_limit;
    pages = (deficit + 65535) / 65536;
    oldSz = Mem.grow(pages);
    if (oldSz < 0) { return 0; }
    g_limit += pages * 65536;
  }
  g_large = newLarge;

  Mem.store<i32>(result, 255);
  Mem.store<i32>(result + 4, allocSize);

  return result + 8;
}

@export wfree(ptr: i32): () {
  local header: i32;
  local blk: i32;
  local pool: i32;
  local head: i32;
  local used: i32;
  local fcnt: i32;

  if (ptr == 0 || !g_ready) { return; }

  header = ptr - 4;
  blk = Mem.load<i32>(header);

  if (blk == 255) { return; }

  pool = blk;
  if (pool < 0 || pool >= 8) { return; }

  head = Mem.load<i32>(poolField(pool, 1));
  Mem.store<i32>(header, head);
  Mem.store<i32>(poolField(pool, 1), header);

  used = Mem.load<i32>(poolField(pool, 3));
  fcnt = Mem.load<i32>(poolField(pool, 4));
  Mem.store<i32>(poolField(pool, 3), used - 1);
  Mem.store<i32>(poolField(pool, 4), fcnt + 1);
}

@export wrealloc(ptr: i32, newSize: i32): i32 {
  local header: i32;
  local blk: i32;
  local oldSize: i32;
  local pool: i32;
  local bsize: i32;
  local usable: i32;
  local newPtr: i32;
  local copySize: i32;
  local i: i32;

  if (ptr == 0) { return wmalloc(newSize); }
  if (!g_ready) { return 0; }
  if (newSize <= 0) { wfree(ptr); return 0; }

  header = ptr - 4;
  blk = Mem.load<i32>(header);

  if (blk == 255) {
    oldSize = Mem.load<i32>(header + 4);
    if (newSize + 8 <= oldSize) { return ptr; }
    newPtr = wmalloc(newSize);
    if (newPtr == 0) { return 0; }
    copySize = oldSize - 8;
    if (newSize < copySize) { copySize = newSize; }
    i = 0;
    loop {
      { 'cpLarge
        break if (i >= copySize);
        Mem.store<u8>(newPtr + i, Mem.load<u8>(ptr + i));
        i += 1;
        goto 'cpLarge if (0);
      }
    }
    return newPtr;
  }

  pool = blk;
  bsize = blockSize(pool);
  usable = bsize - 4;

  if (newSize <= usable) { return ptr; }

  newPtr = wmalloc(newSize);
  if (newPtr == 0) { return 0; }
  i = 0;
  loop {
    { 'cpPool
      break if (i >= usable);
      Mem.store<u8>(newPtr + i, Mem.load<u8>(ptr + i));
      i += 1;
      goto 'cpPool if (0);
    }
  }
  wfree(ptr);
  return newPtr;
}

@export wcalloc(count: i32, size: i32): i32 {
  local total: i32;
  local ptr: i32;
  local i: i32;

  total = count * size;
  ptr = wmalloc(total);
  if (ptr == 0) { return 0; }
  i = 0;
  loop {
    { 'zero
      break if (i >= total);
      Mem.store<u8>(ptr + i, 0);
      i += 1;
      goto 'zero if (0);
    }
  }
  return ptr;
}

@export heap_stats(): (i32, i32, i32) {
  local total: i32;
  local used: i32;
  local freeBlks: i32;
  local i: i32;
  local pc: i32;
  local uc: i32;
  local fc: i32;
  local bsize: i32;
  local poolBytes: i32;

  total = 0;
  used = 0;
  freeBlks = 0;
  i = 0;

  loop {
    { 'sum
      break if (i >= 8);
      pc = Mem.load<i32>(poolField(i, 2));
      uc = Mem.load<i32>(poolField(i, 3));
      fc = Mem.load<i32>(poolField(i, 4));
      bsize = blockSize(i);
      total += pc * 65536;
      used += uc * bsize;
      freeBlks += fc;
      i += 1;
      goto 'sum if (0);
    }
  }

  poolBytes = total;
  total = g_brk - (g_base + 8 * 20);
  used += total - poolBytes;

  return (total, used, freeBlks);
}
`;

// ── Pipeline feature tests ──────────────────────────────────

describe('Allocator pipeline', () => {
  test('compiles and emits valid WAT', () => {
    const tokens = new Lexer(ALLOCATOR_SOURCE, 'allocator.wml').tokenize();
    const { ast, errors: parseErrors } = new Parser(tokens, 'allocator.wml').parse();
    const { errors: valErrors, symbols } = validateModule(ast, 'allocator.wml');
    const allErrors = [...parseErrors, ...valErrors].filter(e => e.severity === 'error');
    assert.equal(allErrors.length, 0, `Compilation errors:\n${allErrors.map(e => `${e.code}: ${e.message}`).join('\n')}`);
    const wat = new WatEmitter(ast, symbols).emit();
    let depth = 0;
    for (const ch of wat) { if (ch === '(') depth++; else if (ch === ')') depth--; }
    assert.equal(depth, 0, 'WAT has unbalanced parentheses');
    assert.ok(wat.includes('$wmalloc'), 'WAT should contain wmalloc');
    assert.ok(wat.includes('$wfree'), 'WAT should contain wfree');
    assert.ok(wat.includes('$heap_init'), 'WAT should contain heap_init');
    assert.ok(wat.includes('$heap_stats'), 'WAT should contain heap_stats');
    assert.ok(wat.includes('$wrealloc'), 'WAT should contain wrealloc');
    assert.ok(wat.includes('$wcalloc'), 'WAT should contain wcalloc');
  });
});

// ── Runtime execution tests ────────────────────────────────

describe('Allocator execution', { skip: skipIfNoBinaryen() }, () => {
  test('heap_init initializes pool metadata', async () => {
    const { heap_init, heap_stats } = await instantiate(ALLOCATOR_SOURCE);
    heap_init(1024, 65536);
    const [total, used, freeBlks] = heap_stats();
    assert.equal(total, 0, 'No pages allocated yet');
    assert.equal(used, 0, 'Nothing used');
    assert.equal(freeBlks, 0, 'No free blocks');
  });

  test('malloc returns non-null and writes are preserved', async () => {
    const exports = await instantiate(ALLOCATOR_SOURCE);
    const { heap_init, wmalloc } = exports;
    heap_init(1024, 65536);
    const p1 = wmalloc(8);
    assert.ok(p1 != 0, 'malloc(8) should succeed');
    const mem = () => new DataView(exports.Mem.buffer);
    mem().setInt32(p1, 42, true);
    assert.equal(mem().getInt32(p1, true), 42, 'Write should be preserved');
  });

  test('multiple small allocations from pool', async () => {
    const exports = await instantiate(ALLOCATOR_SOURCE);
    const { heap_init, wmalloc, wfree, heap_stats } = exports;
    const mem = () => new DataView(exports.Mem.buffer);
    heap_init(1024, 65536);

    const p1 = wmalloc(4);
    const p2 = wmalloc(8);
    const p3 = wmalloc(12);
    assert.ok(p1 != 0 && p2 != 0 && p3 != 0, 'All allocs should succeed');

    mem().setInt32(p1, 100, true);
    mem().setInt32(p2, 200, true);
    mem().setInt32(p3, 300, true);
    assert.equal(mem().getInt32(p1, true), 100);
    assert.equal(mem().getInt32(p2, true), 200);
    assert.equal(mem().getInt32(p3, true), 300);

    wfree(p2);
    const p4 = wmalloc(8);
    assert.equal(p4, p2, 'Freed block should be reused');
  });

  test('large allocation uses bump pointer', async () => {
    const { heap_init, wmalloc } = await instantiate(ALLOCATOR_SOURCE);
    heap_init(1024, 65536);
    const p = wmalloc(3000);
    assert.ok(p != 0, 'Large malloc should succeed');
    assert.ok(p > 1024 + 8 * 20, 'Large alloc should be past pool metadata');
  });

  test('wcalloc returns zeroed memory', async () => {
    const exports = await instantiate(ALLOCATOR_SOURCE);
    const { heap_init, wcalloc } = exports;
    heap_init(1024, 65536);
    const p = wcalloc(10, 4);
    assert.ok(p != 0, 'calloc should succeed');
    const mem = () => new DataView(exports.Mem.buffer);
    let allZero = true;
    for (let i = 0; i < 40; i++) {
      if (mem().getUint8(p + i) !== 0) { allZero = false; break; }
    }
    assert.ok(allZero, 'All bytes should be zero');
  });

  test('malloc of zero returns null', async () => {
    const { heap_init, wmalloc } = await instantiate(ALLOCATOR_SOURCE);
    heap_init(1024, 65536);
    assert.equal(wmalloc(0), 0, 'malloc(0) should return 0');
  });

  test('realloc grows to larger pool', async () => {
    const exports = await instantiate(ALLOCATOR_SOURCE);
    const { heap_init, wmalloc, wrealloc } = exports;
    heap_init(1024, 65536);

    const p1 = wmalloc(4);
    const mem = () => new DataView(exports.Mem.buffer);
    mem().setInt32(p1, 42, true);

    const p2 = wrealloc(p1, 100);
    assert.ok(p2 != 0, 'realloc should succeed');
    assert.equal(mem().getInt32(p2, true), 42, 'Data should be preserved');
  });

  test('heap_stats reflects usage', async () => {
    const { heap_init, wmalloc, wfree, heap_stats } = await instantiate(ALLOCATOR_SOURCE);
    heap_init(1024, 65536);

    const [t0, u0, f0] = heap_stats();
    assert.equal(t0, 0, 'Initial: no pages allocated');

    const p1 = wmalloc(60);
    assert.ok(p1 != 0);
    const [t1, u1, f1] = heap_stats();
    // 64-byte pool: one 64K page allocated
    assert.ok(t1 >= 65536, 'Pool should have allocated a page');
    assert.ok(u1 > 0, 'Some memory should be used');

    wfree(p1);
    const [t2, u2, f2] = heap_stats();
    assert.ok(u2 < u1, 'Usage should decrease after free');
    assert.ok(f2 >= 1, 'Free blocks should increase');
  });
});
