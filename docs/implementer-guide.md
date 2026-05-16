# WML Implementer Guide

This guide describes the internal architecture of the WML compiler for contributors
and anyone extending the compiler.

---

## Overview

WML (WASM Module Language) is a high-level IR that compiles to WebAssembly. It sits
above WAT (WebAssembly Text Format) and below source languages like AssemblyScript.
Its primary target users are compiler backend authors who need a typed, structured way
to emit WebAssembly without writing raw WAT.

The compiler is a standard pipeline:

```
Source strings
    │
    ▼
  Lexer          src/parser/lexer.js
    │  tokens
    ▼
  Parser         src/parser/parser.js
    │  AST
    ▼
  Scope Checker  src/validator/scope.js
    │  resolved AST
    ▼
  Type Checker   src/validator/typecheck.js
    │  typed AST
    ▼
  Memory/Link    src/validator/index.js
  Validator
    │  validated AST
    ▼
  Linker         src/linker.js
    │  merged module AST
    ▼
  WAT Emitter    src/emitter/wat.js      (--emit=wat)
  OR
  Binaryen       src/emitter/binaryen.js (--emit=wasm)
    │
    ▼
  Output (string | Uint8Array)
```

**Key invariant:** The emitter is only called on a fully validated AST. It does not
re-validate and does not produce user-friendly errors — bugs in the emitter will
produce malformed WAT rather than diagnostics.

---

## Source layout

```
src/
  parser/
    tokens.js      Token type constants (T enum), keyword map, type sets
    lexer.js       Lexer class — source → token[]
    ast.js         AST node constructor functions
    parser.js      Recursive descent parser — token[] → AST
  diagnostics/
    errors.js      Error codes, mkError/mkWarning, formatText, formatJSON
  validator/
    types.js       Type objects, isAssignable, sizeOf, alignOf, computeLayout
    scope.js       ScopeChecker class — phase 1 validation
    typecheck.js   TypeChecker class — phase 2 validation
    index.js       validateModule() — runs all validation phases
  emitter/
    wat.js         WatEmitter class — AST → WAT text
    binaryen.js    BinaryenEmitter — WAT text → WASM binary (optional dep)
    debug.js       DebugEmitter — source maps and name section
  linker.js        Linker class — merges multi-file modules
  index.js         Public API: compile(), validate()
  cli/
    index.js       CLI entry point

test/
  parser/parser.test.js         89 tests
  validator/validator.test.js   56 tests
  emitter/emitter.test.js       61 tests
  features/features.test.js     56 tests

docs/
  implementer-guide.md    (this file)
  backend-guide.md        Language guide for compiler backend authors
  reference.md            Full language reference
```

---

## Tokens (`src/parser/tokens.js`)

All token types are in the `T` object (frozen). Token type values are human-readable
strings (e.g. `T.IDENT = 'IDENT'`, `T.KW_I32 = 'i32'`). This makes test assertions
and error messages readable without a lookup table.

Important token design decisions:
- **Keywords have their text as the type value** — `T.KW_RETURN = 'return'`. This means
  `token.type === 'return'` for the `return` keyword.
- **Multi-character operators** — `/s`, `/u`, `%s`, `%u`, `>>s`, `>>u` are each single
  tokens produced by the lexer. The lexer reads the operator character then peeks at
  the next character to decide which token to emit.
- **`#[`** is a single `PRAGMA_OPEN` token — the lexer emits it when it sees `#[`.
- **Decorators** — `@export`, `@import`, `@start`, `@tail`, `@debug` are each single
  tokens. Unknown `@name` sequences produce an error and an `IDENT` token.
- **Labels** — `'name` (tick-name) is a `LABEL` token with `value = 'name'` (no tick).

---

## Lexer (`src/parser/lexer.js`)

The `Lexer` class takes a source string and a file name. Call `.tokenize()` to get
`Token[]`. Errors are collected in `lexer.errors` — the lexer always produces a token
stream, even on error.

Error recovery: the lexer skips the offending character and continues. All errors are
soft (no throws). The token stream always ends with an `EOF` token.

**Token shape:**
```js
{ type: string, value: string, line: number, col: number, file: string }
```

Number literal encoding: type suffixes are encoded in the `value` field as
`"number:suffix"` — e.g., `42:i64`. The parser splits on `:` to extract both parts.

---

## AST (`src/parser/ast.js`)

All AST nodes are plain objects created by constructor functions:

```js
export const funcDecl = (name, params, results, typeRef, locals, body, decorators, loc) =>
  ({ kind: 'FuncDecl', name, params, results, typeRef, locals, body, decorators, loc });
```

Every node has:
- `kind: string` — identifies the node type (e.g. `'FuncDecl'`, `'BinaryExpr'`)
- `loc: { file, line, col, endLine, endCol }` — source location

The `errorNode(code, loc)` constructor produces a recovery node used when the parser
cannot construct a valid AST for a portion of source. ErrorNodes propagate through the
type checker silently (the type checker returns `Types.error` for any ErrorNode child,
which suppresses cascading errors).

Helper functions:
- `locFrom(token)` — creates a Loc from a token
- `span(startLoc, endLoc)` — merges two Locs into a span

---

## Parser (`src/parser/parser.js`)

Recursive descent. The parser consumes tokens via:
- `peek()` — lookahead without consuming
- `advance()` — consume and return current token
- `eat(type)` — consume if type matches, return token or null
- `expect(type, hint?)` — consume if type matches, else emit error and return synthetic token

Error recovery strategy:
1. **Statement recovery** — when a statement fails, skip to the next statement
   boundary (`STMT_RECOVERY` set: `;`, `}`, keywords that start statements).
2. **Declaration recovery** — when a declaration fails, skip to the next declaration
   boundary (`DECL_RECOVERY` set: `type`, `memory`, `global`, identifiers, etc.).
3. **Infinite loop prevention** — `parseStmtList` tracks `prevPos` and force-advances
   if position didn't move. This catches any recovery path that fails to consume.

**Operator precedence** (lowest to highest):
```
||   &&   == !=   < > <= >=   |   ^   &   << >>s >>u   + -   * /s /u %s %u   unary   postfix
```

**Key parsing rules:**
- `return (a, b)` is a multi-value return — only treated as tuple if a comma appears
  before the closing `)`. `return (a + b) * c` is parsed normally via `parseExpr`.
- `#[repr(packed)]` — pragmas accept any token as the name (keywords like `repr` are
  valid pragma names).
- `*Point@Mem` — the `@Mem` part is lexed as a decorator-style token (`@Mem`); the
  pointer type parser strips the `@` prefix to get the memory name.
- Loop labels `'name` are `LABEL` tokens; `goto 'name` and `break if (cond)` are
  distinct forms parsed in `parseGoto` and `parseBreak`.
- `@export("customName")` — the `@export` decorator optionally accepts a string
  argument for a custom export name. Parsed in `parseDecorators()` as:
  ```js
  if (this.check(T.LPAREN)) {
    this.advance();
    args.push(this.expect(T.STRING_LIT).value);
    this.expect(T.RPAREN);
  }
  ```
  The emitter uses `isExport.args[0]` when present, falling back to `decl.name`.
- `expectDeclName()` — helper that accepts both `T.IDENT` and keyword tokens as
  declaration names (used in `parseMemoryDecl`, `parseTableDecl`, etc.). This
  enables keyword identifiers like `memory memory = 1;`.

---

## Validator phases

### Phase 1: Scope checking (`src/validator/scope.js`)

The `ScopeChecker` does two passes:
1. **Collect** — walks top-level declarations and builds `this.symbols` (the module
   symbol table). Detects duplicate declarations.
2. **Resolve** — walks all expressions and statements, checking that names exist.
   For functions, builds a per-function local scope from params and locals, then
   walks the body.

Label scoping: the checker maintains a `loopLabelStack`. Each loop pushes a `Set` of
labels defined in that loop. `goto 'label` checks the innermost loop's label set. If
the label is in an outer loop's set, E216 is emitted. After the loop, the set is popped.

Const expression checking: global initializers, element segments, and data placements
are const contexts. `resolveExpr(..., isConst: true)` checks that mutable globals
(E301), function calls (E302), and locals (E303) are not used.

### Phase 2: Type checking (`src/validator/typecheck.js`)

The `TypeChecker` walks all declarations and checks type compatibility. It uses the
symbol table from phase 1 and resolves type AST nodes to type objects via
`resolveType(typeExpr)`.

**Error infection rule:** if any operand is `Types.error`, the result is `Types.error`
and no further error is emitted for that expression. This prevents cascading errors
from a single undefined name.

**Type objects** (from `src/validator/types.js`):
```js
{ kind: 'prim', name: 'i32', wasm: 'i32', signed: true, size: 4 }
{ kind: 'func', params: [...], results: [...] }
{ kind: 'struct', name: 'Point', decl: { fields: [...] } }
{ kind: 'array', name: 'IntArray', decl: { elemType: ..., isMut: ... } }
{ kind: 'pointer', baseType: ..., memory: 'Mem' }
{ kind: 'error' }   // propagates silently
```

**i32/u32 compatibility:** `intCompat(a, b)` returns true for any two types in the
same WASM integer group (`i8/i16/i32/u8/u16/u32/isize/usize` → `i32`, `i64/u64` → `i64`).
This implements the "signed/unsigned are the same WASM type" rule.

**Large integer literals** are auto-promoted: if an `IntLit` has `numType: 'i32'` but
`value > 2147483647n`, it is typed as `i64`.

### Phase 3: Memory validation (`src/validator/index.js`)

- Memory `max >= min`
- Pascal strings ≤ 255 characters (checked on `DataDecl` using `dataType.strType`)
- Named data segment references in `MemoryInit` must be `DataDecl` nodes
- Named element segment references in table inits must be `ElemDecl` nodes
- Warns W001 for unused `DataDecl` (not placed into any memory)
- Warns W002 for unused `ElemDecl` (not placed into any table)
- With multiple memories, warns if bare `load`/`store` calls are used

### Phase 4: Link validation (`src/validator/index.js`)

- Duplicate `@export` names within a single file → E500
- `@import` with a body → E501
- `@start` with params or return values → E504
- Tag param types must be value types (not `cstr`, `utf8_32`, etc.) → E505

---

## WAT Emitter (`src/emitter/wat.js`)

The `WatEmitter` converts the validated AST to a WAT text string.

**Type inference:** the emitter needs to know the WASM type of sub-expressions to
emit the correct instruction prefix (`i32.add` vs `i64.add`). It uses
`inferExprWatType(expr)` which:
- Checks `currentLocals` (populated at the start of `emitFunc` for each function's
  params and locals)
- Checks `this.symbols` for globals
- Falls back to `'i32'` for unknown expressions

**Short-circuit operators:** `&&` and `||` use WAT `if` blocks since WASM has no
native short-circuit operators:
```wat
;; a && b
<emit a>
if (result i32)
  then <emit b>
  else i32.const 0
end

;; a || b
<emit a>
if (result i32)
  then i32.const 1
  else <emit b>
end
```

**`!` operator** — emits `i32.eqz` (not a logical negation instruction in WASM).

**`~` operator** — emits `i32.const -1; i32.xor` (XOR with all-ones mask).

**Loops:** WML's `loop { { 'label ... } }` compiles to WAT `block`/`loop`. The emitter
has two modes depending on whether any `goto` in the loop crosses block boundaries.

### Simple mode

Used when all `goto` targets are within the same block (no cross-block gotos).

```wat
(block $__loop_exit
  (loop $__loop_head
    (block $label1
      (block $label2
        ... stmts ...
      )
    )
    br $__loop_head  ;; implicit continue
  )
)
```

`break` → `br $__loop_exit`, `goto 'label` → `br $label`.

Multiple sibling blocks fall through sequentially — after `$label1`'s block closes,
execution continues into `$label2`'s code (if any), then on to subsequent blocks.

### Relooper mode

Used when a `goto` targets a label in a **different** block. WASM's `br` can only
target enclosing blocks, so a cross-block goto from one sibling block to another
would produce invalid WAT. Instead, the emitter uses a state-machine relooper
pattern driven by a `$__state` local and `br_table`:

```wat
(block $__loop_exit
  i32.const 0
  local.set $__state       ;; initialized once on entry

  (loop $__loop_head
    (block $__default
      (block $0            ;; outermost target — block 0 code after $0 closes
        (block $1          ;; next target — block 1 code after $1 closes
          (block $2        ;; innermost target — block 2 code after $2 closes
            (block $__dispatch
              (br_table $0 $1 $2 $__default (local.get $__state))
            )
          )                ;; close $2
          ;; Block 2 code  (inside $1)
        )                  ;; close $1
        ;; Block 1 code    (inside $0)
      )                    ;; close $0
      ;; Block 0 code      (inside $__default)
    )
    br $__loop_exit         ;; unknown/default state
  )
)
```

How it works:

1. **Dispatcher** — `br_table` reads `$__state` and branches to the corresponding
   `block`. Because `br` exits the block, execution resumes **after** that block's
   closing paren, where the block's code is emitted.

2. **Cross-block `goto 'label`** — sets `$__state` to the target block's index
   and branches back to the loop head:
   ```wat
   i32.const <target>
   local.set $__state
   br $__loop_head
   ```

3. **Block fall-through** — after a block's statements, sets `$__state` to the
   next block index and loops back. The last block wraps around to index 0.

4. **`break`** — unchanged from simple mode: `br $__loop_exit`.

Detection is handled by `_hasCrossBlockGoto(loopStmt)` which scans all `GotoStmt`
nodes in the loop body and checks whether any target a different block index.
The `$__state` local is only emitted for functions that contain at least one
relooper loop (checked by `_needsRelooper(body)`).

**WAT structural constraint:** Blocks are nested outermost-first (block 0 wraps
all others) so that `br_table $0` correctly exits the outermost block and lands
on block 0's code. The nesting order is the reverse of the simple mode.

**Data bytes:** data items are converted to byte arrays via `itemToBytes`. String
types produce:
- `cstr "s"` → UTF-8 bytes + null terminator
- `utf8_32 "s"` → 4-byte LE length + UTF-8 bytes
- `utf8_64 "s"` → 8-byte LE length + UTF-8 bytes
- `pascal "s"` → 1-byte length + UTF-8 bytes (max 255 chars)

---

## Linker (`src/linker.js`)

The `Linker` merges an array of `{ name, ast, symbols, expose? }` objects.

Rules:
- **Non-exported duplicates** → E201
- **Exported functions** → last definition wins (enables override pattern)
- **`@import` deduplication** — same `(module, name)` with same signature: keep one.
  Different signature: E506.
- **Multiple `@start`** → synthetic `__start()` calls each in order
- **`expose: ['*']`** → all symbols from this file are visible to subsequent files
- **`expose: ['name1', ...]`** → only named symbols are exposed

---

## Adding a new WML feature

1. **Add token** — add constant to `T` in `tokens.js`, add to `KEYWORDS` if it's a
   keyword.
2. **Update parser** — add a case in the appropriate `parse*` method. Add a new
   constructor in `ast.js` if needed.
3. **Update scope checker** — add a case in `resolveStmt` or `resolveExpr` for new
   AST nodes.
4. **Update type checker** — add a case in `checkStmt` or `checkExpr`. Return the
   correct type.
5. **Update validator** — add memory/link checks if relevant.
6. **Update WAT emitter** — add a case in `emitStmt` or `emitExpr`. Map to the
   correct WAT instruction(s).
7. **Add tests** — add parser tests (does it parse correctly?), validator tests (does
   it catch errors?), emitter tests (does it emit the right WAT?), and a feature
   integration test.

---

## Error code ranges

| Range | Category         | Examples |
|-------|------------------|---------|
| E0xx  | Syntax           | E001 unexpected token, E004 unclosed delimiter |
| E1xx  | Type             | E100 type mismatch, E105 immutable field |
| E2xx  | Scope            | E200 undefined name, E209 break outside loop |
| E3xx  | Const expression | E300 non-const expr, E302 function call in const |
| E4xx  | Memory           | E403 pascal too long, E404 invalid memory range |
| E5xx  | Link             | E500 duplicate export, E506 import conflict |
| E6xx  | Pointer          | E600 deref non-pointer, E605 repr conflict |
| W0xx  | Warnings         | W001 unused data, W002 unused elem |

---

## Testing

All tests use Node.js built-in `node:test` and `node:assert` — no external test
framework is required.

Run all tests:
```sh
node --test 'test/**/*.test.js'
```

Run a single suite:
```sh
node test/parser/parser.test.js
node test/validator/validator.test.js
node test/emitter/emitter.test.js
node test/features/features.test.js
```

Test helpers pattern used throughout:
```js
function parseOk(source) {
  const result = parse(source);
  assert.equal(result.errors.length, 0, ...);
  return result.ast;
}

function hasCode(source, code) {
  assert.ok(errCodes(source).includes(code), ...);
}
```

The feature tests check the full pipeline (parse → validate → emit) and verify:
1. No validation errors
2. WAT output has balanced parentheses
3. Specific WAT constructs appear in the output
