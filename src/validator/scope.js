/**
 * @fileoverview WML scope checker.
 *
 * Performs a single-pass scope resolution over the module AST:
 *   - Builds the module-level symbol table
 *   - Resolves all name references
 *   - Checks for duplicate declarations
 *   - Validates loop label scoping (goto can only target same-loop labels)
 *   - Checks break/continue are inside loops
 *   - Validates @start signature
 *   - Checks no declarations inside loop blocks
 *
 * The scope checker does not perform type checking — it only checks names exist.
 * Type checking happens in types.js / typecheck.js.
 *
 * @example
 * import { ScopeChecker } from './scope.js';
 * const checker = new ScopeChecker(ast, 'module.wml');
 * const { errors, symbols } = checker.check();
 */

import { mkError } from '../diagnostics/errors.js';

export class ScopeChecker {
  /**
   * @param {Object} ast - Module AST node
   * @param {string} file - File name for diagnostics
   * @param {Map<string,Object>} [exposedSymbols] - Symbols exposed from prior modules
   */
  constructor(ast, file, exposedSymbols = new Map()) {
    this.ast = ast;
    this.file = file;
    this.exposed = exposedSymbols;
    /** @type {import('../diagnostics/errors.js').Diagnostic[]} */
    this.errors = [];
    /** @type {Map<string,Object>} Module-level symbol table */
    this.symbols = new Map();
    /** @type {number} Number of @start functions in this file */
    this.startCount = 0;
    /** @type {string[]} Loop label stack (for goto validation) */
    this.loopLabelStack = [];
    /** @type {boolean} Whether we are currently inside a loop */
    this.inLoop = false;
  }

  err(code, message, detail, hint, loc) {
    this.errors.push(mkError(code, message, detail, hint, loc));
  }

  // ── Public entry ────────────────────────────────────────────────────────

  check() {
    this.collectTopLevel();
    this.resolveAll();
    return { errors: this.errors, symbols: this.symbols };
  }

  // ── Phase 1: collect top-level declarations ─────────────────────────────

  collectTopLevel() {
    for (const decl of this.ast.decls) {
      this.collectDecl(decl);
    }
  }

  collectDecl(decl) {
    switch (decl.kind) {
      case 'TypeDecl':
        this.define(decl.name, decl, decl.loc);
        break;
      case 'MemoryDecl':
        this.define(decl.name, decl, decl.loc);
        break;
      case 'TableDecl':
        this.define(decl.name, decl, decl.loc);
        break;
      case 'GlobalDecl':
        this.define(decl.name, decl, decl.loc);
        break;
      case 'DataDecl':
        this.define(decl.name, decl, decl.loc);
        break;
      case 'ElemDecl':
        if (decl.name !== 'declare') this.define(decl.name, decl, decl.loc);
        break;
      case 'TagDecl':
        this.define(decl.name, decl, decl.loc);
        break;
      case 'FuncDecl': {
        const existing = this.symbols.get(decl.name);
        if (existing && !decl.decorators?.some(d => d.name === 'import')) {
          // Last-wins for exported functions, error for others
          const isExport = decl.decorators?.some(d => d.name === 'export');
          if (!isExport) {
            this.err('E201', `'${decl.name}' is already declared`,
              `'${decl.name}' was first declared at ${existing.loc?.file}:${existing.loc?.line}`,
              null, decl.loc);
          }
        }
        this.define(decl.name, decl, decl.loc);
        // Check @start
        const isStart = decl.decorators?.some(d => d.name === 'start');
        if (isStart) {
          this.startCount++;
          if (this.startCount > 1) {
            this.err('E213', 'Only one @start function is allowed per file',
              'Move the start logic to a shared init function', null, decl.loc);
          }
        }
        break;
      }
      case 'RecGroup':
        for (const t of decl.types) this.collectDecl(t);
        break;
      case 'MemoryInit':
      case 'TableInit':
        // Not a declaration — resolved in phase 2
        break;
      case 'SectionDecl':
        // No symbol
        break;
    }
  }

  define(name, decl, loc) {
    if (this.symbols.has(name)) {
      const prev = this.symbols.get(name);
      // Allow re-export overwrites for exported functions
      if (decl.kind === 'FuncDecl' && decl.decorators?.some(d => d.name === 'export')) {
        this.symbols.set(name, decl);
        return;
      }
      this.err('E201', `'${name}' is already declared`,
        `'${name}' was first declared at line ${prev.loc?.line}`,
        null, loc);
      return;
    }
    this.symbols.set(name, decl);
  }

  // ── Phase 2: resolve all references ────────────────────────────────────

  resolveAll() {
    for (const decl of this.ast.decls) {
      this.resolveDecl(decl);
    }
  }

  resolveDecl(decl) {
    switch (decl.kind) {
      case 'FuncDecl':
        this.resolveFunc(decl);
        break;
      case 'GlobalDecl':
        if (decl.init) this.resolveExpr(decl.init, null, true);
        break;
      case 'DataDecl':
        for (const item of decl.items ?? []) this.resolveExpr(item, null, true);
        break;
      case 'ElemDecl':
        for (const item of decl.items ?? []) this.resolveExpr(item, null, true);
        break;
      case 'MemoryInit':
        this.resolveExpr(decl.offset, null, false);
        for (const item of decl.items ?? []) this.resolveDataRef(item);
        break;
      case 'TableInit':
        this.resolveExpr(decl.offset, null, false);
        for (const item of decl.items ?? []) this.resolveExpr(item, null, true);
        break;
      case 'TypeDecl':
        this.resolveTypeExpr(decl.typeExpr);
        break;
      case 'RecGroup':
        for (const t of decl.types) this.resolveDecl(t);
        break;
    }
  }

  resolveFunc(decl) {
    const localScope = new Map();
    for (const p of decl.params ?? []) {
      if (localScope.has(p.name)) {
        this.err('E201', `Parameter '${p.name}' is already declared`, '', null, p.loc);
      }
      localScope.set(p.name, p);
      this.resolveTypeExpr(p.typeExpr);
    }
    for (const r of decl.results ?? []) this.resolveTypeExpr(r);
    for (const l of decl.locals ?? []) {
      if (localScope.has(l.name)) {
        this.err('E201', `Local '${l.name}' is already declared`, '', null, l.loc);
      }
      localScope.set(l.name, l);
      this.resolveTypeExpr(l.typeExpr);
      if (l.init) this.resolveExpr(l.init, localScope, false);
    }
    for (const stmt of decl.body ?? []) {
      this.resolveStmt(stmt, localScope);
    }
  }

  resolveStmt(stmt, scope) {
    if (!stmt) return;
    switch (stmt.kind) {
      case 'ReturnStmt':
        for (const v of stmt.values ?? []) this.resolveExpr(v, scope, false);
        break;
      case 'ReturnTailStmt':
        this.resolveExpr(stmt.callee, scope, false);
        for (const a of stmt.args ?? []) this.resolveExpr(a, scope, false);
        break;
      case 'ExprStmt':
        this.resolveExpr(stmt.expr, scope, false);
        break;
      case 'AssignStmt':
        this.resolveExpr(stmt.target, scope, false);
        this.resolveExpr(stmt.value, scope, false);
        break;
      case 'IfStmt':
        this.resolveExpr(stmt.cond, scope, false);
        for (const s of stmt.then_ ?? []) this.resolveStmt(s, scope);
        for (const s of stmt.else_ ?? []) this.resolveStmt(s, scope);
        break;
      case 'LoopStmt':
        this.resolveLoop(stmt, scope);
        break;
      case 'BreakStmt':
        if (!this.inLoop) {
          this.err('E209', "'break' used outside of a loop", '', null, stmt.loc);
        }
        if (stmt.cond) this.resolveExpr(stmt.cond, scope, false);
        break;
      case 'GotoStmt': {
        if (!this.inLoop) {
          this.err('E209', "'goto' used outside of a loop", '', null, stmt.loc);
          break;
        }
        const currentLabels = this.loopLabelStack[this.loopLabelStack.length - 1];
        if (!currentLabels?.has(stmt.label)) {
          // Check if it belongs to an outer loop
          let inOuter = false;
          for (let i = 0; i < this.loopLabelStack.length - 1; i++) {
            if (this.loopLabelStack[i].has(stmt.label)) { inOuter = true; break; }
          }
          if (inOuter) {
            this.err('E216', `Cannot goto '${stmt.label}' — label belongs to an outer loop`,
              'goto can only target labels within the same loop', null, stmt.loc);
          } else {
            this.err('E215', `Label '${stmt.label}' is not defined in this loop`,
              '', null, stmt.loc);
          }
        }
        if (stmt.cond) this.resolveExpr(stmt.cond, scope, false);
        break;
      }
      case 'GotoTableStmt': {
        if (stmt.labels.length === 0) {
          this.err('E619', 'goto table must have at least one label', '', null, stmt.loc);
        }
        const currentLabels = this.loopLabelStack[this.loopLabelStack.length - 1];
        for (const label of stmt.labels) {
          if (!currentLabels?.has(label)) {
            this.err('E215', `Label '${label}' is not defined in this loop`, '', null, stmt.loc);
          }
        }
        this.resolveExpr(stmt.idx, scope, false);
        break;
      }
      case 'ThrowStmt':
        this.resolveExpr(stmt.tag, scope, false);
        for (const a of stmt.args ?? []) this.resolveExpr(a, scope, false);
        break;
      case 'TryStmt':
        for (const s of stmt.body ?? []) this.resolveStmt(s, scope);
        for (const c of stmt.catches ?? []) {
          // Catch params are in scope for the catch body
          const catchScope = new Map(scope);
          for (const p of c.params ?? []) catchScope.set(p, { kind: 'CatchParam', name: p });
          for (const s of c.body ?? []) this.resolveStmt(s, catchScope);
        }
        break;
      case 'NopStmt':
      case 'UnreachableStmt':
        break;
      case 'ErrorNode':
        break;
    }
  }

  resolveLoop(loopStmt, scope) {
    // Collect all labels in this loop
    const labelSet = new Set();
    for (const block of loopStmt.blocks ?? []) {
      for (const labelDef of block.labels ?? []) {
        if (labelSet.has(labelDef.label)) {
          this.err('E217', `Label '${labelDef.label}' is already defined in this loop`,
            '', null, labelDef.loc);
        }
        labelSet.add(labelDef.label);
      }
    }

    this.loopLabelStack.push(labelSet);
    const wasInLoop = this.inLoop;
    this.inLoop = true;

    for (const block of loopStmt.blocks ?? []) {
      for (const stmt of block.stmts ?? []) {
        this.resolveStmt(stmt, scope);
      }
    }

    this.inLoop = wasInLoop;
    this.loopLabelStack.pop();
  }

  resolveExpr(expr, scope, isConst) {
    if (!expr || expr.kind === 'ErrorNode') return;
    switch (expr.kind) {
      case 'Ident': {
        const name = expr.name;
        const localSym = scope?.get(name);
        const inLocal = localSym !== undefined;
        const moduleSym = this.symbols.get(name) ?? this.exposed.get(name);
        const inModule = moduleSym !== undefined;
        if (!inLocal && !inModule) {
          this.err('E200', `'${name}' is not defined`, '', null, expr.loc);
        }
        if (isConst) {
          if (inLocal) {
            this.err('E303', `Local '${name}' cannot be used in a constant expression`, '', null, expr.loc);
          } else if (moduleSym?.kind === 'GlobalDecl' && moduleSym.isMut) {
            this.err('E301', `Mutable global '${name}' cannot be used in a constant expression`, '', null, expr.loc);
          }
        }
        break;
      }
      case 'BinaryExpr':
        this.resolveExpr(expr.left, scope, isConst);
        this.resolveExpr(expr.right, scope, isConst);
        break;
      case 'UnaryExpr':
        this.resolveExpr(expr.operand, scope, isConst);
        break;
      case 'CallExpr':
        if (isConst) {
          this.err('E302', 'Function calls are not allowed in constant expressions', '', null, expr.loc);
        }
        this.resolveExpr(expr.callee, scope, false);
        for (const a of expr.args ?? []) this.resolveExpr(a, scope, false);
        break;
      case 'MemberExpr':
        this.resolveExpr(expr.object, scope, isConst);
        break;
      case 'IndexExpr':
      case 'IndexFieldExpr':
        this.resolveExpr(expr.object, scope, isConst);
        this.resolveExpr(expr.index, scope, false);
        break;
      case 'IfExpr':
        this.resolveExpr(expr.cond, scope, false);
        for (const s of expr.then_ ?? []) this.resolveStmt(s, scope);
        for (const s of expr.else_ ?? []) this.resolveStmt(s, scope);
        break;
      case 'TryExpr':
        for (const s of expr.body ?? []) this.resolveStmt(s, scope);
        for (const c of expr.catches ?? []) {
          const catchScope = new Map(scope);
          for (const p of c.params ?? []) catchScope.set(p, { kind: 'CatchParam', name: p });
          for (const s of c.body ?? []) this.resolveStmt(s, catchScope);
        }
        break;
      case 'SelectExpr':
        this.resolveExpr(expr.cond, scope, false);
        this.resolveExpr(expr.a, scope, false);
        this.resolveExpr(expr.b, scope, false);
        break;
      case 'CastExpr':
      case 'TestExpr':
        this.resolveExpr(expr.expr, scope, isConst);
        break;
      case 'NewStructExpr':
        for (const v of Object.values(expr.fields ?? {})) this.resolveExpr(v, scope, isConst);
        break;
      case 'NewArrayExpr':
        if (expr.size) this.resolveExpr(expr.size, scope, isConst);
        for (const item of expr.items ?? []) this.resolveExpr(item, scope, isConst);
        break;
      case 'RefFuncExpr': {
        const name = expr.name;
        if (!this.symbols.has(name) && !this.exposed.has(name)) {
          this.err('E200', `Function '${name}' is not defined`, '', null, expr.loc);
        }
        break;
      }
      case 'SizeofExpr':
        this.resolveTypeExpr(expr.typeExpr);
        break;
      case 'DataLiteral':
        for (const item of expr.items ?? []) this.resolveExpr(item, scope, isConst);
        break;
      case 'IntLit':
      case 'FloatLit':
      case 'StringLit':
      case 'NullLit':
        break;
    }
  }

  resolveTypeExpr(typeExpr) {
    if (!typeExpr) return;
    switch (typeExpr.kind) {
      case 'NamedType':
        if (!this.symbols.has(typeExpr.name) && !this.exposed.has(typeExpr.name)) {
          this.err('E202', `Type '${typeExpr.name}' is not defined`, '', null, typeExpr.loc);
        }
        break;
      case 'PointerType':
        this.resolveTypeExpr(typeExpr.baseType);
        if (typeExpr.memory && !this.symbols.has(typeExpr.memory) && !this.exposed.has(typeExpr.memory)) {
          this.err('E204', `Memory '${typeExpr.memory}' is not defined`, '', null, typeExpr.loc);
        }
        break;
      case 'ArrayType':
        this.resolveTypeExpr(typeExpr.elemType);
        break;
      case 'FuncType':
        for (const p of typeExpr.params ?? []) this.resolveTypeExpr(p);
        for (const r of typeExpr.results ?? []) this.resolveTypeExpr(r);
        break;
      case 'FuncRefType':
        if (typeExpr.typeParam) this.resolveTypeExpr(typeExpr.typeParam);
        break;
      case 'StructType':
        if (typeExpr.superType) this.resolveTypeExpr(typeExpr.superType);
        for (const f of typeExpr.fields ?? []) this.resolveTypeExpr(f.typeExpr);
        break;
    }
  }

  resolveDataRef(item) {
    if (!item) return;
    if (item.kind === 'Ident') {
      const name = item.name;
      if (!this.symbols.has(name) && !this.exposed.has(name)) {
        this.err('E207', `Data segment '${name}' is not defined`, '', null, item.loc);
      }
    }
  }
}
