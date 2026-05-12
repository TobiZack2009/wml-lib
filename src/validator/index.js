/**
 * @fileoverview WML validator pipeline.
 *
 * Runs all validation phases in order:
 *   1. Scope checking (resolves names, checks scoping rules)
 *   2. Type checking (checks type compatibility)
 *   3. Const expression validation (validates global/elem/data initializers)
 *   4. Memory validation (validates data placement)
 *   5. Link validation (validates imports/exports)
 *
 * Phases 2–5 run even if earlier phases found errors, collecting all
 * diagnostics before reporting. Only syntax errors (from the parser) halt
 * early — if the AST is malformed, scope checking cannot proceed.
 *
 * @example
 * import { validate } from './index.js';
 * const result = validate(ast, 'module.wml');
 * // result.errors: Diagnostic[]
 */

import { ScopeChecker } from './scope.js';
import { TypeChecker } from './typecheck.js';
import { mkError, mkWarning } from '../diagnostics/errors.js';

/**
 * Run all validation phases on a module AST.
 * @param {Object} ast - Module AST
 * @param {string} file - File name for diagnostics
 * @param {Map<string,Object>} [exposedSymbols] - Symbols exposed from linked modules
 * @returns {{ errors: import('../diagnostics/errors.js').Diagnostic[], symbols: Map<string,Object> }}
 */
export function validateModule(ast, file, exposedSymbols = new Map()) {
  const allErrors = [];

  // Phase 1: Scope checking
  const scope = new ScopeChecker(ast, file, exposedSymbols);
  const { errors: scopeErrors, symbols } = scope.check();
  allErrors.push(...scopeErrors);

  // Phase 2: Type checking (runs even with scope errors, uses error type for unknowns)
  const typeChecker = new TypeChecker(ast, symbols, file, exposedSymbols);
  const { errors: typeErrors } = typeChecker.check();
  allErrors.push(...typeErrors);

  // Phase 3: Memory validation
  const memErrors = validateMemory(ast, symbols, file);
  allErrors.push(...memErrors);

  // Phase 4: Link validation
  const linkErrors = validateLinks(ast, symbols, file);
  allErrors.push(...linkErrors);

  return { errors: allErrors, symbols };
}

/**
 * Validate memory placement and data segments.
 * @param {Object} ast
 * @param {Map<string,Object>} symbols
 * @param {string} file
 * @returns {import('../diagnostics/errors.js').Diagnostic[]}
 */
function validateMemory(ast, symbols, file) {
  const errors = [];
  const memories = [...symbols.values()].filter(s => s.kind === 'MemoryDecl');
  const multipleMemories = memories.length > 1;

  for (const decl of ast.decls) {
    if (decl.kind === 'MemoryDecl') {
      // Validate min/max
      if (decl.max !== null && decl.max < decl.min) {
        errors.push(mkError('E404',
          `Memory '${decl.name}' max (${decl.max}) must be >= min (${decl.min})`,
          '', null, decl.loc));
      }
    }

    if (decl.kind === 'DataDecl') {
      // Validate pascal strings: check both explicit strType and data type annotation
      const isPascalType = decl.dataType?.strType === 'pascal';
      for (const item of decl.items ?? []) {
        const isPascalItem = item.strType === 'pascal' || (isPascalType && item.kind === 'StringLit');
        if (isPascalItem && item.kind === 'StringLit') {
          if (item.value.length > 255) {
            errors.push(mkError('E403',
              `Pascal string exceeds 255 characters (${item.value.length} chars)`,
              '', null, item.loc));
          }
        }
      }
    }

    if (decl.kind === 'MemoryInit') {
      // Validate memory exists
      if (!symbols.has(decl.memory)) {
        errors.push(mkError('E204', `Memory '${decl.memory}' is not defined`, '', null, decl.loc));
      }
      // Validate data items
      for (const item of decl.items ?? []) {
        if (item.kind === 'StringLit' && item.strType === 'pascal') {
          if (item.value.length > 255) {
            errors.push(mkError('E403',
              `Pascal string exceeds 255 characters (${item.value.length} chars)`,
              '', null, item.loc));
          }
        }
        // Validate named segment references
        if (item.kind === 'Ident') {
          const seg = symbols.get(item.name);
          const container = symbols.get(decl.memory);
          const isTable = container?.kind === 'TableDecl';
          if (seg && !isTable && seg.kind !== 'DataDecl') {
            errors.push(mkError('E402', `'${item.name}' is not a data segment`, '', null, item.loc));
          }
          if (seg && isTable && seg.kind !== 'ElemDecl') {
            errors.push(mkError('E402', `'${item.name}' is not an element segment`, '', null, item.loc));
          }
        }
      }
    }

    // Check for ambiguous bare memory access with multiple memories
    if (multipleMemories && decl.kind === 'FuncDecl') {
      checkBareMemoryAccess(decl, errors, file);
    }
  }

  // Warn: unused data segments
  checkUnusedSegments(ast, symbols, errors);

  return errors;
}

/**
 * Check for bare load/store calls when multiple memories exist.
 * @param {Object} funcDecl
 * @param {*[]} errors
 * @param {string} file
 */
function checkBareMemoryAccess(funcDecl, errors, file) {
  // Walk the function body looking for bare 'load' or 'store' ident calls
  walkExprs(funcDecl.body, (expr) => {
    if (expr.kind === 'CallExpr' && expr.callee.kind === 'Ident') {
      if (expr.callee.name === 'load' || expr.callee.name === 'store') {
        errors.push(mkError('E407',
          `Ambiguous '${expr.callee.name}' — multiple memories defined`,
          '', 'Use MemoryName.load/store when multiple memories are defined',
          expr.loc));
      }
    }
  });
}

/**
 * Validate imports and exports.
 * @param {Object} ast
 * @param {Map<string,Object>} symbols
 * @param {string} file
 * @returns {import('../diagnostics/errors.js').Diagnostic[]}
 */
function validateLinks(ast, symbols, file) {
  const errors = [];
  const exportNames = new Set();

  for (const decl of ast.decls) {
    const decorators = decl.decorators ?? [];
    const isExport = decorators.some(d => d.name === 'export');
    const isImport = decorators.some(d => d.name === 'import');

    if (isExport) {
      const exportName = decl.name;
      if (exportNames.has(exportName)) {
        errors.push(mkError('E500', `Name '${exportName}' is exported more than once`,
          '', null, decl.loc));
      }
      exportNames.add(exportName);
    }

    if (isImport && decl.kind === 'FuncDecl') {
      // Import must not have a body
      if (decl.body?.length > 0) {
        errors.push(mkError('E501',
          `Imported function '${decl.name}' must not have a body`,
          '', null, decl.loc));
      }
    }

    // Validate @start function signature
    if (decl.kind === 'FuncDecl' && decorators.some(d => d.name === 'start')) {
      if (decl.params?.length > 0 || decl.results?.length > 0) {
        errors.push(mkError('E504',
          `@start function '${decl.name}' must take no parameters and return ()`,
          '', null, decl.loc));
      }
    }

    // Validate tag param types are value types (not data layout types)
    if (decl.kind === 'TagDecl') {
      const dataLayoutTypes = new Set(['cstr','utf8_32','utf8_64','pascal']);
      for (const param of decl.params ?? []) {
        if (param.kind === 'PrimitiveType' && dataLayoutTypes.has(param.name)) {
          errors.push(mkError('E505',
            `Tag '${decl.name}' parameter type '${param.name}' is not a value type`,
            '', null, decl.loc));
        }
      }
    }
  }

  return errors;
}

/**
 * Check for unused data/elem segments and emit warnings.
 * @param {Object} ast
 * @param {Map<string,Object>} symbols
 * @param {*[]} errors
 */
function checkUnusedSegments(ast, symbols, errors) {
  const placedData = new Set();
  const usedElem   = new Set();

  for (const decl of ast.decls) {
    if (decl.kind === 'MemoryInit') {
      for (const item of decl.items ?? []) {
        if (item.kind === 'Ident') placedData.add(item.name);
      }
    }
    if (decl.kind === 'TableInit') {
      for (const item of decl.items ?? []) {
        if (item.kind === 'Ident') usedElem.add(item.name);
      }
    }
  }

  for (const [name, sym] of symbols) {
    if (sym.kind === 'DataDecl' && !placedData.has(name)) {
      errors.push(mkWarning('W001',
        `Data segment '${name}' is declared but never placed into memory`,
        '', null, sym.loc));
    }
    if (sym.kind === 'ElemDecl' && !usedElem.has(name) && name !== 'declare') {
      errors.push(mkWarning('W002',
        `Element segment '${name}' is declared but never used`,
        '', null, sym.loc));
    }
  }
}

/**
 * Walk all expressions in a statement list, calling visitor for each expr.
 * @param {Object[]} stmts
 * @param {(expr: Object) => void} visitor
 */
function walkExprs(stmts, visitor) {
  if (!stmts) return;
  for (const stmt of stmts) {
    walkStmtExprs(stmt, visitor);
  }
}

function walkStmtExprs(stmt, visitor) {
  if (!stmt) return;
  switch (stmt.kind) {
    case 'ExprStmt':      visitor(stmt.expr); walkExprExprs(stmt.expr, visitor); break;
    case 'AssignStmt':    walkExprExprs(stmt.target, visitor); walkExprExprs(stmt.value, visitor); break;
    case 'ReturnStmt':    for (const v of stmt.values ?? []) walkExprExprs(v, visitor); break;
    case 'IfStmt':
      walkExprExprs(stmt.cond, visitor);
      walkExprs(stmt.then_, visitor);
      walkExprs(stmt.else_, visitor);
      break;
    case 'LoopStmt':
      for (const b of stmt.blocks ?? []) walkExprs(b.stmts, visitor);
      break;
    case 'TryStmt':
      walkExprs(stmt.body, visitor);
      for (const c of stmt.catches ?? []) walkExprs(c.body, visitor);
      break;
  }
}

function walkExprExprs(expr, visitor) {
  if (!expr) return;
  visitor(expr);
  switch (expr.kind) {
    case 'BinaryExpr':   walkExprExprs(expr.left, visitor); walkExprExprs(expr.right, visitor); break;
    case 'UnaryExpr':    walkExprExprs(expr.operand, visitor); break;
    case 'CallExpr':
      walkExprExprs(expr.callee, visitor);
      for (const a of expr.args ?? []) walkExprExprs(a, visitor);
      break;
    case 'MemberExpr':   walkExprExprs(expr.object, visitor); break;
    case 'IndexExpr':    walkExprExprs(expr.object, visitor); walkExprExprs(expr.index, visitor); break;
    case 'SelectExpr':
      walkExprExprs(expr.cond, visitor);
      walkExprExprs(expr.a, visitor);
      walkExprExprs(expr.b, visitor);
      break;
  }
}
