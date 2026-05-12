# WML Backend Guide

This guide is for **library users** compiling WML (WASM Module Language) to WebAssembly
programmatically. It covers the public JS API, input/output types, diagnostics, and a
complete language reference.

---

## Overview

`wml-lib` is an ESM library that compiles WML source code into WAT text or WASM binary.
It provides two public functions plus helper utilities for diagnostics.

```js
import { compile, validate } from 'wml-lib';
```

The library runs the full pipeline: **parse → validate → link → emit**. It supports
multi-file compilation with symbol sharing, GC types, exception handling, SIMD, and
all standard WASM proposals.

---

## Public API

### `compile(input, options?)`

Compiles WML source(s) to WAT text or WASM binary.

```js
const result = await compile(input, options);
```

**Input** can be any of these forms:

| Form | Description |
|------|-------------|
| `'path/to/file.wml'` | File path (read from disk) |
| `['a.wml', 'b.wml']` | Multiple file paths (linked together) |
| `{ name, content }` | Source object (inline string) |
| `[{ name, content }, ...]` | Array of source objects |
| `['a.wml', { name, content }]` | Mixed array |

**Source object shape:**

```ts
{
  name: string,              // Logical filename (used in diagnostics)
  content: string,           // WML source text
  expose?: string[] | ['*']  // Symbols to make available to other files
}
```

**Options:**

```ts
{
  emit?: 'wat' | 'wasm',     // Output format (default: 'wat')
  debug?: boolean,            // Emit name section / source map (default: false)
  optimize?: boolean,         // Run Binaryen optimization passes (default: false)
  maxErrors?: number,         // Stop collecting after N errors (default: 20, 0 = unlimited)
  noWarn?: boolean,           // Suppress warnings (default: false)
  warnAsError?: boolean       // Treat warnings as errors (default: false)
}
```

**Return value:**

```ts
{
  ok: boolean,                            // true if no errors
  output: string | Uint8Array | null,     // WAT text or WASM binary (null on failure)
  diagnostics: DiagnosticGroup[],         // Errors/warnings grouped by file
  summary: { errors: number, warnings: number }
}
```

**Minimal example:**
```js
import { compile } from 'wml-lib';

const result = await compile({
  name: 'add.wml',
  content: '@export add(a: i32, b: i32): i32 { return a + b; }'
}, { emit: 'wat' });

if (result.ok) {
  console.log(result.output);
  // (module
  //   (func $add (export "add") (param $a i32) (param $b i32) (result i32)
  //     local.get $a
  //     local.get $b
  //     i32.add
  //     return
  //   )
  // )
}
```

**Compile to WASM binary:**
```js
const result = await compile('module.wml', { emit: 'wasm' });
if (result.ok) {
  // result.output is a Uint8Array
  await Deno.writeFile('out.wasm', result.output);
}
```

---

### `validate(input, options?)`

Validates WML source(s) without emitting output. Useful for IDE integrations,
watch mode, or pre-flight checks.

```js
const result = await validate(input, options);
```

**Input:** Same forms as `compile()` — file paths, source objects, or mixed arrays.

**Options:**

```ts
{
  maxErrors?: number,     // Stop collecting after N errors (default: 20)
  noWarn?: boolean,       // Suppress warnings (default: false)
  warnAsError?: boolean   // Treat warnings as errors (default: false)
}
```

**Return value:**

```ts
{
  ok: boolean,
  diagnostics: DiagnosticGroup[],
  summary: { errors: number, warnings: number }
}
```

**Example:**
```js
import { validate } from 'wml-lib';

const result = await validate({ name: 'test.wml', content: source });
console.log(result.ok ? 'Valid' : 'Invalid');
for (const group of result.diagnostics) {
  for (const d of group.diagnostics) {
    console.error(`${d.code}: ${d.message}`);
  }
}
```

---

## Diagnostics

Diagnostics are returned as arrays of `DiagnosticGroup` objects, grouped by file.

### Diagnostic object

```ts
{
  code: string,              // e.g. "E100", "W001"
  category: string,          // e.g. "TypeError", "ScopeError"
  kind: string,              // e.g. "TypeMismatch", "UndefinedName"
  severity: 'error' | 'warning',
  message: string,           // Human-readable primary message
  detail: string,            // Additional context
  hint: string | null,       // Suggestion for fixing
  location: {
    file: string,            // Source file name
    line: number,
    col: number,
    endLine: number,
    endCol: number
  },
  recovered: boolean         // true if parser recovered and continued
}
```

### DiagnosticGroup

```ts
{
  file: string,
  diagnostics: Diagnostic[]  // Sorted by line/col
}
```

### formatting helpers

Import from `wml-lib/diagnostics/errors.js`:

```js
import { groupByFile, formatText, formatJSON } from 'wml-lib/diagnostics/errors.js';
```

**`formatText(diagnostics, sourceMap, options?)`** — Pretty-print with source context:

```js
const text = formatText(allDiagnostics, {
  'test.wml': sourceCode   // Map of filename → source text for context display
}, {
  color: true,       // ANSI colors (default: true)
  context: 2,        // Source context lines (default: 1)
  maxErrors: 20      // Max diagnostics to show (default: 20)
});
```

Outputs Rust-style formatted diagnostics:
```
error[E200] 'undeclared' is not defined
  --> test.wml:5:12
    |
  5 |   return undeclared;
    |          ^^^^^^^^^^
    |
  = hint: Check the spelling or add a declaration
```

**`formatJSON(diagnostics, options?)`** — Newline-delimited JSON (NDJSON):

```js
const json = formatJSON(allDiagnostics, { maxErrors: 20 });
// {"code":"E200","severity":"error","message":"...",...}
// {"type":"summary","errors":1,"warnings":0,"success":false}
```

### Error filtering

You can filter diagnostics before formatting:

```js
const errorsOnly = allErrors.filter(d => d.severity === 'error');
const warnings   = allErrors.filter(d => d.severity === 'warning');

// Suppress specific codes
const filtered = allErrors.filter(d => d.code !== 'W001');
```

---

## Multi-file compilation

WML supports linking multiple source files into a single module. Use `expose` on
source objects to share symbols between files.

### Basic linking

When you pass an array of sources to `compile()` or `validate()`, they are parsed,
validated, and linked in order:

```js
const result = await compile([
  { name: 'shared.wml', content: '@export add(a: i32, b: i32): i32 { return a + b; }', expose: ['*'] },
  { name: 'main.wml',   content: '@export calc(x: i32): i32 { return add(x, 1); }' },
], { emit: 'wat' });
```

### `expose` rules

| Value | Behavior |
|-------|----------|
| `['*']` or `'*'` | All symbols from this file are visible to subsequent files |
| `['add', 'sub']` | Only named symbols are visible |
| `undefined` | No symbols shared (isolated file) |

### Linking rules

- **Duplicate non-exported names** across files produce `E201`.
- **Exported functions** (`@export`): last definition wins (enables override patterns).
- **`@import` deduplication**: same `(module, name, signature)` merged — conflict gives `E506`.
- **`@start` merging**: multiple `@start` functions become a single synthetic `__start()`
  that calls each in declaration order.

### File path inputs with expose

When passing file paths, you cannot set `expose` directly. Use source objects instead:

```js
import { readFile } from 'node:fs/promises';

const shared = await readFile('shared.wml', 'utf8');
const main   = await readFile('main.wml', 'utf8');

const result = await compile([
  { name: 'shared.wml', content: shared, expose: ['*'] },
  { name: 'main.wml',   content: main },
], { emit: 'wasm' });
```

---

## Low-level pipeline

If you need more control (e.g. custom validation, incremental compilation, or
alternative emittters), use the pipeline components directly:

```js
import { Lexer }   from 'wml-lib/parser/lexer.js';
import { Parser }  from 'wml-lib/parser/parser.js';
import { validateModule } from 'wml-lib/validator/index.js';
import { WatEmitter } from 'wml-lib/emitter/wat.js';
import { BinaryenEmitter } from 'wml-lib/emitter/binaryen.js';
import { Linker }  from 'wml-lib/linker.js';
```

### Pipeline steps

```
Source string → Lexer → Token[] → Parser → AST → validateModule → validated AST
→ Linker → linked AST → WatEmitter → WAT string → BinaryenEmitter → WASM Uint8Array
```

### Example: manual pipeline

```js
import { Lexer }   from 'wml-lib/parser/lexer.js';
import { Parser }  from 'wml-lib/parser/parser.js';
import { validateModule } from 'wml-lib/validator/index.js';
import { WatEmitter } from 'wml-lib/emitter/wat.js';

const source = '@export add(a: i32, b: i32): i32 { return a + b; }';

// 1. Tokenize
const tokens = new Lexer(source, 'add.wml').tokenize();

// 2. Parse to AST
const { ast, errors: parseErrors } = new Parser(tokens, 'add.wml').parse();

// 3. Validate
const { errors: valErrors, symbols } = validateModule(ast, 'add.wml');

// 4. Emit WAT
const wat = new WatEmitter(ast, symbols).emit();
```

### Using Linker directly

```js
import { Linker } from 'wml-lib/linker.js';

const linker = new Linker([
  { name: 'a.wml', ast: astA, symbols: symA, expose: ['*'] },
  { name: 'b.wml', ast: astB, symbols: symB },
]);
const { ast: linkedAst, errors: linkErrors, symbols } = linker.link();
```

### Using BinaryenEmitter for WASM

The `BinaryenEmitter` converts WAT text to WASM binary using Binaryen:

```js
import { BinaryenEmitter } from 'wml-lib/emitter/binaryen.js';

const { wasm, error } = await BinaryenEmitter.emit(watText, {
  debug: true,
  optimize: true,
});
```

Returns `{ wasm: Uint8Array, error: null }` on success, or
`{ wasm: null, error: 'message' }` if Binaryen is not installed or fails.

---

## Language guide

### Types

#### Primitive types

| WML | WASM | Width | Notes |
|-----|------|-------|-------|
| `i8` | `i32` | 8-bit | Signed |
| `i16` | `i32` | 16-bit | Signed |
| `i32` | `i32` | 32-bit | Signed |
| `i64` | `i64` | 64-bit | Signed |
| `isize` | `i32` | 32-bit | WASM32 platform size |
| `u8` | `i32` | 8-bit | Unsigned |
| `u16` | `i32` | 16-bit | Unsigned |
| `u32` | `i32` | 32-bit | Unsigned |
| `u64` | `i64` | 64-bit | Unsigned |
| `usize` | `i32` | 32-bit | WASM32 platform size |
| `f32` | `f32` | 32-bit | IEEE 754 |
| `f64` | `f64` | 64-bit | IEEE 754 |
| `v128` | `v128` | 128-bit | Untyped SIMD |

`i32`/`u32` share the same WASM type at runtime. WML tracks signedness for
operator selection (`/s` vs `/u`). Assignment between `i32` and `u32` is silent.

#### SIMD shape types

`i8x16`, `i16x8`, `i32x4`, `i64x2`, `f32x4`, `f64x2` — all map to `v128` at runtime.

#### Reference types

`funcref`, `externref`, `anyref`, `eqref`, `structref`, `arrayref`, `i31ref`,
`nullref`, `exnref`

#### Type declarations

```wml
// Function type alias
type BinaryOp = (i32, i32) => i32;

// Struct type (GC)
type Point = struct {
  x: i32;
  mut y: i32;       // mut = mutable field
};

// Final struct (no subtypes)
type FinalVec = final struct { x: f32; y: f32; };

// Struct inheritance
type ColoredPoint = struct extends Point { color: i32; };

// Array type (GC)
type IntArray   = [i32];         // immutable elements
type MutArray   = [mut i32];     // mutable elements

// Recursive types
rec {
  type Node = struct { value: i32; next: Node; };
}
```

#### Struct layout pragmas

```wml
// C ABI layout (Clang WASM32 ABI)
#[repr(C)]
type CLayout = struct { a: i32; b: f64; };

// Packed — no padding between fields
#[repr(packed)]
type Header = struct { magic: i8; version: i8; flags: i16; };
```

---

### Functions

```wml
// Basic function (no keyword)
add(a: i32, b: i32): i32 {
  return a + b;
}

// Multiple return values
divmod(a: i32, b: i32): (i32, i32) {
  return (a /s b, a %s b);
}

// Void return
log(msg: i32): () { nop; }

// Import
@import("env", "console_log") consoleLog(ptr: i32, len: i32): ();

// Export
@export add(a: i32, b: i32): i32 { return a + b; }

// Start function (runs on module instantiation)
@start init(): () {
  // initialization code
}

// Tail call (per-callsite)
@tail factorial(n: i32, acc: i32): i32 {
  if (n <= 1) { return acc; }
  return tail factorial(n - 1, n * acc);
}
```

Locals at the top of a function body:

```wml
f(): i32 {
  local x: i32;
  local y: i32 = 10;    // with initializer
  // statements follow
  return x + y;
}
```

---

### Variables

```wml
// Module-level globals
global PI: f64 = 3.14159;       // immutable
global mut counter: i32 = 0;    // mutable
```

Globals require constant initializers (literals, immutable globals, `sizeof`).

---

### Operators

#### Arithmetic

| WML | WAT | Notes |
|-----|-----|-------|
| `+` `-` `*` | `add` `sub` `mul` | |
| `/s` | `div_s` | Signed division |
| `/u` | `div_u` | Requires unsigned types |
| `%s` | `rem_s` | Signed remainder |
| `%u` | `rem_u` | Requires unsigned types |

#### Bitwise

`&` `|` `^` `~` `<<` `>>s` `>>u`

#### Logical

| WML | Return | Behavior |
|-----|--------|----------|
| `&&` | `i32` (0/1) | Short-circuit and |
| `\|\|` | `i32` (0/1) | Short-circuit or |
| `!x` | `i32` (0/1) | 1 if x == 0 |

Both `&&` and `||` short-circuit — the right operand is not evaluated if the
result is determined by the left. They compile to WAT `if` blocks.

#### Comparison

`==` `!=` `<` `>` `<=` `>=` — all return `i32`.

#### Compound assignment

`+=` `-=` `*=`

#### Precedence (lowest to highest)

```
||   &&   == !=   < > <= >=   |   ^   &   << >>s >>u   + -   * /s /u %s %u   unary(- ~ !)   postfix
```

---

### Control flow

#### if / else

```wml
if (condition) {
  // then
} else if (other) {
  // else-if
} else {
  // else
}
```

If as an expression (requires `else`):

```wml
local result: i32 = if (n > 0) { return 1; } else { return 0; };
```

#### loop

All loops use the `loop` construct with labeled blocks:

```wml
loop {
  { 'top
    break if (done);          // br_if to exit
    goto 'top if (!done);     // br_if back to top
  }
}
```

- `break` — exits the current loop
- `break if (cond)` — conditional exit
- `goto 'label` — unconditional branch to a label in the same loop
- `goto 'label if (cond)` — conditional branch
- `goto ['a, 'b, 'c] idx` — table branch (`br_table`)

Labels are scoped to their loop. `goto` cannot target a label in an outer loop.

Multiple blocks fall through between each other:

```wml
loop {
  { 'init
    // runs first
  }
  { 'body
    // runs after init falls through
    goto 'body if (more_work);
  }
}
```

#### Exceptions

```wml
// Declare a tag
tag DivError: (i32, i32);

// Throw
throw DivError(a, b);

// Throw ref (re-throw)
throw exn;

// Try / catch
try {
  risky();
} catch DivError(a, b) {
  // handle with bindings
} catch (exn) {
  // catch-all with exnref binding
} catch {
  // catch-all no binding
}
```

---

### Memory

```wml
// Declare memory
memory Mem = 4;         // 4 initial pages (256KB)
memory Mem = 4..16;     // 4 initial, 16 max
shared memory Mem = 4;  // shared (threads)

// Import / export
@import("env","mem") memory Mem = 1;
@export memory Mem = 4;

// Load/store
Mem.load<i32>(ptr)             // i32.load
Mem.load<i8s>(ptr)             // i32.load8_s
Mem.load<u8>(ptr)              // i32.load8_u
Mem.load<i16s>(ptr)            // i32.load16_s
Mem.load<u16>(ptr)             // i32.load16_u
Mem.load<i64>(ptr)             // i64.load
Mem.load<f32>(ptr)             // f32.load
Mem.load<f64>(ptr)             // f64.load
Mem.load<v128>(ptr)            // v128.load

Mem.store<i32>(ptr, val)       // i32.store
Mem.store<i8>(ptr, val)        // i32.store8
Mem.store<i64>(ptr, val)       // i64.store
Mem.store<f32>(ptr, val)       // f32.store
Mem.store<f64>(ptr, val)       // f64.store

// Bulk memory
Mem.copy(dst, src, len)        // memory.copy
Mem.fill(ptr, byte, len)       // memory.fill
Mem.grow(pages)                // returns old size or -1
Mem.size()                     // current size in pages
```

#### Data segments

```wml
// Typed integer array
data Magic: i8[] = [0x00, 0x61, 0x73, 0x6D];

// String encodings
data Greeting: cstr    = "Hello\n";    // null-terminated UTF-8
data AppName:  utf8_32 = "MyApp";      // 4-byte LE length + UTF-8
data Version:  utf8_64 = "1.0.0";     // 8-byte LE length + UTF-8
data ShortStr: pascal  = "Hi";         // 1-byte length, max 255 chars

// Float arrays
data Table: f64[] = [0.0, 1.0, 2.0, 3.0];

// Place into memory (sequential placement)
Mem[0] = Magic, Greeting;      // at offset 0, then immediately after
Mem[256] = AppName;            // at offset 256
```

---

### GC types

```wml
// Create struct instance
local p: Point = new Point { x: 1, y: 2 };

// Field access
local x: i32 = p.x;
p.y = 42;                   // only if field is mut

// Array operations
local arr: IntArray = new IntArray(10);       // new_default
local arr2: IntArray = new IntArray [1, 2, 3]; // new_fixed
local len: i32 = arr.length;
local val: i32 = arr[0];
arr[0] = 42;                // only if [mut T]

// Type tests and casts
local isPoint: i32 = r is Point;           // ref.test → i32
local p: Point = r as Point;               // ref.cast (traps on fail)
local p2: Point = r as! Point;             // ref.cast_nop (unchecked)
local p3: Point = r!;                      // ref.as_non_null

// null
local maybePoint: Point = null;

// i31ref
local small: i31ref = i31ref.new(42);
local val: i32 = i31ref.get(small);
```

---

### Tables and function references

```wml
// Declare a table
table FuncTable: [funcref] = 16;        // 16 entries
table FuncTable: [funcref] = 8..256;    // 8 min, 256 max

// Element segment (passive)
elem Handlers: funcref[] = [onClick, onResize, ref(fn)];

// Place into table
FuncTable[0] = Handlers;

// Inline table init
FuncTable[4] = funcref[fn1, fn2, fn3];

// call_indirect (typed)
FuncTable[idx]<BinaryOp>(a, b);

// Typed funcref call
local fn: funcref<BinaryOp> = ref(add);
fn(a, b);
```

---

### SIMD

```wml
// Constructor
local v: i32x4 = i32x4(1, 2, 3, 4);

// Splat (broadcast)
local v2: f32x4 = f32x4.splat(0.0);

// Lane ops
local lane0: i32 = v.extractLane<i32>(0);
local v3: i32x4 = v.replaceLane<i32>(0, 99);

// Arithmetic
local sum: i32x4 = a.add(b);
local diff: f64x2 = a.sub(b);

// Shuffle
local shuffled: i8x16 = a.shuffle(b, [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15]);

// Memory operations
Mem.loadSplat<i32x4>(ptr)    // v128.load32_splat
Mem.loadExtend<i8x8s>(ptr)   // v128.load8x8_s
Mem.loadLane<i8>(ptr, v, 0)  // v128.load8_lane
```

---

### Custom sections

```wml
// Auto-generate DWARF name section
section @debug;

// Custom section with bytes
section "sourceMappingURL" { cstr "module.wasm.map" }
```

---

## Complete example

```wml
// calculator.wml
tag DivByZero: (i32, i32);
global mut lastResult: i32 = 0;
global callCount: i32 = 0;

@import("env", "on_error") onError(code: i32): ();

add(a: i32, b: i32): i32 { return a + b; }
sub(a: i32, b: i32): i32 { return a - b; }
mul(a: i32, b: i32): i32 { return a * b; }

div(a: i32, b: i32): i32 {
  if (b == 0) { throw DivByZero(a, b); }
  return a /s b;
}

@export calculate(op: i32, a: i32, b: i32): i32 {
  local result: i32;
  try {
    if      (op == 0) { result = add(a, b); }
    else if (op == 1) { result = sub(a, b); }
    else if (op == 2) { result = mul(a, b); }
    else              { result = div(a, b); }
  } catch DivByZero(x, y) {
    onError(-1);
    result = 0;
  }
  lastResult = result;
  return result;
}

@export getLastResult(): i32 { return lastResult; }

@start init(): () { lastResult = 0; }
```

Compile via the library:

```js
import { compile } from 'wml-lib';
import { readFile } from 'node:fs/promises';

const source = await readFile('calculator.wml', 'utf8');
const result = await compile({ name: 'calculator.wml', content: source }, {
  emit: 'wasm',
  debug: true,
});
```

---

## Error code reference

### Syntax (E0xx)

| Code | Kind | Description |
|------|------|-------------|
| E001 | UnexpectedToken | Unexpected token |
| E002 | UnexpectedEOF | Source ended unexpectedly |
| E003 | InvalidLiteral | Malformed literal |
| E004 | UnclosedDelimiter | Missing closing delimiter |
| E005 | InvalidEscape | Unknown escape sequence |
| E009 | MalformedType | Invalid type expression |

### Type errors (E1xx)

| Code | Kind | Description |
|------|------|-------------|
| E100 | TypeMismatch | Type mismatch in assignment, return, argument |
| E101 | InvalidOperands | Operator not applicable |
| E102 | InvalidReturn | Return type mismatch |
| E103 | InvalidCast | Cast between incompatible types |
| E104 | InvalidFieldAccess | Field doesn't exist |
| E105 | ImmutableField | Write to non-mut field |
| E107 | InvalidCall | Calling non-callable value |
| E108 | SignatureMismatch | Wrong number of arguments |
| E109 | InvalidSelect | select operands differ |
| E111 | MultipleReturnMismatch | Wrong number of return values |
| E113 | ImmutableGlobal | Write to non-mut global |

### Scope errors (E2xx)

| Code | Kind | Description |
|------|------|-------------|
| E200 | UndefinedName | Name not declared |
| E201 | DuplicateDeclaration | Name declared twice |
| E202 | UndefinedType | Type not declared |
| E203 | UndefinedLabel | Label not in scope |
| E204 | UndefinedMemory | Memory not declared |
| E209 | BreakOutsideBlock | break/goto outside a loop |
| E213 | StartDuplicate | Multiple @start in one file |
| E215 | UndefinedLoopLabel | goto target not found |
| E216 | OuterLoopGoto | goto targets outer loop |
| E217 | DuplicateLabel | Two same-named labels in one loop |
| E218 | DeclInBlock | Local declaration after statement |

### Const errors (E3xx)

| Code | Kind | Description |
|------|------|-------------|
| E300 | NonConstExpr | Non-constant in const context |
| E301 | MutableGlobalInConst | Mutable global in const expr |
| E302 | FuncCallInConst | Function call in const expr |
| E303 | LocalInConst | Local/param in const expr |

### Memory errors (E4xx)

| Code | Kind | Description |
|------|------|-------------|
| E403 | PascalStringTooLong | Pascal string > 255 chars |
| E404 | InvalidMemoryRange | max < min |
| E407 | MultipleMemoryAmbiguous | Bare load/store with >1 memory |

### Link errors (E5xx)

| Code | Kind | Description |
|------|------|-------------|
| E500 | DuplicateExport | Same name exported twice |
| E501 | ImportBodyPresent | Imported function has body |
| E504 | StartBadSignature | @start has params/returns |
| E505 | TagBadParamType | Tag param is not value type |
| E506 | ImportConflict | Same import, conflicting types |

### Warnings (W0xx)

| Code | Kind | Description |
|------|------|-------------|
| W001 | UnusedData | Data segment never placed |
| W002 | UnusedElem | Element segment never used |
| W005 | UnreachableCode | Code after unconditional branch |
| W006 | DroppedNotUsed | Expression value dropped |
