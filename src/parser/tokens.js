/**
 * @fileoverview Token type definitions for the WML lexer.
 *
 * Every token produced by the lexer has one of these types.
 * String values are used so test output and error messages are human-readable.
 *
 * @example
 * import { T } from './tokens.js';
 * token.type === T.IDENT  // true for an identifier token
 */

/** @enum {string} All token types */
export const T = Object.freeze({
  // ── Literals ────────────────────────────────────────────
  INT_LIT:    'INT_LIT',    // 42  0xFF  0b1010
  FLOAT_LIT:  'FLOAT_LIT',  // 1.0  -3.14
  STRING_LIT: 'STRING_LIT', // "hello"  (raw content, prefix separate)
  LABEL:      'LABEL',      // 'labelName

  // ── Identifiers & keywords ───────────────────────────────
  IDENT:      'IDENT',

  // Top-level declaration keywords
  KW_TYPE:    'type',
  KW_MEMORY:  'memory',
  KW_TABLE:   'table',
  KW_DATA:    'data',
  KW_ELEM:    'elem',
  KW_TAG:     'tag',
  KW_SECTION: 'section',
  KW_REC:     'rec',

  // Storage / binding
  KW_LOCAL:   'local',
  KW_GLOBAL:  'global',
  KW_MUT:     'mut',

  // Function modifiers
  KW_RETURN:  'return',
  KW_TAIL:    'tail',

  // Control flow
  KW_IF:      'if',
  KW_ELSE:    'else',
  KW_LOOP:    'loop',
  KW_BREAK:   'break',
  KW_GOTO:    'goto',

  // Exception handling
  KW_TRY:     'try',
  KW_CATCH:   'catch',
  KW_THROW:   'throw',

  // Misc statements
  KW_UNREACHABLE: 'unreachable',
  KW_NOP:     'nop',
  KW_SELECT:  'select',
  KW_NEW:     'new',
  KW_DECLARE: 'declare',

  // Type keywords — primitives
  KW_I8:      'i8',
  KW_I16:     'i16',
  KW_I32:     'i32',
  KW_I64:     'i64',
  KW_ISIZE:   'isize',
  KW_U8:      'u8',
  KW_U16:     'u16',
  KW_U32:     'u32',
  KW_U64:     'u64',
  KW_USIZE:   'usize',
  KW_F32:     'f32',
  KW_F64:     'f64',
  KW_V128:    'v128',

  // SIMD shaped types
  KW_I8X16:   'i8x16',
  KW_I16X8:   'i16x8',
  KW_I32X4:   'i32x4',
  KW_I64X2:   'i64x2',
  KW_F32X4:   'f32x4',
  KW_F64X2:   'f64x2',

  // Reference types
  KW_FUNCREF:   'funcref',
  KW_EXTERNREF: 'externref',
  KW_ANYREF:    'anyref',
  KW_EQREF:     'eqref',
  KW_STRUCTREF: 'structref',
  KW_ARRAYREF:  'arrayref',
  KW_I31REF:    'i31ref',
  KW_NULLREF:   'nullref',
  KW_EXNREF:    'exnref',

  // Type constructors
  KW_STRUCT:  'struct',
  KW_ARRAY:   'array',  // used in 'array of T' syntax
  KW_FINAL:   'final',
  KW_EXTENDS: 'extends',
  KW_OF:      'of',
  KW_SHARED:  'shared',
  KW_NULL:    'null',

  // String literal types
  KW_CSTR:    'cstr',
  KW_UTF8_32: 'utf8_32',
  KW_UTF8_64: 'utf8_64',
  KW_PASCAL:  'pascal',

  // Repr
  KW_REPR:    'repr',
  KW_PACKED:  'packed',

  // sizeof
  KW_SIZEOF:  'sizeof',

  // Decorators
  AT_EXPORT:  '@export',
  AT_IMPORT:  '@import',
  AT_START:   '@start',
  AT_TAIL:    '@tail',
  AT_DEBUG:   '@debug',

  // Pragma
  PRAGMA_OPEN:  '#[',   // start of #[...]

  // ── Operators ────────────────────────────────────────────
  // Arithmetic
  PLUS:     '+',
  MINUS:    '-',
  STAR:     '*',
  SLASH_S:  '/s',   // signed division
  SLASH_U:  '/u',   // unsigned division
  PERCENT_S:'%s',   // signed remainder
  PERCENT_U:'%u',   // unsigned remainder

  // Bitwise
  AMP:      '&',
  PIPE:     '|',
  CARET:    '^',
  TILDE:    '~',
  SHL:      '<<',
  SHR_S:    '>>s',  // signed shift right
  SHR_U:    '>>u',  // unsigned shift right

  // Logical
  AND:      '&&',
  OR:       '||',
  BANG:     '!',

  // Comparison
  EQ:       '==',
  NEQ:      '!=',
  LT:       '<',
  GT:       '>',
  LTE:      '<=',
  GTE:      '>=',

  // Assignment
  ASSIGN:       '=',
  PLUS_ASSIGN:  '+=',
  MINUS_ASSIGN: '-=',
  STAR_ASSIGN:  '*=',

  // Pointer / member
  ARROW:    '->',   // kept for future use / error messages
  DOT:      '.',
  QUESTION: '?',

  // Misc
  COLON:    ':',
  SEMI:     ';',
  COMMA:    ',',
  FAT_ARROW:'=>',
  PIPE_NULL:'|',   // for null union (reused PIPE contextually)
  AT:       '@',

  // Delimiters
  LPAREN:   '(',
  RPAREN:   ')',
  LBRACE:   '{',
  RBRACE:   '}',
  LBRACKET: '[',
  RBRACKET: ']',

  // Range
  DOTDOT:   '..',

  // Special
  EOF:      'EOF',
});

/**
 * Keywords that map from source text to token type.
 * Identifiers are checked against this map after lexing.
 * @type {Map<string, string>}
 */
export const KEYWORDS = new Map([
  ['type',        T.KW_TYPE],
  ['memory',      T.KW_MEMORY],
  ['table',       T.KW_TABLE],
  ['data',        T.KW_DATA],
  ['elem',        T.KW_ELEM],
  ['tag',         T.KW_TAG],
  ['section',     T.KW_SECTION],
  ['rec',         T.KW_REC],
  ['local',       T.KW_LOCAL],
  ['global',      T.KW_GLOBAL],
  ['mut',         T.KW_MUT],
  ['return',      T.KW_RETURN],
  ['tail',        T.KW_TAIL],
  ['if',          T.KW_IF],
  ['else',        T.KW_ELSE],
  ['loop',        T.KW_LOOP],
  ['break',       T.KW_BREAK],
  ['goto',        T.KW_GOTO],
  ['try',         T.KW_TRY],
  ['catch',       T.KW_CATCH],
  ['throw',       T.KW_THROW],
  ['unreachable', T.KW_UNREACHABLE],
  ['nop',         T.KW_NOP],
  ['select',      T.KW_SELECT],
  ['new',         T.KW_NEW],
  ['declare',     T.KW_DECLARE],
  ['i8',          T.KW_I8],
  ['i16',         T.KW_I16],
  ['i32',         T.KW_I32],
  ['i64',         T.KW_I64],
  ['isize',       T.KW_ISIZE],
  ['u8',          T.KW_U8],
  ['u16',         T.KW_U16],
  ['u32',         T.KW_U32],
  ['u64',         T.KW_U64],
  ['usize',       T.KW_USIZE],
  ['f32',         T.KW_F32],
  ['f64',         T.KW_F64],
  ['v128',        T.KW_V128],
  ['i8x16',       T.KW_I8X16],
  ['i16x8',       T.KW_I16X8],
  ['i32x4',       T.KW_I32X4],
  ['i64x2',       T.KW_I64X2],
  ['f32x4',       T.KW_F32X4],
  ['f64x2',       T.KW_F64X2],
  ['funcref',     T.KW_FUNCREF],
  ['externref',   T.KW_EXTERNREF],
  ['anyref',      T.KW_ANYREF],
  ['eqref',       T.KW_EQREF],
  ['structref',   T.KW_STRUCTREF],
  ['arrayref',    T.KW_ARRAYREF],
  ['i31ref',      T.KW_I31REF],
  ['nullref',     T.KW_NULLREF],
  ['exnref',      T.KW_EXNREF],
  ['struct',      T.KW_STRUCT],
  ['final',       T.KW_FINAL],
  ['extends',     T.KW_EXTENDS],
  ['of',          T.KW_OF],
  ['shared',      T.KW_SHARED],
  ['null',        T.KW_NULL],
  ['cstr',        T.KW_CSTR],
  ['utf8_32',     T.KW_UTF8_32],
  ['utf8_64',     T.KW_UTF8_64],
  ['pascal',      T.KW_PASCAL],
  ['repr',        T.KW_REPR],
  ['packed',      T.KW_PACKED],
  ['sizeof',      T.KW_SIZEOF],
]);

/**
 * Primitive numeric type keywords.
 * @type {Set<string>}
 */
export const NUMERIC_TYPES = new Set([
  T.KW_I8, T.KW_I16, T.KW_I32, T.KW_I64, T.KW_ISIZE,
  T.KW_U8, T.KW_U16, T.KW_U32, T.KW_U64, T.KW_USIZE,
  T.KW_F32, T.KW_F64, T.KW_V128,
  T.KW_I8X16, T.KW_I16X8, T.KW_I32X4, T.KW_I64X2,
  T.KW_F32X4, T.KW_F64X2,
]);

/**
 * Reference type keywords.
 * @type {Set<string>}
 */
export const REF_TYPES = new Set([
  T.KW_FUNCREF, T.KW_EXTERNREF, T.KW_ANYREF, T.KW_EQREF,
  T.KW_STRUCTREF, T.KW_ARRAYREF, T.KW_I31REF, T.KW_NULLREF,
  T.KW_EXNREF,
]);

/**
 * Data layout string type keywords.
 * @type {Set<string>}
 */
export const STRING_TYPES = new Set([
  T.KW_CSTR, T.KW_UTF8_32, T.KW_UTF8_64, T.KW_PASCAL,
]);

/**
 * All type-starting tokens (used in parser lookahead).
 * @type {Set<string>}
 */
export const TYPE_START = new Set([
  ...NUMERIC_TYPES,
  ...REF_TYPES,
  T.KW_FUNCREF, T.LBRACKET, T.STAR,
  T.IDENT,  // named type
]);
