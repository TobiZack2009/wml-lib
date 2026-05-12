# WML Backend Guide

This guide is for compiler authors using WML as a code generation target. It covers
the complete WML language: syntax, semantics, and how WML constructs map to
WebAssembly.

---

## What is WML?

WML (WASM Module Language) is a typed IR above WAT (WebAssembly Text Format). It gives
you a structured, TypeScript-like syntax for generating WebAssembly modules without
writing raw S-expressions. The compiler handles:

- Type checking and validation before code generation
- WAT instruction selection
- Data encoding (strings, typed arrays)
- Multi-file linking with symbol visibility control
- Source maps and name sections for debugging

WML files use the `.wml` extension. The compiler CLI is `wml`.

---

## Compiling WML

```sh
# Validate only
wml validate src/module.wml

# Emit WAT text
wml compile src/module.wml --emit=wat

# Emit WASM binary (requires binaryen peer dep)
wml compile src/module.wml --emit=wasm --out=dist/module.wasm

# Multiple files (linked into one module)
wml compile src/shared.wml src/main.wml --emit=wasm --out=dist/app.wasm

# Watch mode
wml compile src/app.wml --watch
```

**JS API:**
```js
import { compile, validate } from 'wml-lib';

const result = await compile({
  name: 'add.wml',
  content: 'add(a: i32, b: i32): i32 { return a + b; }'
}, { emit: 'wat' });

if (result.ok) {
  console.log(result.output); // WAT text
}
```

---

## Types

### Primitive types

| WML type | WASM type | Width | Notes |
|----------|-----------|-------|-------|
| `i8`     | `i32`     | 8-bit | Signed |
| `i16`    | `i32`     | 16-bit | Signed |
| `i32`    | `i32`     | 32-bit | Signed |
| `i64`    | `i64`     | 64-bit | Signed |
| `isize`  | `i32`     | 32-bit | Platform-sized signed (WASM32) |
| `u8`     | `i32`     | 8-bit | Unsigned |
| `u16`    | `i32`     | 16-bit | Unsigned |
| `u32`    | `i32`     | 32-bit | Unsigned |
| `u64`    | `i64`     | 64-bit | Unsigned |
| `usize`  | `i32`     | 32-bit | Platform-sized unsigned (WASM32) |
| `f32`    | `f32`     | 32-bit | IEEE 754 |
| `f64`    | `f64`     | 64-bit | IEEE 754 |
| `v128`   | `v128`    | 128-bit | Untyped SIMD |

`i32`/`u32` are the same WASM type at runtime. WML tracks signedness for operator
selection (`/s` vs `/u`). Assigning between `i32` and `u32` is silent.

### SIMD types

Shaped SIMD types for lane operations:

| WML type | Lanes | Lane type |
|----------|-------|-----------|
| `i8x16`  | 16    | `i8`      |
| `i16x8`  | 8     | `i16`     |
| `i32x4`  | 4     | `i32`     |
| `i64x2`  | 2     | `i64`     |
| `f32x4`  | 4     | `f32`     |
| `f64x2`  | 2     | `f64`     |

### Reference types

`funcref`, `externref`, `anyref`, `eqref`, `structref`, `arrayref`, `i31ref`,
`nullref`, `exnref`

### Type declarations

```wml
// Function type alias
type BinaryOp = (i32, i32) => i32;

// Struct type (GC)
type Point = struct {
  x: i32;
  mut y: i32;     // mut = mutable field
};

// Final struct (no subtypes)
type FinalVec = final struct { x: f32; y: f32; };

// Struct with inheritance
type ColoredPoint = struct extends Point { color: i32; };

// Array type (GC)
type IntArray   = [i32];      // immutable elements
type MutArray   = [mut i32];  // mutable elements

// Recursive types
rec {
  type Node = struct { value: i32; next: Node; };
}
```

### Struct layout pragmas

```wml
// C ABI layout (Clang WASM32 ABI)
#[repr(C)]
type CLayout = struct { a: i32; b: f64; };

// Packed — no padding between fields
#[repr(packed)]
type Header = struct { magic: i8; version: i8; flags: i16; };
```

Pragmas appear on the line before `type`. Multiple pragmas use separate `#[...]` lines.
Unknown or inapplicable pragmas are silently ignored.

---

## Functions

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
log(msg: i32): () {
  // ...
}

// Import
@import("env", "console_log") consoleLog(ptr: i32, len: i32): ();

// Export
@export add(a: i32, b: i32): i32 { return a + b; }

// Start function (called on module instantiation)
@start init(): () {
  // initialization code
}

// Tail calls (per-callsite)
@tail factorial(n: i32, acc: i32): i32 {
  if (n <= 1) { return acc; }
  return tail factorial(n - 1, n * acc);
}
```

Local declarations appear **at the top of the function body**, before any statements:

```wml
f(): i32 {
  local x: i32;
  local y: i32 = 10;   // with initializer
  local mut z: i32;    // mut is redundant but allowed
  // statements follow
  return x + y;
}
```

---

## Variables

```wml
// Module-level globals
global PI: f64 = 3.14159265358979;    // immutable
global mut counter: i32 = 0;          // mutable
```

Globals must have constant initializers (literals, immutable globals, `sizeof`).

---

## Operators

### Arithmetic

| WML | Meaning | Notes |
|-----|---------|-------|
| `+` `-` `*` | Add, sub, mul | |
| `/s` | Signed division | |
| `/u` | Unsigned division | Requires unsigned types |
| `%s` | Signed remainder | |
| `%u` | Unsigned remainder | Requires unsigned types |

### Bitwise

`&` `|` `^` `~` `<<` `>>s` `>>u`

### Logical

| WML | Meaning | Return type |
|-----|---------|-------------|
| `&&` | Short-circuit and | `i32` (0 or 1) |
| `\|\|` | Short-circuit or | `i32` (0 or 1) |
| `!x` | Logical not | `i32` (0 if x≠0, 1 if x=0) |

`&&` and `||` short-circuit — the right operand is not evaluated if the result
is determined by the left. Both compile to WAT `if` blocks.

### Comparison

`==` `!=` `<` `>` `<=` `>=` — all return `i32`.

### Compound assignment

`+=` `-=` `*=`

### Precedence (lowest to highest)

```
||   &&   == !=   < > <= >=   |   ^   &   << >>s >>u   + -   * /s /u %s %u   unary(- ~ !)   postfix
```

---

## Control flow

### if / else

```wml
if (condition) {
  // then
} else if (other) {
  // else-if
} else {
  // else
}
```

`if` can also be an expression (requires `else`):

```wml
local result: i32 = if (n > 0) { return 1; } else { return 0; };
```

### loop

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
- `goto 'label` — unconditional branch to label in same loop
- `goto 'label if (cond)` — conditional branch
- `goto ['a, 'b, 'c] idx` — table branch (br_table)

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

### Exceptions

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

Tags can be imported and exported:

```wml
@export tag AppError: (i32);
@import("env","jsErr") tag JSError: (externref);
```

---

## Memory

```wml
// Declare memory
memory Mem = 4;         // 4 initial pages (256KB)
memory Mem = 4..16;     // 4 initial, 16 max pages
shared memory Mem = 4;  // shared memory (for threads)

// Import / export
@import("env","mem") memory Mem = 1;
@export memory Mem = 4;

// Memory instance methods
Mem.load<i32>(ptr)               // load i32
Mem.load<i8s>(ptr)               // load i8 sign-extended
Mem.load<u8>(ptr)                // load u8 zero-extended
Mem.store<i32>(ptr, val)         // store i32
Mem.store<i32>(ptr, val, align=4) // with alignment hint
Mem.grow(pages)                  // grow (returns old size or -1)
Mem.size()                       // current size in pages
Mem.copy(dst, src, len)          // memory.copy
Mem.fill(ptr, byte, len)         // memory.fill

// With single memory, bare form works too:
load<i32>(ptr)
store<i32>(ptr, val)
```

### Atomic operations (shared memory only)

```wml
Mem.atomic.load<i32>(ptr)
Mem.atomic.store<i32>(ptr, val)
Mem.atomic.add<i32>(ptr, val)
Mem.atomic.sub<i32>(ptr, val)
Mem.atomic.cmpxchg<i32>(ptr, expected, replacement)
Mem.atomic.wait<i32>(ptr, expected, timeout)
Mem.atomic.notify(ptr, count)
```

### Data segments

```wml
// Typed integer array
data Magic: i8[] = [0x00, 0x61, 0x73, 0x6D];

// String types
data Greeting: cstr    = "Hello\n";   // null-terminated
data AppName:  utf8_32 = "MyApp";     // 4-byte length prefix + UTF-8
data Version:  utf8_64 = "1.0.0";    // 8-byte length prefix + UTF-8
data ShortStr: pascal  = "Hi";        // 1-byte length prefix, max 255 chars

// Float arrays
data Table: f64[] = [0.0, 1.0, 2.0, 3.0];

// Named data segment (inline literal, type from annotation)
data Blob: i8[] = [1, 2, 3, 4, 5];

// Place into memory (sequential placement)
Mem[0] = Magic, Greeting;    // placed at offset 0, then immediately after
Mem[256] = AppName;          // placed at offset 256
```

---

## Pointers (linear memory)

```wml
// Pointer to a struct in memory (WASM32: i32 address)
local ptr: *Point;           // single memory inferred
local ptr: *Point@Mem;       // explicit memory name

// Allocate (call an allocator)
local p: *Point@Mem = malloc(sizeof(Point)) as *Point@Mem;

// Field access via index
ptr[0].x = 1;       // writes field x of struct at ptr
ptr[0].y = 2;

// Pointer arithmetic: ptr[n] advances by n * sizeof(Point)
// ptr + n advances by n BYTES

// sizeof returns isize
local sz: isize = sizeof(Point);
```

Pointer arithmetic is byte-based for `+`/`-`. Index access `ptr[n]` scales by
`sizeof(T)`.

---

## Tables and function references

```wml
// Declare a table
table FuncTable: [funcref] = 16;       // 16 entries
table FuncTable: [funcref] = 8..256;   // 8 initial, 256 max

// Element segment (passive)
elem Handlers: funcref[] = [onClick, onResize, ref(fn)];

// Place element segment into table
FuncTable[0] = Handlers;

// Inline table init
FuncTable[4] = funcref[fn1, fn2, fn3];

// call_indirect (typed)
FuncTable[idx]<BinaryOp>(a, b);

// Typed funcref call
local fn: funcref<BinaryOp> = ref(add);
fn(a, b);

// Untyped funcref call (must supply type)
local fn: funcref = ref(add);
fn<BinaryOp>(a, b);
```

---

## GC types

```wml
// Create struct instance
local p: Point = new Point { x: 1, y: 2 };

// Field access
local x: i32 = p.x;
p.y = 42;            // only works if field is mut

// Array operations
local arr: IntArray = new IntArray(10);     // new_default
local arr2: IntArray = new IntArray [1, 2, 3]; // new_fixed
local len: i32 = arr.length;
local val: i32 = arr[0];
arr[0] = 42;         // only works if array is [mut T]

// Type tests and casts
local isPoint: i32 = r is Point;       // ref.test → i32
local p: Point = r as Point;           // ref.cast (checked, traps on failure)
local p2: Point = r as! Point;         // ref.cast_nop (unchecked)
local p3: Point = r!;                  // ref.as_non_null (traps if null)

// null
local maybePoint: Point = null;

// i31ref
local small: i31ref = i31ref.new(42);
local val: i32 = i31ref.get(small);
```

---

## SIMD

```wml
// Constructor
local v: i32x4 = i32x4(1, 2, 3, 4);

// Splat (broadcast)
local v2: f32x4 = f32x4.splat(0.0);

// Lane operations
local lane0: i32 = v.extractLane<i32>(0);
local v3: i32x4 = v.replaceLane<i32>(0, 99);

// Arithmetic
local sum: i32x4 = a.add(b);
local diff: f64x2 = a.sub(b);

// Shuffle / swizzle
local shuffled: i8x16 = a.shuffle(b, [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15]);

// Bitcast
local reinterp: f32x4 = intVec.as<f32x4>();

// Relaxed SIMD
local r: f32x4 = a.relaxed.min(b);

// Typed memory operations
Mem.loadSplat<i32x4>(ptr)           // v128.load32_splat
Mem.loadExtend<i8x8s>(ptr)          // v128.load8x8_s
Mem.loadLane<i8>(ptr, vec, lane)    // v128.load8_lane
```

---

## Custom sections

```wml
// Emit the DWARF debug name section automatically
section @debug;

// Emit a custom section with raw bytes
section "sourceMappingURL" { cstr "module.wasm.map" }
```

---

## Multi-file compilation

WML supports linking multiple source files into a single module. Use `expose` to
share symbols between files.

**shared.wml:**
```wml
@export add(a: i32, b: i32): i32 { return a + b; }
```

**main.wml (uses symbols from shared):**
```wml
@export calculate(x: i32): i32 { return add(x, 1); }
```

**Compile:**
```sh
wml compile shared.wml main.wml --emit=wasm --out=app.wasm
```

**JS API with expose:**
```js
await compile([
  { name: 'shared.wml', content: sharedSrc, expose: ['*'] },
  { name: 'main.wml',   content: mainSrc   },
], { emit: 'wasm' });
```

`expose: ['*']` makes all symbols from `shared.wml` available in `main.wml`.
`expose: ['add', 'sub']` exposes only named symbols.

**Multiple `@start` functions** across files are merged into a synthetic `__start()`
that calls each in file order.

---

## Error handling reference

Errors are reported in Rust-style format (default) or NDJSON (`--format=json`).

**Text format:**
```
error[E200] 'undeclared' is not defined
  --> module.wml:5:12
    |
  5 |   return undeclared;
    |          ^^^^^^^^^^
    |
   = hint: Check the spelling or add a declaration
```

**JSON format (one object per line):**
```json
{"code":"E200","severity":"error","message":"'undeclared' is not defined",...}
{"type":"summary","errors":1,"warnings":0,"success":false}
```

**Diagnostic options:**
```sh
--max-errors=N      # stop after N errors (default 20, 0 = unlimited)
--no-warn           # suppress warnings
--warn-as-error     # treat warnings as errors
--format=text|json  # output format
--context=N         # source context lines in text format (default 1)
--no-color          # disable ANSI colors
```

---

## Complete example: calculator module

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

@export getLastResult(): i32 {
  return lastResult;
}

@start init(): () {
  lastResult = 0;
}
```

```sh
wml compile calculator.wml --emit=wasm --out=calculator.wasm
```
