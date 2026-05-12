/**
 * @fileoverview WML multi-file linker.
 *
 * The linker merges multiple parsed, validated WML modules into a single
 * coherent module AST that can be passed to the emitter.
 *
 * Linking rules:
 *   - Declarations from all files are merged into one declaration list
 *   - Non-exported symbols with duplicate names are an error (E201)
 *   - Exported functions: last definition wins (enables override pattern)
 *   - @import declarations with the same (module, name, signature) are deduplicated
 *   - @import declarations with the same name but conflicting signatures are E506
 *   - Multiple @start functions across files are merged into a synthetic __start()
 *     that calls each in declaration order
 *   - expose: ["*"] makes all symbols from that file available to subsequent files
 *   - expose: ["name1", "name2"] makes only named symbols available
 *
 * @example
 * import { Linker } from './linker.js';
 * const { ast, errors, symbols } = new Linker(sources).link();
 * // sources: { name, content, ast, symbols, expose }[]
 */

import * as AST from './parser/ast.js';
import { mkError } from './diagnostics/errors.js';

export class Linker {
  /**
   * @param {{ name: string, ast: Object, symbols: Map<string,Object>, expose?: string[]|['*'] }[]} sources
   */
  constructor(sources) {
    this.sources = sources;
    /** @type {import('./diagnostics/errors.js').Diagnostic[]} */
    this.errors  = [];
  }

  /**
   * Link all sources into a single module.
   * @returns {{ ast: Object, errors: Object[], symbols: Map<string,Object> }}
   */
  link() {
    const allDecls  = [];
    const merged    = new Map();  // name → decl (final merged symbol table)
    const startFuncs = [];        // @start function names, in order
    const importSigs = new Map(); // importKey → { mod, name, sig, loc }

    // Exposed symbols accumulate across files (earlier files expose to later ones)
    const exposed = new Map();

    for (const src of this.sources) {
      // Determine what this source exposes to subsequent sources
      const exposeAll   = src.expose?.includes?.('*') || src.expose === '*';
      const exposeNames = Array.isArray(src.expose) && !exposeAll ? new Set(src.expose) : null;

      for (const decl of src.ast.decls ?? []) {
        const decorators = decl.decorators ?? [];
        let isExport = false, isImport = null, isStart = false;
        for (const d of decorators) {
          if (d.name === 'export') isExport = true;
          else if (d.name === 'import') isImport = d;
          else if (d.name === 'start') isStart = true;
        }
        const name = decl.name;

        // Handle @start collection
        if (isStart && decl.kind === 'FuncDecl') {
          startFuncs.push(decl.name);
        }

        // Deduplicate @import declarations
        if (isImport && decl.kind === 'FuncDecl') {
          const key = `${isImport.args[0]}::${isImport.args[1]}`;
          const existing = importSigs.get(key);
          if (existing) {
            const newSig = funcSig(decl);
            if (existing.sig !== newSig) {
              this.errors.push(mkError('E506',
                `Import '${isImport.args[0]}' / '${isImport.args[1]}' has conflicting signatures`,
                `First: ${existing.sig}, New: ${newSig}`,
                null, decl.loc));
            }
            // Deduplicate: skip adding again
            continue;
          }
          importSigs.set(key, { mod: isImport.args[0], name: isImport.args[1], sig: funcSig(decl), loc: decl.loc });
        }

        // Exported last-wins: replace existing
        if (name && isExport) {
          merged.set(name, decl);
          allDecls.push(decl);
          continue;
        }

        // Non-exported duplicates are errors
        if (name && merged.has(name) && !isImport) {
          const prev = merged.get(name);
          this.errors.push(mkError('E201',
            `'${name}' is already declared`,
            `Previously declared in ${prev.loc?.file}:${prev.loc?.line}`,
            null, decl.loc));
        }

        if (name) merged.set(name, decl);
        allDecls.push(decl);
      }

      // Build exposed map for subsequent files
      if (exposeAll) {
        for (const [k, v] of src.symbols) exposed.set(k, v);
      } else if (exposeNames) {
        for (const k of exposeNames) {
          const v = src.symbols.get(k);
          if (v) exposed.set(k, v);
          else {
            this.errors.push(mkError('E200',
              `Cannot expose '${k}' — symbol not found in ${src.name}`,
              '', null, { file: src.name, line: 1, col: 1, endLine: 1, endCol: 1 }));
          }
        }
      }
    }

    // Synthesize __start if multiple @start functions
    if (startFuncs.length > 1) {
      const startDecl = this.buildSyntheticStart(startFuncs);
      allDecls.push(startDecl);
      merged.set('__start', startDecl);
    }

    const fakeStart = this.sources[0]?.ast?.decls?.[0]?.loc ??
      { file: 'linked', line: 1, col: 1, endLine: 1, endCol: 1 };
    const linkedAst = AST.module_(allDecls, fakeStart);

    return { ast: linkedAst, errors: this.errors, symbols: merged };
  }

  /**
   * Build a synthetic __start function that calls all @start functions in order.
   * @param {string[]} names
   * @returns {Object} FuncDecl AST node
   */
  buildSyntheticStart(names) {
    const loc = { file: '<linker>', line: 0, col: 0, endLine: 0, endCol: 0 };
    const body = names.map(n =>
      AST.exprStmt(
        AST.callExpr(AST.ident(n, loc), [], null, loc),
        loc
      )
    );
    return AST.funcDecl(
      '__start',
      [], [], null, [], body,
      [{ kind: 'Decorator', name: 'start', args: [], loc }],
      loc
    );
  }
}

/**
 * Compute a simple signature string for a FuncDecl (for import dedup).
 * @param {Object} decl
 * @returns {string}
 */
function funcSig(decl) {
  const params  = (decl.params  ?? []).map(p => p.typeExpr?.name ?? '?').join(',');
  const results = (decl.results ?? []).map(r => r.name ?? '?').join(',');
  return `(${params})->(${results})`;
}
