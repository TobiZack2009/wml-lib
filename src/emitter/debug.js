/**
 * @fileoverview WML debug info emitter.
 *
 * Generates:
 *   - Source map JSON (maps WAT instructions back to WML source locations)
 *   - Name section data (function/local/type names for WASM devtools)
 *
 * The name section is embedded in the WASM binary by the Binaryen emitter
 * when --debug is set. Source maps are written as a sidecar .wasm.map file.
 *
 * @example
 * import { DebugEmitter } from './debug.js';
 * const names = DebugEmitter.buildNameSection(ast, symbols);
 * const map   = DebugEmitter.buildSourceMap(ast, symbols, 'module.wml', 'module.wasm');
 */

export class DebugEmitter {
  /**
   * Build a name section descriptor for Binaryen.
   * Returns an object that maps index → name for each section type.
   * @param {Object} ast
   * @param {Map<string,Object>} symbols
   * @returns {{ functions: Map<number,string>, locals: Map<number,Map<number,string>>, types: Map<number,string> }}
   */
  static buildNameSection(ast, symbols) {
    const functions = new Map();
    const locals    = new Map();
    const types     = new Map();

    let funcIdx = 0;
    let typeIdx = 0;

    for (const decl of ast.decls) {
      if (decl.kind === 'FuncDecl') {
        functions.set(funcIdx, decl.name);
        const localMap = new Map();
        let localIdx = 0;
        for (const p of decl.params ?? []) {
          localMap.set(localIdx++, p.name);
        }
        for (const l of decl.locals ?? []) {
          localMap.set(localIdx++, l.name);
        }
        locals.set(funcIdx, localMap);
        funcIdx++;
      }
      if (decl.kind === 'TypeDecl') {
        types.set(typeIdx++, decl.name);
      }
    }

    return { functions, locals, types };
  }

  /**
   * Build a V3 source map that maps WASM bytecode offsets to WML source positions.
   * This is a best-effort mapping based on the AST location data.
   *
   * @param {Object} ast
   * @param {Map<string,Object>} symbols
   * @param {string} sourceFile - WML source file path
   * @param {string} outputFile - Output .wasm file path
   * @returns {string} JSON source map
   */
  static buildSourceMap(ast, symbols, sourceFile, outputFile) {
    const mappings = [];

    // Collect all source locations from functions
    for (const decl of ast.decls) {
      if (decl.kind === 'FuncDecl') {
        for (const stmt of decl.body ?? []) {
          if (stmt.loc) {
            mappings.push({
              generatedLine:   0, // offset assigned at link time
              generatedColumn: 0,
              sourceLine:      stmt.loc.line - 1,
              sourceColumn:    stmt.loc.col - 1,
              name:            decl.name,
            });
          }
        }
      }
    }

    const map = {
      version: 3,
      file:    outputFile,
      sources: [sourceFile],
      sourceRoot: '',
      names:   [...symbols.keys()],
      mappings: encodeVLQ(mappings),
    };

    return JSON.stringify(map, null, 2);
  }
}

/**
 * Minimal VLQ encoding for source maps.
 * Only encodes the first mapping per statement (sufficient for debugger support).
 * @param {{ generatedLine, generatedColumn, sourceLine, sourceColumn }[]} mappings
 * @returns {string}
 */
function encodeVLQ(mappings) {
  if (mappings.length === 0) return '';

  const VLQ_BASE_SHIFT = 5;
  const VLQ_BASE       = 1 << VLQ_BASE_SHIFT;
  const VLQ_BASE_MASK  = VLQ_BASE - 1;
  const VLQ_CONTINUATION_BIT = VLQ_BASE;
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

  function encodeSingle(value) {
    let vlq = value < 0 ? ((-value) << 1) | 1 : value << 1;
    let result = '';
    do {
      let digit = vlq & VLQ_BASE_MASK;
      vlq >>>= VLQ_BASE_SHIFT;
      if (vlq > 0) digit |= VLQ_CONTINUATION_BIT;
      result += B64[digit];
    } while (vlq > 0);
    return result;
  }

  let prevGenCol  = 0;
  let prevSrcLine = 0;
  let prevSrcCol  = 0;
  let prevName    = 0;
  let result      = '';

  for (let i = 0; i < mappings.length; i++) {
    const m = mappings[i];
    if (i > 0) result += ',';
    result += encodeSingle(m.generatedColumn - prevGenCol);
    result += encodeSingle(0); // source index always 0
    result += encodeSingle(m.sourceLine - prevSrcLine);
    result += encodeSingle(m.sourceColumn - prevSrcCol);
    prevGenCol  = m.generatedColumn;
    prevSrcLine = m.sourceLine;
    prevSrcCol  = m.sourceColumn;
  }

  return result;
}
