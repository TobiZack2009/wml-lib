/**
 * @fileoverview WML public API.
 *
 * Two public functions:
 *
 *   compile(input, options?) → Promise<CompileResult>
 *   validate(input, options?) → Promise<ValidateResult>
 *
 * Input can be:
 *   - A file path string:              compile('module.wml')
 *   - An array of paths:               compile(['a.wml', 'b.wml'])
 *   - A Source object:                 compile({ name: 'mod', content: '...' })
 *   - An array of Source objects:      compile([{ name: 'a', content: '...' }, ...])
 *   - Mixed array:                     compile(['shared.wml', { name: 'app', content: '...' }])
 *
 * Source shape:
 *   { name: string, content: string, expose?: string[] | ['*'] }
 *
 * CompileResult:
 *   {
 *     ok: boolean,
 *     output: string | Uint8Array,    // WAT text or WASM binary
 *     diagnostics: DiagnosticGroup[], // grouped by file
 *     summary: { errors: number, warnings: number }
 *   }
 *
 * ValidateResult:
 *   {
 *     ok: boolean,
 *     diagnostics: DiagnosticGroup[],
 *     summary: { errors: number, warnings: number }
 *   }
 *
 * @example
 * import { compile, validate } from 'wml-lib';
 *
 * // Compile from source string
 * const result = await compile({
 *   name: 'add.wml',
 *   content: 'add(a: i32, b: i32): i32 { return a + b; }'
 * }, { emit: 'wat' });
 *
 * if (result.ok) {
 *   console.log(result.output); // WAT text
 * } else {
 *   for (const group of result.diagnostics) {
 *     for (const d of group.diagnostics) {
 *       console.error(`${d.code}: ${d.message}`);
 *     }
 *   }
 * }
 */

import { readFile } from 'node:fs/promises';
import { Lexer }    from './parser/lexer.js';
import { Parser }   from './parser/parser.js';
import { validateModule } from './validator/index.js';
import { WatEmitter }     from './emitter/wat.js';
import { BinaryenEmitter } from './emitter/binaryen.js';
import { Linker }         from './linker.js';
import { groupByFile, formatText, formatJSON } from './diagnostics/errors.js';

/**
 * @typedef {{ name: string, content: string, expose?: string[]|['*'] }} Source
 * @typedef {{ file: string, diagnostics: import('./diagnostics/errors.js').Diagnostic[] }} DiagnosticGroup
 * @typedef {{ ok: boolean, output: string|Uint8Array, diagnostics: DiagnosticGroup[], summary: { errors: number, warnings: number } }} CompileResult
 * @typedef {{ ok: boolean, diagnostics: DiagnosticGroup[], summary: { errors: number, warnings: number } }} ValidateResult
 */

/**
 * @typedef {Object} CompileOptions
 * @property {'wat'|'wasm'} [emit='wat'] - Output format
 * @property {boolean} [debug=false] - Emit debug info / name section
 * @property {boolean} [optimize=false] - Run Binaryen optimization passes
 * @property {number}  [maxErrors=20] - Max errors before truncation
 * @property {boolean} [noWarn=false] - Suppress warnings
 * @property {boolean} [warnAsError=false] - Treat warnings as errors
 */

/**
 * Compile WML source(s) to WAT or WASM.
 * @param {string|string[]|Source|Source[]|(string|Source)[]} input
 * @param {CompileOptions} [options]
 * @returns {Promise<CompileResult>}
 */
export async function compile(input, options = {}) {
  const { emit = 'wat', debug = false, optimize = false,
          maxErrors = 20, noWarn = false, warnAsError = false } = options;

  // Normalize input to Source[]
  const sources = await normalizeSources(input);

  // Parse all sources
  const parsed = [];
  const allParseErrors = [];

  for (const src of sources) {
    const { ast, errors } = parseSource(src.name, src.content);
    allParseErrors.push(...errors);
    parsed.push({ ...src, ast, parseErrors: errors });
  }

  // Validate each module (with accumulated exposed symbols)
  const exposed = new Map();
  const allValErrors = [];

  for (const p of parsed) {
    const { errors, symbols } = validateModule(p.ast, p.name, exposed);
    allValErrors.push(...errors);
    p.symbols = symbols;

    // Accumulate exposed symbols for next file
    if (p.expose) {
      const exposeAll   = p.expose === '*' || p.expose.includes('*');
      const exposeNames = exposeAll ? null : new Set(p.expose);
      for (const [k, v] of symbols) {
        if (exposeAll || exposeNames.has(k)) exposed.set(k, v);
      }
    }
  }

  // Link
  const linker = new Linker(parsed);
  const { ast: linkedAst, errors: linkErrors, symbols } = linker.link();
  const allErrors = [...allParseErrors, ...allValErrors, ...linkErrors];

  // Filter warnings if needed
  let diagnostics = noWarn ? allErrors.filter(e => e.severity !== 'warning') : allErrors;
  if (warnAsError) diagnostics = diagnostics.map(d =>
    d.severity === 'warning' ? { ...d, severity: 'error' } : d
  );

  const errors   = diagnostics.filter(d => d.severity === 'error');
  const warnings = diagnostics.filter(d => d.severity === 'warning');
  const ok       = errors.length === 0;

  // Don't emit if there are errors
  if (!ok) {
    return {
      ok: false,
      output: null,
      diagnostics: groupByFile(diagnostics),
      summary: { errors: errors.length, warnings: warnings.length },
    };
  }

  // Emit
  let output;
  if (emit === 'wasm') {
    // Generate WAT first, then compile to binary
    const watText = new WatEmitter(linkedAst, symbols, { debug }).emit();
    const { wasm, error } = await BinaryenEmitter.emit(watText, { debug, optimize });
    if (!wasm) {
      // Binaryen not available or failed — return WAT with note
      diagnostics.push({
        code: 'E000', category: 'EmitError', kind: 'BinaryenUnavailable',
        severity: 'error', message: error,
        detail: error, hint: null,
        location: { file: '<emitter>', line: 0, col: 0, endLine: 0, endCol: 0 },
        recovered: false,
      });
      return {
        ok: false,
        output: null,
        diagnostics: groupByFile(diagnostics),
        summary: { errors: errors.length + 1, warnings: warnings.length },
      };
    }
    output = wasm;
  } else {
    output = new WatEmitter(linkedAst, symbols, { debug }).emit();
  }

  return {
    ok: true,
    output,
    diagnostics: groupByFile(diagnostics),
    summary: { errors: 0, warnings: warnings.length },
  };
}

/**
 * Validate WML source(s) without emitting.
 * @param {string|string[]|Source|Source[]|(string|Source)[]} input
 * @param {{ maxErrors?: number, noWarn?: boolean, warnAsError?: boolean }} [options]
 * @returns {Promise<ValidateResult>}
 */
export async function validate(input, options = {}) {
  const { maxErrors = 20, noWarn = false, warnAsError = false } = options;
  const sources = await normalizeSources(input);

  const allErrors = [];
  const exposed   = new Map();

  for (const src of sources) {
    const { ast, errors: parseErrors } = parseSource(src.name, src.content);
    allErrors.push(...parseErrors);
    const { errors: valErrors, symbols } = validateModule(ast, src.name, exposed);
    allErrors.push(...valErrors);
    if (src.expose) {
      const exposeAll = src.expose === '*' || src.expose.includes('*');
      for (const [k, v] of symbols) {
        if (exposeAll || src.expose.includes(k)) exposed.set(k, v);
      }
    }
  }

  let diagnostics = noWarn ? allErrors.filter(e => e.severity !== 'warning') : allErrors;
  if (warnAsError) diagnostics = diagnostics.map(d =>
    d.severity === 'warning' ? { ...d, severity: 'error' } : d
  );

  const errorCount   = diagnostics.filter(d => d.severity === 'error').length;
  const warningCount = diagnostics.filter(d => d.severity === 'warning').length;

  return {
    ok:          errorCount === 0,
    diagnostics: groupByFile(diagnostics),
    summary:     { errors: errorCount, warnings: warningCount },
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Parse a WML source string and return AST + errors.
 * @param {string} name
 * @param {string} content
 * @returns {{ ast: Object, errors: Object[] }}
 */
function parseSource(name, content) {
  const lexer  = new Lexer(content, name);
  const tokens = lexer.tokenize();
  const parser = new Parser(tokens, name);
  const { ast, errors: parseErrors } = parser.parse();
  return { ast, errors: [...lexer.errors, ...parseErrors] };
}

/**
 * Normalize input to an array of Source objects.
 * @param {string|string[]|Source|Source[]|(string|Source)[]} input
 * @returns {Promise<Source[]>}
 */
async function normalizeSources(input) {
  const items = Array.isArray(input) ? input : [input];
  const sources = [];

  for (const item of items) {
    if (typeof item === 'string') {
      // File path
      let content;
      try {
        content = await readFile(item, 'utf8');
      } catch (e) {
        throw new Error(`Cannot read file '${item}': ${e.message}`);
      }
      sources.push({ name: item, content, expose: undefined });
    } else if (item && typeof item === 'object' && 'content' in item) {
      // Source object
      sources.push({ name: item.name ?? 'source', content: item.content, expose: item.expose });
    } else {
      throw new TypeError(`Invalid input item: expected file path or { name, content } object`);
    }
  }

  return sources;
}
