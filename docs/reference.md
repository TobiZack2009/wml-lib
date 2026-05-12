# WML Language Reference

Complete syntax and semantics reference for WML 0.1.

---

## Lexical conventions

### Comments

```wml
// line comment
/* block comment — can span multiple lines */
```

### Integer literals

```wml
42          // decimal
0xFF        // hexadecimal
0b1010      // binary
1_000_000   // underscores as separators
42:i64      // with type suffix
```

### Float literals

```wml
1.0         // f64
3.14e-5     // scientific notation
1.0:f32     // f32 literal
```

An integer assigned to an `f32` or `f64` variable is a bit-reinterpret. `-1.0` is a
single const instruction.

### String literals

```wml
"hello"           // basic string
"line1\nline2"    // escape sequences: \n \t \r \0 \\ \"
"\x41"            // hex escape
"\u{1F600}"       // unicode codepoint escape
```

### Labels

```wml
'labelName    // tick followed by identifier
```

### Decorators

```wml
@export
@import("module", "name")
@start
@tail
@debug
```

### Pragmas

```wml
#[repr(packed)]
#[repr(C)]
```

Multiple pragmas on adjacent lines apply to the next declaration.

---

## Module structure

A WML source file is a flat list of top-level declarations in any order:

```
module ::= decl*

decl ::=
  | pragma* decorator* funcDecl
  | pragma* typeDecl
  | decorator* memoryDecl
  | decorator* tableDecl
  | decorator* globalDecl
  | dataDecl
  | elemDecl
  | decorator* tagDecl
  | sectionDecl
  | recGroup
  | memoryInit
```

---

## Type declarations

```
typeDecl ::= 'type' IDENT '=' typeExpr ';'

typeExpr ::=
  | primitiveType
  | refType
  | funcType
  | structType
  | arrayType
  | pointerType
  | namedType

primitiveType ::= 'i8' | 'i16' | 'i32' | 'i64' | 'isize'
               | 'u8' | 'u16' | 'u32' | 'u64' | 'usize'
               | 'f32' | 'f64' | 'v128'
               | 'i8x16' | 'i16x8' | 'i32x4' | 'i64x2' | 'f32x4' | 'f64x2'

refType ::= 'funcref' | 'funcref' '<' typeExpr '>'
          | 'externref' | 'anyref' | 'eqref' | 'structref'
          | 'arrayref' | 'i31ref' | 'nullref' | 'exnref'

funcType ::= '(' typeExpr* ')' '=>' returnType
returnType ::= typeExpr | '(' typeExpr* ')' | '(' ')'

structType ::= 'final'? 'struct' ('extends' typeExpr)? '{' fieldDecl* '}'
fieldDecl  ::= 'mut'? IDENT ':' typeExpr ';'

arrayType ::= '[' 'mut'? typeExpr ']'

pointerType ::= '*' typeExpr ('@' IDENT)?

namedType ::= IDENT
```

Struct pragmas:
```wml
#[repr(packed)]   // No padding between fields
#[repr(C)]        // Clang WASM32 ABI layout
```

Recursive type groups:
```wml
rec {
  type A = struct { b: B; };
  type B = struct { a: A; };
}
```

---

## Memory declarations

```
memoryDecl ::= 'shared'? 'memory' IDENT '=' INT ('..' INT)? ';'
```

```wml
memory Mem = 4;         // min 4 pages
memory Mem = 4..16;     // min 4, max 16 pages
shared memory Mem = 4;  // shared (threads)
@import("env","mem") memory Mem = 1;
@export memory Mem = 4;
```

---

## Table declarations

```
tableDecl ::= 'shared'? 'table' IDENT ':' '[' typeExpr ']' '=' INT ('..' INT)? ';'
```

```wml
table FuncTable: [funcref] = 16;
table FuncTable: [funcref] = 8..256;
```

---

## Global declarations

```
globalDecl ::= 'global' 'mut'? IDENT ':' typeExpr ('=' expr)? ';'
```

```wml
global PI: f64 = 3.14159265358979;
global mut counter: i32 = 0;
```

Global initializers must be constant expressions (literals, immutable globals,
`sizeof`). Mutable globals cannot be used in constant expressions.

---

## Data segments

```
dataDecl ::= 'data' IDENT (':' dataType)? '=' dataItems ';'

dataType ::= primitiveType '[]'
           | ('cstr' | 'utf8_32' | 'utf8_64' | 'pascal')
           | IDENT '[]'

dataItems ::= dataItem (',' dataItem)*

dataItem ::= stringTypePrefix STRING_LIT
           | typeName '[' expr* ']'    // typed array literal
           | '[' expr* ']'             // bare array literal
           | expr                      // single value or name ref
```

String encoding types:
| Type | Encoding |
|------|----------|
| `cstr` | UTF-8 + null terminator |
| `utf8_32` | 4-byte LE length + UTF-8 |
| `utf8_64` | 8-byte LE length + UTF-8 |
| `pascal` | 1-byte length + UTF-8 (max 255 chars) |

```wml
data Magic:    i8[]    = [0x00, 0x61, 0x73, 0x6D];
data Header:   i8[]    = i8[1, 0, 0, 0];
data Greeting: cstr    = "Hello, World!";
data AppName:  utf8_32 = "MyApp";
data Sizes:    f32[]   = [1.0, 2.0, 4.0];
```

---

## Memory placement

```
memoryInit ::= IDENT '[' expr ']' '=' dataItems ';'
tableInit  ::= IDENT '[' expr ']' '=' elemItems ';'
```

```wml
Mem[0]   = Magic, Greeting;     // sequential, at offset 0
Mem[256] = AppName;
T[0]     = Handlers;            // table init from elem segment
T[4]     = funcref[fn1, fn2];   // inline funcref array
```

---

## Element segments

```
elemDecl ::= 'elem' IDENT (':' typeExpr '[]')? '=' elemItems ';'
           | 'elem' 'declare' typeExpr '[]' '=' elemItems ';'

elemItems ::= 'funcref' '[' expr* ']'
            | '[' expr* ']'
```

```wml
elem Handlers: funcref[] = [onClick, onResize];
elem Funcs:    funcref[] = [ref(add), ref(sub), null];
elem declare funcref[] = [fn1, fn2];   // declarative — no placement
```

---

## Tag declarations

```
tagDecl ::= 'tag' IDENT ':' '(' typeExpr* ')' ';'
```

```wml
tag DivError:   (i32, i32);
@export tag AppError: (i32);
@import("env","jsError") tag JSError: (externref);
```

Tag param types must be value types (`i32`, `i64`, `f32`, `f64`, reference types).
Data layout types (`cstr`, `utf8_32`, etc.) are not allowed.

---

## Function declarations

```
funcDecl ::= IDENT '(' paramList ')' ':' returnType body
           | IDENT ':' typeRef body    // using a typedef

paramList ::= (IDENT ':' typeExpr (',' IDENT ':' typeExpr)*)?

returnType ::= typeExpr
             | '(' typeExpr* ')'
             | '(' ')'

body ::= '{' localDecl* stmt* '}'
       | ';'   // import — no body

localDecl ::= 'local' 'mut'? IDENT ':' typeExpr ('=' expr)? ';'
```

Decorators:
- `@export` — export the function
- `@import("mod","name")` — import (no body)
- `@start` — call on module instantiation (no params, no return)
- `@tail` — enable tail calls at all `return tail` sites in this function

---

## Statements

### Assignment

```
assignStmt ::= lvalue ('=' | '+=' | '-=' | '*=') expr ';'
lvalue ::= IDENT | expr '.' IDENT | expr '[' expr ']' | expr '[' expr ']' '.' IDENT
```

### Return

```
returnStmt ::= 'return' (expr | '(' expr (',' expr)* ')')? ';'
             | 'return' 'tail' callExpr ';'
```

### If

```
ifStmt ::= 'if' '(' expr ')' block ('else' (ifStmt | block))?
block  ::= '{' stmt* '}'
```

### Loop

```
loopStmt  ::= 'loop' '{' loopBlock* '}'
loopBlock ::= '{' (label | stmt)* '}'
label     ::= LABEL    // 'name
```

Branches:
```
breakStmt     ::= 'break' ('if' '(' expr ')')? ';'
gotoStmt      ::= 'goto' LABEL ('if' '(' expr ')')? ';'
gotoTableStmt ::= 'goto' '[' LABEL (',' LABEL)* ']' expr ';'
```

### Try / catch

```
tryStmt     ::= 'try' block catchClause*
catchClause ::= 'catch' IDENT '(' IDENT* ')' (block | '=>' 'break' LABEL ';')
              | 'catch' '(' IDENT ')' block      // catch-all with exnref binding
              | 'catch' block                    // catch-all
```

### Other statements

```
throwStmt       ::= 'throw' expr ';'                  // throw_ref
                  | 'throw' IDENT '(' expr* ')' ';'   // throw with tag
unreachableStmt ::= 'unreachable' ';'
nopStmt         ::= 'nop' ';'
exprStmt        ::= expr ';'
```

---

## Expressions

### Literals

```
intLit   ::= [0-9]+ | '0x'[0-9a-fA-F]+ | '0b'[01]+  (with optional :suffix)
floatLit ::= [0-9]+'.'[0-9]* (with optional :suffix)
stringLit ::= '"' char* '"'
nullLit  ::= 'null'
```

### Operators (grouped by precedence, lowest first)

```
expr ::=
  | expr '||' expr
  | expr '&&' expr
  | expr ('==' | '!=') expr
  | expr ('<' | '>' | '<=' | '>=') expr
  | expr '|' expr
  | expr '^' expr
  | expr '&' expr
  | expr ('<<' | '>>s' | '>>u') expr
  | expr ('+' | '-') expr
  | expr ('*' | '/s' | '/u' | '%s' | '%u') expr
  | ('-' | '~' | '!') expr
  | postfixExpr
```

### Postfix expressions

```
postfixExpr ::= primaryExpr postfix*

postfix ::= '.' IDENT                              // field access / method call
          | '[' expr ']'                            // index
          | '[' expr ']' '.' IDENT                 // pointer field access
          | '(' args ')'                            // call
          | '<' typeExpr '>' '(' args ')'           // typed call
          | 'as' typeExpr                           // checked cast
          | 'as!' typeExpr                          // unchecked cast
          | 'is' typeExpr                           // type test → i32
          | '!'                                     // ref.as_non_null
```

### Primary expressions

```
primaryExpr ::=
  | intLit | floatLit | stringLit | nullLit
  | IDENT
  | 'new' typeExpr '{' fieldInits '}'    // struct
  | 'new' typeExpr '(' expr ')'          // array with size
  | 'new' typeExpr '[' expr* ']'         // array literal
  | 'ref' '(' IDENT ')'                  // ref.func
  | 'sizeof' '(' typeExpr ')'
  | 'select' '(' expr ',' expr ',' expr ')'
  | 'if' '(' expr ')' block 'else' block   // if expression
  | 'try' block catchClause*               // try expression
  | '(' expr ')'
  | typeName '[' expr* ']'                 // typed data literal
  | typeName '.' IDENT ('(' args ')')?     // type method
  | stringType STRING_LIT                  // string with type
```

---

## Type semantics

### Integer signedness

`i32`/`u32` are the same WASM `i32` type at runtime. WML tracks signedness to
select the right instruction:

```wml
a /s b   // i32.div_s
a /u b   // i32.div_u (requires u32 operands)
a >>s 1  // i32.shr_s
a >>u 1  // i32.shr_u (any integer)
```

Mixing signed and unsigned in arithmetic is a type error. Assignment between `i32`
and `u32` is silent (same representation).

### Integer literal promotion

Literals without a suffix default to `i32`. Literals exceeding the i32 range
(`> 2_147_483_647` or `< -2_147_483_648`) are automatically promoted to `i64`.
Use `:i64` suffix to force i64 for in-range values.

### Null

`null` has type `nullref` and is assignable to any reference type.

### Error propagation

A type error on one expression produces `error` type. Any operation receiving
`error` type also produces `error` type without emitting additional diagnostics.
This prevents cascading errors from a single undefined name.

---

## Memory operations

### Load instructions

| WML | WAT |
|-----|-----|
| `Mem.load<i8s>(ptr)` | `i32.load8_s` |
| `Mem.load<u8>(ptr)` | `i32.load8_u` |
| `Mem.load<i16s>(ptr)` | `i32.load16_s` |
| `Mem.load<u16>(ptr)` | `i32.load16_u` |
| `Mem.load<i32>(ptr)` | `i32.load` |
| `Mem.load<i64>(ptr)` | `i64.load` |
| `Mem.load<f32>(ptr)` | `f32.load` |
| `Mem.load<f64>(ptr)` | `f64.load` |
| `Mem.load<v128>(ptr)` | `v128.load` |

### Store instructions

| WML | WAT |
|-----|-----|
| `Mem.store<i8>(ptr, v)` | `i32.store8` |
| `Mem.store<i16>(ptr, v)` | `i32.store16` |
| `Mem.store<i32>(ptr, v)` | `i32.store` |
| `Mem.store<i64>(ptr, v)` | `i64.store` |
| `Mem.store<f32>(ptr, v)` | `f32.store` |
| `Mem.store<f64>(ptr, v)` | `f64.store` |

---

## Operator to WAT mapping

| WML | WAT (i32) | WAT (i64) | WAT (f32) | WAT (f64) |
|-----|-----------|-----------|-----------|-----------|
| `+` | `i32.add` | `i64.add` | `f32.add` | `f64.add` |
| `-` | `i32.sub` | `i64.sub` | `f32.sub` | `f64.sub` |
| `*` | `i32.mul` | `i64.mul` | `f32.mul` | `f64.mul` |
| `/s` | `i32.div_s` | `i64.div_s` | — | — |
| `/u` | `i32.div_u` | `i64.div_u` | — | — |
| `%s` | `i32.rem_s` | `i64.rem_s` | — | — |
| `%u` | `i32.rem_u` | `i64.rem_u` | — | — |
| `&` | `i32.and` | `i64.and` | — | — |
| `\|` | `i32.or` | `i64.or` | — | — |
| `^` | `i32.xor` | `i64.xor` | — | — |
| `<<` | `i32.shl` | `i64.shl` | — | — |
| `>>s` | `i32.shr_s` | `i64.shr_s` | — | — |
| `>>u` | `i32.shr_u` | `i64.shr_u` | — | — |
| `~x` | `i32.const -1; i32.xor` | `i64.const -1; i64.xor` | — | — |
| `-x` | `i32.const 0; i32.sub` | `i64.const 0; i64.sub` | `f32.neg` | `f64.neg` |
| `!x` | `i32.eqz` | — | — | — |
| `==` | `i32.eq` | `i64.eq` | `f32.eq` | `f64.eq` |
| `!=` | `i32.ne` | `i64.ne` | `f32.ne` | `f64.ne` |
| `<` | `i32.lt_s` | `i64.lt_s` | `f32.lt` | `f64.lt` |
| `>` | `i32.gt_s` | `i64.gt_s` | `f32.gt` | `f64.gt` |
| `<=` | `i32.le_s` | `i64.le_s` | `f32.le` | `f64.le` |
| `>=` | `i32.ge_s` | `i64.ge_s` | `f32.ge` | `f64.ge` |

---

## Error code reference

### Syntax errors (E0xx)

| Code | Name | Description |
|------|------|-------------|
| E001 | UnexpectedToken | Unexpected token in source |
| E002 | UnexpectedEOF | Source ended unexpectedly |
| E003 | InvalidLiteral | Malformed literal value |
| E004 | UnclosedDelimiter | Missing closing `"`, `*/`, etc. |
| E005 | InvalidEscape | Unknown escape sequence in string |
| E009 | MalformedType | Invalid type expression |

### Type errors (E1xx)

| Code | Name | Description |
|------|------|-------------|
| E100 | TypeMismatch | Type mismatch in assignment, return, or argument |
| E101 | InvalidOperands | Operator not applicable to these types |
| E102 | InvalidReturn | Return type doesn't match function signature |
| E103 | InvalidCast | Cast between incompatible types |
| E104 | InvalidFieldAccess | Field doesn't exist on type |
| E105 | ImmutableField | Write to a non-mut field |
| E107 | InvalidCall | Calling a non-callable value |
| E108 | SignatureMismatch | Wrong number of arguments |
| E109 | InvalidSelect | select operands have different types |
| E111 | MultipleReturnMismatch | Wrong number of return values |
| E113 | ImmutableGlobal | Write to a non-mut global |

### Scope errors (E2xx)

| Code | Name | Description |
|------|------|-------------|
| E200 | UndefinedName | Name not declared |
| E201 | DuplicateDeclaration | Name declared more than once |
| E202 | UndefinedType | Type name not declared |
| E203 | UndefinedLabel | Label not defined in this loop |
| E204 | UndefinedMemory | Memory name not declared |
| E209 | BreakOutsideBlock | `break` or `goto` used outside a loop |
| E213 | StartDuplicate | Multiple `@start` in same file |
| E215 | UndefinedLoopLabel | `goto` target label not in current loop |
| E216 | OuterLoopGoto | `goto` targets a label in an outer loop |
| E217 | DuplicateLabel | Same label name used twice in one loop |
| E218 | DeclInBlock | Variable declaration inside a block or loop |

### Const errors (E3xx)

| Code | Name | Description |
|------|------|-------------|
| E300 | NonConstExpr | Non-constant expression in const context |
| E301 | MutableGlobalInConst | Mutable global used in const expression |
| E302 | FuncCallInConst | Function call in const expression |
| E303 | LocalInConst | Local or param used in const expression |

### Memory errors (E4xx)

| Code | Name | Description |
|------|------|-------------|
| E403 | PascalStringTooLong | Pascal string exceeds 255 characters |
| E404 | InvalidMemoryRange | Memory max < min |
| E407 | MultipleMemoryAmbiguous | Bare load/store with multiple memories |

### Link errors (E5xx)

| Code | Name | Description |
|------|------|-------------|
| E500 | DuplicateExport | Same name exported more than once |
| E501 | ImportBodyPresent | Imported function has a body |
| E504 | StartBadSignature | @start function has params or returns |
| E505 | TagBadParamType | Tag param is not a value type |
| E506 | ImportConflict | Same import with conflicting types |

### Warnings (W0xx)

| Code | Name | Description |
|------|------|-------------|
| W001 | UnusedData | Data segment declared but never placed |
| W002 | UnusedElem | Element segment declared but never used |
| W005 | UnreachableCode | Code after unconditional branch |
| W006 | DroppedNotUsed | Expression value is dropped |

---

## WebAssembly feature support

WML targets WASM 1.0 + 2.0 + selected 3.0 proposals:

**Included:**
- WasmGC (struct/array reference types)
- Exception handling (try/catch/throw, tags)
- Tail calls (`return tail`)
- Typed function references (`funcref<T>`)
- Extended const expressions
- Relaxed SIMD
- Multi-memory

**Excluded:**
- Memory64 (addresses are always i32 in WML)
- Stack switching
- JS string builtins
- Component model
