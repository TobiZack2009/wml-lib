/**
 * @fileoverview WML error codes, messages, and diagnostic utilities.
 *
 * Error codes are grouped by category:
 *   E0xx — Syntax errors (parser)
 *   E1xx — Type errors (type checker)
 *   E2xx — Scope errors (scope checker)
 *   E3xx — Const expression errors
 *   E4xx — Memory errors
 *   E5xx — Link errors
 *   E6xx — Pointer errors
 *   W0xx — Warnings
 *
 * @example
 * import { mkError, mkWarning, formatDiagnostics } from './errors.js';
 * const err = mkError('E100', 'type mismatch', 'expected i32, found f64', null, loc);
 */

/**
 * @typedef {Object} Location
 * @property {string} file
 * @property {number} line
 * @property {number} col
 * @property {number} endLine
 * @property {number} endCol
 */

/**
 * @typedef {Object} Diagnostic
 * @property {string} code
 * @property {string} category
 * @property {string} kind
 * @property {'error'|'warning'} severity
 * @property {string} message
 * @property {string} detail
 * @property {string|null} hint
 * @property {Location} location
 * @property {boolean} recovered
 */

/** @type {Record<string, { category: string, kind: string, hint?: string }>} */
export const ERROR_META = {
  // ── Syntax E0xx ──────────────────────────────────────────────────────────
  E001: { category: 'SyntaxError', kind: 'UnexpectedToken' },
  E002: { category: 'SyntaxError', kind: 'UnexpectedEOF' },
  E003: { category: 'SyntaxError', kind: 'InvalidLiteral' },
  E004: { category: 'SyntaxError', kind: 'UnclosedDelimiter' },
  E005: { category: 'SyntaxError', kind: 'InvalidEscape' },
  E006: { category: 'SyntaxError', kind: 'InvalidStringChar' },
  E007: { category: 'SyntaxError', kind: 'MissingReturnType' },
  E008: { category: 'SyntaxError', kind: 'InvalidOperator' },
  E009: { category: 'SyntaxError', kind: 'MalformedType' },
  E010: { category: 'SyntaxError', kind: 'MissingBody' },

  // ── Type E1xx ────────────────────────────────────────────────────────────
  E100: { category: 'TypeError', kind: 'TypeMismatch',
    hint: 'Check the types on both sides of the expression' },
  E101: { category: 'TypeError', kind: 'InvalidOperands' },
  E102: { category: 'TypeError', kind: 'InvalidReturn' },
  E103: { category: 'TypeError', kind: 'InvalidCast' },
  E104: { category: 'TypeError', kind: 'InvalidFieldAccess' },
  E105: { category: 'TypeError', kind: 'ImmutableField',
    hint: 'Declare the field with mut to allow mutation' },
  E106: { category: 'TypeError', kind: 'InvalidArrayAccess' },
  E107: { category: 'TypeError', kind: 'InvalidCall' },
  E108: { category: 'TypeError', kind: 'SignatureMismatch' },
  E109: { category: 'TypeError', kind: 'InvalidSelect',
    hint: 'Both operands of select must have the same type' },
  E110: { category: 'TypeError', kind: 'InvalidTableType' },
  E111: { category: 'TypeError', kind: 'MultipleReturnMismatch' },
  E112: { category: 'TypeError', kind: 'InvalidRefCall',
    hint: 'Add a type annotation: fn<TypeName>(args)' },
  E113: { category: 'TypeError', kind: 'ImmutableGlobal',
    hint: "Declare the global with 'mut' to allow mutation" },
  E115: { category: 'TypeError', kind: 'InvalidSIMDLane' },
  E116: { category: 'TypeError', kind: 'InvalidAtomicType',
    hint: 'Atomic operations support i32 and i64 only' },
  E117: { category: 'TypeError', kind: 'NonSharedAtomic',
    hint: "Declare memory with 'shared' to use atomic operations" },

  // ── Scope E2xx ───────────────────────────────────────────────────────────
  E200: { category: 'ScopeError', kind: 'UndefinedName' },
  E201: { category: 'ScopeError', kind: 'DuplicateDeclaration' },
  E202: { category: 'ScopeError', kind: 'UndefinedType' },
  E203: { category: 'ScopeError', kind: 'UndefinedLabel' },
  E204: { category: 'ScopeError', kind: 'UndefinedMemory' },
  E205: { category: 'ScopeError', kind: 'UndefinedTable' },
  E206: { category: 'ScopeError', kind: 'UndefinedTag' },
  E207: { category: 'ScopeError', kind: 'UndefinedData' },
  E208: { category: 'ScopeError', kind: 'UndefinedElem' },
  E209: { category: 'ScopeError', kind: 'BreakOutsideBlock',
    hint: "'break' must be used inside a loop" },
  E210: { category: 'ScopeError', kind: 'ContinueOutsideLoop' },
  E211: { category: 'ScopeError', kind: 'InvalidBreakTarget' },
  E212: { category: 'ScopeError', kind: 'InvalidContinueTarget' },
  E213: { category: 'ScopeError', kind: 'StartDuplicate',
    hint: 'Multiple @start functions across files are merged. Duplicate within a single file is not allowed.' },
  E214: { category: 'ScopeError', kind: 'ForwardRefInConst' },
  E215: { category: 'ScopeError', kind: 'UndefinedLoopLabel' },
  E216: { category: 'ScopeError', kind: 'OuterLoopGoto',
    hint: 'goto can only target labels within the same loop' },
  E217: { category: 'ScopeError', kind: 'DuplicateLabel' },
  E218: { category: 'ScopeError', kind: 'DeclInBlock',
    hint: 'Move variable declarations to the top of the function, before any statements' },
  E219: { category: 'ScopeError', kind: 'StmtBeforeDecl',
    hint: 'All local declarations must appear before any statements' },
  E220: { category: 'ScopeError', kind: 'LabelCollision',
    hint: 'Two labels cannot occupy the same position' },

  // ── Const E3xx ───────────────────────────────────────────────────────────
  E300: { category: 'ConstError', kind: 'NonConstExpr' },
  E301: { category: 'ConstError', kind: 'MutableGlobalInConst',
    hint: 'Only immutable globals can be used in constant expressions' },
  E302: { category: 'ConstError', kind: 'FuncCallInConst',
    hint: 'Function calls are not allowed in constant expressions' },
  E303: { category: 'ConstError', kind: 'LocalInConst',
    hint: 'Locals and parameters cannot be used in constant expressions' },
  E304: { category: 'ConstError', kind: 'InvalidConstType' },

  // ── Memory E4xx ──────────────────────────────────────────────────────────
  E400: { category: 'MemoryError', kind: 'DataOutOfRange' },
  E401: { category: 'MemoryError', kind: 'DataOverlap' },
  E402: { category: 'MemoryError', kind: 'InvalidDataType' },
  E403: { category: 'MemoryError', kind: 'PascalStringTooLong',
    hint: 'Pascal strings are limited to 255 characters' },
  E404: { category: 'MemoryError', kind: 'InvalidMemoryRange',
    hint: 'Memory max must be greater than or equal to min' },
  E405: { category: 'MemoryError', kind: 'DynamicPlacementInActive' },
  E406: { category: 'MemoryError', kind: 'DropPassiveOnly',
    hint: '.drop() can only be called on passive data segments' },
  E407: { category: 'MemoryError', kind: 'MultipleMemoryAmbiguous',
    hint: 'Use MemoryName.load/store when multiple memories are defined' },

  // ── Link E5xx ────────────────────────────────────────────────────────────
  E500: { category: 'LinkError', kind: 'DuplicateExport' },
  E501: { category: 'LinkError', kind: 'ImportBodyPresent',
    hint: 'Imported declarations must not have a body' },
  E502: { category: 'LinkError', kind: 'ImportMissingType',
    hint: 'Add a type annotation to the import' },
  E503: { category: 'LinkError', kind: 'ExportUndefined' },
  E504: { category: 'LinkError', kind: 'StartBadSignature',
    hint: '@start function must take no parameters and return ()' },
  E505: { category: 'LinkError', kind: 'TagBadParamType',
    hint: 'Use value types (i32, i64, f32, f64, ref types) for tag parameters' },
  E506: { category: 'LinkError', kind: 'ImportConflict',
    hint: 'The same import name is declared with conflicting types across files' },

  // ── Pointer E6xx ─────────────────────────────────────────────────────────
  E600: { category: 'PointerError', kind: 'DerefNonPointer',
    hint: 'Use ptr[0].field syntax to access fields through a pointer' },
  E601: { category: 'PointerError', kind: 'InvalidPointerType',
    hint: 'Pointers can only target types with a defined linear memory layout' },
  E602: { category: 'PointerError', kind: 'PointerMemoryAmbiguous',
    hint: 'Use *Type@MemoryName when multiple memories are defined' },
  E603: { category: 'PointerError', kind: 'PointerTypeMismatch' },
  E604: { category: 'PointerError', kind: 'UnalignedAccess',
    hint: 'Use repr(packed) to allow unaligned field access' },
  E605: { category: 'PointerError', kind: 'ReprConflict',
    hint: 'repr(packed) and repr(C) cannot be combined' },
  E606: { category: 'PointerError', kind: 'OverlappingFields' },
  E619: { category: 'BrTableError', kind: 'BrTableEmpty',
    hint: 'goto table must have at least one label' },

  // ── Warnings W0xx ────────────────────────────────────────────────────────
  W001: { category: 'Warning', kind: 'UnusedData' },
  W002: { category: 'Warning', kind: 'UnusedElem' },
  W005: { category: 'Warning', kind: 'UnreachableCode' },
  W006: { category: 'Warning', kind: 'DroppedNotUsed' },
};

/**
 * Create an error diagnostic.
 * @param {string} code
 * @param {string} message
 * @param {string} detail
 * @param {string|null} hint
 * @param {Location} location
 * @param {boolean} [recovered=false]
 * @returns {Diagnostic}
 */
export function mkError(code, message, detail, hint, location, recovered = false) {
  const meta = ERROR_META[code] ?? { category: 'Error', kind: code };
  return {
    code,
    category: meta.category,
    kind: meta.kind,
    severity: 'error',
    message,
    detail,
    hint: hint ?? meta.hint ?? null,
    location,
    recovered,
  };
}

/**
 * Create a warning diagnostic.
 * @param {string} code
 * @param {string} message
 * @param {string} detail
 * @param {string|null} hint
 * @param {Location} location
 * @returns {Diagnostic}
 */
export function mkWarning(code, message, detail, hint, location) {
  const meta = ERROR_META[code] ?? { category: 'Warning', kind: code };
  return {
    code,
    category: meta.category,
    kind: meta.kind,
    severity: 'warning',
    message,
    detail,
    hint: hint ?? meta.hint ?? null,
    location,
    recovered: false,
  };
}

/**
 * Group diagnostics by file.
 * @param {Diagnostic[]} diagnostics
 * @returns {{ file: string, diagnostics: Diagnostic[] }[]}
 */
export function groupByFile(diagnostics) {
  /** @type {Map<string, Diagnostic[]>} */
  const map = new Map();
  for (const d of diagnostics) {
    const file = d.location?.file ?? 'unknown';
    if (!map.has(file)) map.set(file, []);
    map.get(file).push(d);
  }
  return Array.from(map.entries()).map(([file, diags]) => ({
    file,
    diagnostics: diags.sort((a, b) => a.location.line - b.location.line || a.location.col - b.location.col),
  }));
}

/**
 * Format diagnostics as pretty text for terminal output.
 * @param {Diagnostic[]} diagnostics
 * @param {string[]} sources - Source lines per file, indexed by file name
 * @param {{ color?: boolean, context?: number, maxErrors?: number }} [options]
 * @returns {string}
 */
export function formatText(diagnostics, sourceMap = {}, options = {}) {
  const { color = true, context = 1, maxErrors = 20 } = options;

  const c = {
    reset:  color ? '\x1b[0m'  : '',
    red:    color ? '\x1b[31m' : '',
    yellow: color ? '\x1b[33m' : '',
    blue:   color ? '\x1b[34m' : '',
    cyan:   color ? '\x1b[36m' : '',
    bold:   color ? '\x1b[1m'  : '',
  };

  const errors   = diagnostics.filter(d => d.severity === 'error');
  const warnings = diagnostics.filter(d => d.severity === 'warning');
  const shown    = [...errors, ...warnings].slice(0, maxErrors);
  const lines    = [];

  for (const d of shown) {
    const isError = d.severity === 'error';
    const color_  = isError ? c.red : c.yellow;
    const loc     = d.location;

    lines.push(`${color_}${c.bold}${d.severity}[${d.code}]${c.reset} ${d.message}`);
    lines.push(`  ${c.blue}-->${c.reset} ${loc.file}:${loc.line}:${loc.col}`);

    // Source context
    const srcLines = sourceMap[loc.file]?.split('\n') ?? [];
    if (srcLines.length > 0) {
      const start = Math.max(0, loc.line - 1 - context);
      const end   = Math.min(srcLines.length - 1, loc.line - 1 + context);
      const pad   = String(end + 1).length;
      lines.push(`${c.blue}${' '.repeat(pad + 1)}|${c.reset}`);
      for (let i = start; i <= end; i++) {
        const lineNum = String(i + 1).padStart(pad);
        const src = srcLines[i] ?? '';
        lines.push(`${c.blue}${lineNum} |${c.reset} ${src}`);
        if (i === loc.line - 1) {
          const underLen = Math.max(1, (loc.endCol ?? loc.col + 1) - loc.col);
          const under = ' '.repeat(loc.col - 1) + color_ + '^'.repeat(underLen) + c.reset;
          lines.push(`${c.blue}${' '.repeat(pad + 1)}|${c.reset} ${under}`);
        }
      }
      lines.push(`${c.blue}${' '.repeat(pad + 1)}|${c.reset}`);
    }

    if (d.hint) {
      lines.push(`   ${c.cyan}= hint:${c.reset} ${d.hint}`);
    }
    lines.push('');
  }

  // Summary
  const limited = diagnostics.length > maxErrors;
  if (limited) {
    lines.push(`... ${diagnostics.length - maxErrors} more errors not shown (--max-errors=${maxErrors})`);
  }

  const errCount  = errors.length;
  const warnCount = warnings.length;
  const summary   = [];
  if (errCount)  summary.push(`${errCount} error${errCount !== 1 ? 's' : ''}`);
  if (warnCount) summary.push(`${warnCount} warning${warnCount !== 1 ? 's' : ''}`);
  if (summary.length === 0) {
    lines.push('0 errors — ok');
  } else {
    const success = errCount === 0;
    lines.push(`${summary.join(', ')} — ${success ? 'ok' : 'compilation failed'}`);
  }

  return lines.join('\n');
}

/**
 * Format diagnostics as newline-delimited JSON (NDJSON).
 * Each line is a JSON object. Last line is the summary.
 * @param {Diagnostic[]} diagnostics
 * @param {{ maxErrors?: number }} [options]
 * @returns {string}
 */
export function formatJSON(diagnostics, options = {}) {
  const { maxErrors = 20 } = options;
  const shown = diagnostics.slice(0, maxErrors);
  const lines = shown.map(d => JSON.stringify(d));
  const summary = {
    type: 'summary',
    errors: diagnostics.filter(d => d.severity === 'error').length,
    warnings: diagnostics.filter(d => d.severity === 'warning').length,
    success: diagnostics.filter(d => d.severity === 'error').length === 0,
    limitReached: diagnostics.length > maxErrors,
  };
  lines.push(JSON.stringify(summary));
  return lines.join('\n');
}
