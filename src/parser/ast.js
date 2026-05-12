/**
 * @fileoverview AST node constructors for WML.
 *
 * Every node has:
 *   - kind: string identifying the node type
 *   - loc: { file, line, col, endLine, endCol } source location
 *
 * Nodes are plain objects for easy serialization and inspection.
 *
 * @example
 * import * as AST from './ast.js';
 * const node = AST.module(decls, 'source.wml');
 */

/**
 * @typedef {{ file: string, line: number, col: number, endLine: number, endCol: number }} Loc
 */

/**
 * Create a source location object from a token.
 * @param {import('./lexer.js').Token} tok
 * @returns {Loc}
 */
export function locFrom(tok) {
  return { file: tok.file, line: tok.line, col: tok.col, endLine: tok.line, endCol: tok.col + (tok.value?.length ?? 1) };
}

/**
 * Merge two locations into a span.
 * @param {Loc} start
 * @param {Loc} end
 * @returns {Loc}
 */
export function span(start, end) {
  return { file: start.file, line: start.line, col: start.col, endLine: end.endLine, endCol: end.endCol };
}

// ── Module ──────────────────────────────────────────────────────────────────

/** @param {Object[]} decls @param {Loc} loc */
export const module_ = (decls, loc) => ({ kind: 'Module', decls, loc });

// ── Type declarations ───────────────────────────────────────────────────────

/** @param {string} name @param {Object} typeExpr @param {Loc} loc */
export const typeDecl = (name, typeExpr, loc) => ({ kind: 'TypeDecl', name, typeExpr, loc });

/** @param {Object[]} fields @param {Object|null} superType @param {boolean} isFinal @param {Object[]} pragmas @param {Loc} loc */
export const structType = (fields, superType, isFinal, pragmas, loc) =>
  ({ kind: 'StructType', fields, superType, isFinal, pragmas, loc });

/** @param {string} name @param {Object} typeExpr @param {boolean} isMut @param {Loc} loc */
export const structField = (name, typeExpr, isMut, loc) =>
  ({ kind: 'StructField', name, typeExpr, isMut, loc });

/** @param {Object} elemType @param {boolean} isMut @param {Loc} loc */
export const arrayType = (elemType, isMut, loc) => ({ kind: 'ArrayType', elemType, isMut, loc });

/** @param {Object[]} params @param {Object[]} results @param {Loc} loc */
export const funcType = (params, results, loc) => ({ kind: 'FuncType', params, results, loc });

/** @param {Object[]} types @param {Loc} loc */
export const recGroup = (types, loc) => ({ kind: 'RecGroup', types, loc });

// ── Primitive types ─────────────────────────────────────────────────────────

/** @param {string} name @param {Loc} loc */
export const primitiveType = (name, loc) => ({ kind: 'PrimitiveType', name, loc });

/** @param {string} name @param {Loc} loc */
export const refType = (name, loc) => ({ kind: 'RefType', name, loc });

/** @param {Object|null} typeParam @param {Loc} loc */
export const funcRefType = (typeParam, loc) => ({ kind: 'FuncRefType', typeParam, loc });

/** @param {string} name @param {Loc} loc */
export const namedType = (name, loc) => ({ kind: 'NamedType', name, loc });

/** @param {Object} baseType @param {string|null} memory @param {Loc} loc */
export const pointerType = (baseType, memory, loc) => ({ kind: 'PointerType', baseType, memory, loc });

// ── Memory, table, global ───────────────────────────────────────────────────

/** @param {string} name @param {number} min @param {number|null} max @param {boolean} isShared @param {Object[]} decorators @param {Loc} loc */
export const memoryDecl = (name, min, max, isShared, decorators, loc) =>
  ({ kind: 'MemoryDecl', name, min, max, isShared, decorators, loc });

/** @param {string} name @param {Object} elemType @param {number} min @param {number|null} max @param {boolean} isShared @param {Object[]} decorators @param {Loc} loc */
export const tableDecl = (name, elemType, min, max, isShared, decorators, loc) =>
  ({ kind: 'TableDecl', name, elemType, min, max, isShared, decorators, loc });

/** @param {string} name @param {Object} typeExpr @param {Object|null} init @param {boolean} isMut @param {Object[]} decorators @param {Loc} loc */
export const globalDecl = (name, typeExpr, init, isMut, decorators, loc) =>
  ({ kind: 'GlobalDecl', name, typeExpr, init, isMut, decorators, loc });

// ── Data and element segments ───────────────────────────────────────────────

/** @param {string} name @param {Object|null} dataType @param {Object[]} items @param {Loc} loc */
export const dataDecl = (name, dataType, items, loc) =>
  ({ kind: 'DataDecl', name, dataType, items, loc });

/** @param {string} name @param {Object|null} elemType @param {Object[]} items @param {boolean} isDeclare @param {Loc} loc */
export const elemDecl = (name, elemType, items, isDeclare, loc) =>
  ({ kind: 'ElemDecl', name, elemType, items, isDeclare, loc });

/** @param {string} memory @param {Object} offset @param {Object[]} items @param {Loc} loc */
export const memoryInit = (memory, offset, items, loc) =>
  ({ kind: 'MemoryInit', memory, offset, items, loc });

/** @param {string} table @param {Object} offset @param {Object[]} items @param {Loc} loc */
export const tableInit = (table, offset, items, loc) =>
  ({ kind: 'TableInit', table, offset, items, loc });

// ── Tag ─────────────────────────────────────────────────────────────────────

/** @param {string} name @param {Object[]} params @param {Object[]} decorators @param {Loc} loc */
export const tagDecl = (name, params, decorators, loc) =>
  ({ kind: 'TagDecl', name, params, decorators, loc });

// ── Functions ───────────────────────────────────────────────────────────────

/** @param {string} name @param {Object[]} params @param {Object[]} results @param {Object|null} typeRef @param {Object[]} locals @param {Object[]} body @param {Object[]} decorators @param {Loc} loc */
export const funcDecl = (name, params, results, typeRef, locals, body, decorators, loc) =>
  ({ kind: 'FuncDecl', name, params, results, typeRef, locals, body, decorators, loc });

/** @param {string} name @param {Object} typeExpr @param {Loc} loc */
export const param = (name, typeExpr, loc) => ({ kind: 'Param', name, typeExpr, loc });

/** @param {string} name @param {Object} typeExpr @param {Object|null} init @param {Loc} loc */
export const localDecl = (name, typeExpr, init, loc) =>
  ({ kind: 'LocalDecl', name, typeExpr, init, loc });

// ── Statements ──────────────────────────────────────────────────────────────

/** @param {Object} expr @param {Loc} loc */
export const exprStmt = (expr, loc) => ({ kind: 'ExprStmt', expr, loc });

/** @param {Object} target @param {Object} value @param {string} op @param {Loc} loc */
export const assignStmt = (target, value, op, loc) => ({ kind: 'AssignStmt', target, value, op, loc });

/** @param {Object[]} values @param {Loc} loc */
export const returnStmt = (values, loc) => ({ kind: 'ReturnStmt', values, loc });

/** @param {boolean} isTail @param {Object} callee @param {Object[]} args @param {Loc} loc */
export const returnTailStmt = (callee, args, loc) => ({ kind: 'ReturnTailStmt', callee, args, loc });

/** @param {Loc} loc */
export const unreachableStmt = (loc) => ({ kind: 'UnreachableStmt', loc });

/** @param {Loc} loc */
export const nopStmt = (loc) => ({ kind: 'NopStmt', loc });

/** @param {Object} tag @param {Object[]} args @param {Loc} loc */
export const throwStmt = (tag, args, loc) => ({ kind: 'ThrowStmt', tag, args, loc });

/** @param {Object[]} blocks @param {Loc} loc */
export const loopStmt = (blocks, loc) => ({ kind: 'LoopStmt', blocks, loc });

/** @param {string[]} labels @param {Object[]} stmts @param {Loc} loc */
export const loopBlock = (labels, stmts, loc) => ({ kind: 'LoopBlock', labels, stmts, loc });

/** @param {string} label @param {Object|null} cond @param {Loc} loc */
export const gotoStmt = (label, cond, loc) => ({ kind: 'GotoStmt', label, cond, loc });

/** @param {string[]} labels @param {Object} idx @param {Loc} loc */
export const gotoTableStmt = (labels, idx, loc) => ({ kind: 'GotoTableStmt', labels, idx, loc });

/** @param {Object|null} cond @param {Loc} loc */
export const breakStmt = (cond, loc) => ({ kind: 'BreakStmt', cond, loc });

/** @param {Object} cond @param {Object[]} then_ @param {Object[]|null} else_ @param {Loc} loc */
export const ifStmt = (cond, then_, else_, loc) => ({ kind: 'IfStmt', cond, then_, else_, loc });

/** @param {Object[]} body @param {Object[]} catches @param {Loc} loc */
export const tryStmt = (body, catches, loc) => ({ kind: 'TryStmt', body, catches, loc });

/** @param {string|null} tag @param {string[]} params @param {Object[]|null} body @param {Object|null} route @param {Loc} loc */
export const catchClause = (tag, params, body, route, loc) =>
  ({ kind: 'CatchClause', tag, params, body, route, loc });

// ── Expressions ─────────────────────────────────────────────────────────────

/** @param {string|number|bigint} value @param {string} numType @param {Loc} loc */
export const intLit = (value, numType, loc) => ({ kind: 'IntLit', value, numType, loc });

/** @param {number} value @param {string} numType @param {Loc} loc */
export const floatLit = (value, numType, loc) => ({ kind: 'FloatLit', value, numType, loc });

/** @param {string} value @param {string} strType @param {Loc} loc */
export const stringLit = (value, strType, loc) => ({ kind: 'StringLit', value, strType, loc });

/** @param {Loc} loc */
export const nullLit = (loc) => ({ kind: 'NullLit', loc });

/** @param {string} name @param {Loc} loc */
export const ident = (name, loc) => ({ kind: 'Ident', name, loc });

/** @param {string} op @param {Object} operand @param {Loc} loc */
export const unaryExpr = (op, operand, loc) => ({ kind: 'UnaryExpr', op, operand, loc });

/** @param {string} op @param {Object} left @param {Object} right @param {Loc} loc */
export const binaryExpr = (op, left, right, loc) => ({ kind: 'BinaryExpr', op, left, right, loc });

/** @param {Object} callee @param {Object[]} args @param {Object|null} typeArg @param {Loc} loc */
export const callExpr = (callee, args, typeArg, loc) => ({ kind: 'CallExpr', callee, args, typeArg, loc });

/** @param {Object} object @param {string} field @param {Loc} loc */
export const memberExpr = (object, field, loc) => ({ kind: 'MemberExpr', object, field, loc });

/** @param {Object} object @param {Object} index @param {Loc} loc */
export const indexExpr = (object, index, loc) => ({ kind: 'IndexExpr', object, index, loc });

/** @param {Object} object @param {Object} index @param {string} field @param {Loc} loc */
export const indexFieldExpr = (object, index, field, loc) =>
  ({ kind: 'IndexFieldExpr', object, index, field, loc });

/** @param {Object} cond @param {Object} then_ @param {Object} else_ @param {Loc} loc */
export const ifExpr = (cond, then_, else_, loc) => ({ kind: 'IfExpr', cond, then_, else_, loc });

/** @param {Object} cond @param {Object} a @param {Object} b @param {Loc} loc */
export const selectExpr = (cond, a, b, loc) => ({ kind: 'SelectExpr', cond, a, b, loc });

/** @param {Object} expr @param {Object} toType @param {boolean} isUnchecked @param {Loc} loc */
export const castExpr = (expr, toType, isUnchecked, loc) =>
  ({ kind: 'CastExpr', expr, toType, isUnchecked, loc });

/** @param {Object} expr @param {Object} toType @param {Loc} loc */
export const testExpr = (expr, toType, loc) => ({ kind: 'TestExpr', expr, toType, loc });

/** @param {Object} typeExpr @param {Object} fields @param {Loc} loc */
export const newStructExpr = (typeExpr, fields, loc) =>
  ({ kind: 'NewStructExpr', typeExpr, fields, loc });

/** @param {Object} typeExpr @param {Object|null} size @param {Object[]|null} items @param {Loc} loc */
export const newArrayExpr = (typeExpr, size, items, loc) =>
  ({ kind: 'NewArrayExpr', typeExpr, size, items, loc });

/** @param {Object} typeExpr @param {Object} arg @param {Loc} loc */
export const refFuncExpr = (name, loc) => ({ kind: 'RefFuncExpr', name, loc });

/** @param {Object} typeExpr @param {Loc} loc */
export const sizeofExpr = (typeExpr, loc) => ({ kind: 'SizeofExpr', typeExpr, loc });

/** @param {Object[]} items @param {Object|null} dataType @param {Loc} loc */
export const dataLiteral = (items, dataType, loc) => ({ kind: 'DataLiteral', items, dataType, loc });

/** @param {Object[]} items @param {Loc} loc */
export const tupleLit = (items, loc) => ({ kind: 'TupleLit', items, loc });

// ── Try expression ──────────────────────────────────────────────────────────

/** @param {Object[]} body @param {Object[]} catches @param {Loc} loc */
export const tryExpr = (body, catches, loc) => ({ kind: 'TryExpr', body, catches, loc });

// ── Sections ────────────────────────────────────────────────────────────────

/** @param {string|null} builtinName @param {string|null} customName @param {Object[]} items @param {Loc} loc */
export const sectionDecl = (builtinName, customName, items, loc) =>
  ({ kind: 'SectionDecl', builtinName, customName, items, loc });

// ── Pragmas ─────────────────────────────────────────────────────────────────

/** @param {string} name @param {Object[]} args @param {Loc} loc */
export const pragma = (name, args, loc) => ({ kind: 'Pragma', name, args, loc });

// ── Error recovery node ─────────────────────────────────────────────────────

/** @param {string} errorCode @param {Loc} loc */
export const errorNode = (errorCode, loc) => ({ kind: 'ErrorNode', errorCode, recovered: true, loc });
