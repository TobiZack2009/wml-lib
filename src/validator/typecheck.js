/**
 * @fileoverview WML type checker.
 *
 * Walks the AST after scope checking and verifies:
 *   - Operand types are compatible with operators
 *   - Function call arguments match parameter types
 *   - Return types match function signatures
 *   - Assignment targets are mutable
 *   - Struct field access is valid
 *   - Pointer operations are well-typed
 *   - Atomic operations are on shared memory
 *   - select operands have the same type
 *   - try/catch branch types match
 *
 * Type checking uses the error infection rule:
 * if any operand is Types.error, the result is Types.error and no
 * further error is emitted for that node.
 *
 * @example
 * import { TypeChecker } from './typecheck.js';
 * const checker = new TypeChecker(ast, symbols, 'module.wml');
 * const { errors } = checker.check();
 */

import { mkError } from '../diagnostics/errors.js';
import * as Ty from './types.js';

export class TypeChecker {
  /**
   * @param {Object} ast
   * @param {Map<string,Object>} symbols
   * @param {string} file
   * @param {Map<string,Object>} [exposed]
   */
  constructor(ast, symbols, file, exposed = new Map()) {
    this.ast = ast;
    this.symbols = symbols;
    this.exposed = exposed;
    this.file = file;
    /** @type {import('../diagnostics/errors.js').Diagnostic[]} */
    this.errors = [];
    /** Resolved type cache for declarations */
    this.typeCache = new Map();
    /** Current function being checked */
    this.currentFunc = null;
  }

  err(code, message, detail, hint, loc) {
    this.errors.push(mkError(code, message, detail, hint, loc));
  }

  check() {
    for (const decl of this.ast.decls) {
      this.checkDecl(decl);
    }
    this.checkWarnings();
    return { errors: this.errors };
  }

  // ── Resolve type expressions to type objects ─────────────────────────────

  resolveType(typeExpr) {
    if (!typeExpr) return Ty.Types.error;
    switch (typeExpr.kind) {
      case 'PrimitiveType':
      case 'RefType': {
        const t = Ty.resolveBuiltin(typeExpr.name);
        return t ?? Ty.Types.error;
      }
      case 'NamedType': {
        const sym = this.symbols.get(typeExpr.name) ?? this.exposed.get(typeExpr.name);
        if (!sym) return Ty.Types.error;
        if (sym.kind === 'TypeDecl') return this.resolveType(sym.typeExpr);
        return Ty.Types.error;
      }
      case 'FuncRefType':
        return Ty.funcRefType(typeExpr.typeParam ? this.resolveType(typeExpr.typeParam) : null);
      case 'FuncType':
        return Ty.funcType(
          (typeExpr.params ?? []).map(p => this.resolveType(p)),
          (typeExpr.results ?? []).map(r => this.resolveType(r))
        );
      case 'ArrayType':
        return Ty.arrayType('', { elemType: this.resolveType(typeExpr.elemType), isMut: typeExpr.isMut });
      case 'PointerType':
        return Ty.pointerType(this.resolveType(typeExpr.baseType), typeExpr.memory);
      case 'StructType':
        return Ty.structType('', typeExpr);
      default:
        return Ty.Types.error;
    }
  }

  // ── Top-level declarations ───────────────────────────────────────────────

  checkDecl(decl) {
    switch (decl.kind) {
      case 'TypeDecl':
        this.checkTypeDecl(decl);
        break;
      case 'FuncDecl':
        this.checkFunc(decl);
        break;
      case 'GlobalDecl':
        if (decl.init) {
          const initType = this.checkExpr(decl.init, null);
          const declType = this.resolveType(decl.typeExpr);
          if (!Ty.isError(initType) && !Ty.isError(declType)) {
            if (!Ty.isAssignable(initType, declType)) {
              this.err('E100', 'Type mismatch in global initializer',
                `Expected ${declType.name}, found ${initType.name}`,
                null, decl.loc);
            }
          }
        }
        break;
      case 'RecGroup':
        for (const t of decl.types) this.checkDecl(t);
        break;
    }
  }

  /** @param {Object} typeExpr */
  isLinear(typeExpr) {
    return typeExpr?.kind === 'StructType' &&
      typeExpr.pragmas?.some(p => p.name === 'linear');
  }

  /** @param {Object} decl */
  checkTypeDecl(decl) {
    const te = decl.typeExpr;
    if (te.kind === 'StructType') {
      // #[linear] structs cannot extend
      if (te.superType && this.isLinear(te)) {
        this.err('E609', `#[linear] struct '${decl.name}' cannot extend another type`,
          `'${decl.name}' extends another type, but #[linear] structs do not support inheritance`,
          null, decl.loc);
      }
    }
  }

  checkFunc(decl) {
    // Build param type map
    const locals = new Map();
    for (const p of decl.params ?? []) {
      const t = this.resolveType(p.typeExpr);
      locals.set(p.name, t);
      // Reject bare #[linear] struct type as param
      if (t.kind === 'struct' && this.isLinear(t.decl)) {
        this.err('E610', `Parameter '${p.name}' cannot use #[linear] struct type directly`,
          `Use *${t.name} instead`, null, p.loc);
      }
    }
    for (const l of decl.locals ?? []) {
      const t = this.resolveType(l.typeExpr);
      locals.set(l.name, t);
      // Reject bare #[linear] struct type as local
      if (t.kind === 'struct' && this.isLinear(t.decl)) {
        this.err('E610', `Local '${l.name}' cannot use #[linear] struct type directly`,
          `Use *${t.name} instead`, null, l.loc);
      }
      if (l.init) {
        const initType = this.checkExpr(l.init, locals);
        const declType = this.resolveType(l.typeExpr);
        if (!Ty.isError(initType) && !Ty.isError(declType) && !Ty.isAssignable(initType, declType)) {
          this.err('E100', `Type mismatch in local initializer for '${l.name}'`,
            `Expected ${declType.name}, found ${initType.name}`, null, l.loc);
        }
      }
    }

    // Determine return type
    let returnTypes = [];
    if (decl.typeRef) {
      const ft = this.resolveType(decl.typeRef);
      if (ft.kind === 'func') returnTypes = ft.results;
    } else {
      returnTypes = (decl.results ?? []).map(r => {
        const t = this.resolveType(r);
        if (t.kind === 'struct' && this.isLinear(t.decl)) {
          this.err('E610', `Return type cannot use #[linear] struct type directly`,
            `Use *${t.name} instead`, null, r.loc);
        }
        return t;
      });
    }

    const prev = this.currentFunc;
    this.currentFunc = { name: decl.name, returnTypes, locals };

    // Check @start signature
    const isStart = decl.decorators?.some(d => d.name === 'start');
    if (isStart && (decl.params?.length > 0 || returnTypes.length > 0)) {
      this.err('E504', `@start function '${decl.name}' must take no parameters and return ()`,
        '', null, decl.loc);
    }

    // Check import has no body
    const isImport = decl.decorators?.some(d => d.name === 'import');
    if (isImport && decl.body?.length > 0) {
      this.err('E501', `Imported function '${decl.name}' must not have a body`, '', null, decl.loc);
    }

    for (const stmt of decl.body ?? []) {
      this.checkStmt(stmt, locals);
    }

    this.currentFunc = prev;
  }

  // ── Statements ──────────────────────────────────────────────────────────

  checkStmt(stmt, locals) {
    if (!stmt || stmt.kind === 'ErrorNode' || stmt.kind === 'NopStmt' || stmt.kind === 'UnreachableStmt') return;

    switch (stmt.kind) {
      case 'ReturnStmt': {
        const expected = this.currentFunc?.returnTypes ?? [];
        const actual = (stmt.values ?? []).map(v => this.checkExpr(v, locals));
        if (!Ty.isError(actual[0]) && actual.length !== expected.length) {
          this.err('E111', `Return value count mismatch in '${this.currentFunc?.name}'`,
            `Expected ${expected.length} values, found ${actual.length}`, null, stmt.loc);
        } else {
          for (let i = 0; i < Math.min(actual.length, expected.length); i++) {
            if (!Ty.isError(actual[i]) && !Ty.isError(expected[i]) &&
                !Ty.isAssignable(actual[i], expected[i])) {
              this.err('E102', `Return type mismatch in '${this.currentFunc?.name}'`,
                `Expected ${expected[i]?.name}, found ${actual[i]?.name}`, null, stmt.loc);
            }
          }
        }
        break;
      }
      case 'ReturnTailStmt': {
        this.checkExpr(stmt.callee, locals);
        for (const a of stmt.args ?? []) this.checkExpr(a, locals);
        break;
      }
      case 'AssignStmt': {
        const targetType = this.checkAssignTarget(stmt.target, locals);
        const valueType  = this.checkExpr(stmt.value, locals);
        if (!Ty.isError(targetType) && !Ty.isError(valueType) &&
            !Ty.isAssignable(valueType, targetType)) {
          this.err('E100', 'Type mismatch in assignment',
            `Expected ${targetType.name}, found ${valueType.name}`, null, stmt.loc);
        }
        break;
      }
      case 'ExprStmt':
        this.checkExpr(stmt.expr, locals);
        break;
      case 'IfStmt':
        this.checkExpr(stmt.cond, locals);
        for (const s of stmt.then_ ?? []) this.checkStmt(s, locals);
        for (const s of stmt.else_ ?? []) this.checkStmt(s, locals);
        break;
      case 'LoopStmt':
        for (const block of stmt.blocks ?? []) {
          for (const s of block.stmts ?? []) this.checkStmt(s, locals);
        }
        break;
      case 'BreakStmt':
        if (stmt.cond) this.checkExpr(stmt.cond, locals);
        break;
      case 'GotoStmt':
        if (stmt.cond) this.checkExpr(stmt.cond, locals);
        break;
      case 'GotoTableStmt':
        this.checkExpr(stmt.idx, locals);
        break;
      case 'ThrowStmt': {
        // Validate tag exists and arg types match
        const tagName = stmt.tag.kind === 'Ident' ? stmt.tag.name : null;
        if (tagName) {
          const tagDecl = this.symbols.get(tagName) ?? this.exposed.get(tagName);
          if (tagDecl?.kind === 'TagDecl') {
            const paramTypes = tagDecl.params.map(p => this.resolveType(p));
            const argTypes   = (stmt.args ?? []).map(a => this.checkExpr(a, locals));
            if (argTypes.length !== paramTypes.length) {
              this.err('E108', `Tag '${tagName}' expects ${paramTypes.length} arguments, got ${argTypes.length}`,
                '', null, stmt.loc);
            }
          }
        } else {
          // throw_ref — must be exnref
          const t = this.checkExpr(stmt.tag, locals);
          if (!Ty.isError(t) && t?.name !== 'exnref') {
            this.err('E100', 'throw expression must be an exnref', '', null, stmt.loc);
          }
        }
        break;
      }
      case 'TryStmt':
        for (const s of stmt.body ?? []) this.checkStmt(s, locals);
        for (const c of stmt.catches ?? []) {
          const catchLocals = new Map(locals);
          if (c.params?.length > 0 && c.tag === null) {
            // catch-all with binding — exnref
            catchLocals.set(c.params[0], Ty.Types.exnref);
          } else if (c.tag) {
            const tagDecl = this.symbols.get(c.tag) ?? this.exposed.get(c.tag);
            if (tagDecl?.kind === 'TagDecl') {
              tagDecl.params.forEach((p, i) => {
                if (c.params[i]) catchLocals.set(c.params[i], this.resolveType(p));
              });
            }
          }
          for (const s of c.body ?? []) this.checkStmt(s, catchLocals);
        }
        break;
    }
  }

  checkAssignTarget(expr, locals) {
    if (!expr) return Ty.Types.error;
    switch (expr.kind) {
      case 'Ident': {
        const t = locals?.get(expr.name) ?? this.resolveGlobalType(expr.name);
        // Check mutability for globals
        const sym = this.symbols.get(expr.name) ?? this.exposed.get(expr.name);
        if (sym?.kind === 'GlobalDecl' && !sym.isMut) {
          this.err('E113', `Cannot assign to '${expr.name}' — global is not declared mut`,
            '', null, expr.loc);
        }
        return t ?? Ty.Types.error;
      }
      case 'MemberExpr': {
        const objType = this.checkExpr(expr.object, locals);
        return this.getMemberType(objType, expr.field, true, expr.loc);
      }
      case 'IndexExpr': {
        const objType = this.checkExpr(expr.object, locals);
        this.checkExpr(expr.index, locals);
        return this.getIndexType(objType);
      }
      case 'IndexFieldExpr': {
        const objType = this.checkExpr(expr.object, locals);
        this.checkExpr(expr.index, locals);
        return this.getMemberType(objType, expr.field, true, expr.loc);
      }
      default:
        return Ty.Types.error;
    }
  }

  resolveGlobalType(name) {
    const sym = this.symbols.get(name) ?? this.exposed.get(name);
    if (!sym) return Ty.Types.error;
    switch (sym.kind) {
      case 'GlobalDecl': return this.resolveType(sym.typeExpr);
      case 'FuncDecl':   return this.funcDeclType(sym);
      case 'Param':      return this.resolveType(sym.typeExpr);
      case 'LocalDecl':  return this.resolveType(sym.typeExpr);
      default: return Ty.Types.error;
    }
  }

  funcDeclType(decl) {
    const params  = (decl.params ?? []).map(p => this.resolveType(p.typeExpr));
    const results = (decl.results ?? []).map(r => this.resolveType(r));
    return Ty.funcType(params, results);
  }

  // ── Expressions ─────────────────────────────────────────────────────────

  /**
   * Type-check an expression and return its type.
   * @param {Object} expr
   * @param {Map<string,Object>|null} locals
   * @returns {Object} type
   */
  checkExpr(expr, locals) {
    if (!expr || expr.kind === 'ErrorNode') return Ty.Types.error;

    switch (expr.kind) {
      case 'IntLit':   return this.intLitType(expr);
      case 'FloatLit': return this.floatLitType(expr);
      case 'NullLit':  return Ty.Types.nullref;
      case 'StringLit': return Ty.Types.i32; // pointer into memory

      case 'Ident': {
        const t = locals?.get(expr.name) ?? this.resolveGlobalType(expr.name);
        return t ?? Ty.Types.error;
      }

      case 'BinaryExpr':
        return this.checkBinary(expr, locals);

      case 'UnaryExpr':
        return this.checkUnary(expr, locals);

      case 'CallExpr':
        return this.checkCall(expr, locals);

      case 'MemberExpr': {
        const objType = this.checkExpr(expr.object, locals);
        return this.getMemberType(objType, expr.field, false, expr.loc);
      }

      case 'IndexExpr': {
        const objType = this.checkExpr(expr.object, locals);
        this.checkExpr(expr.index, locals);
        return this.getIndexType(objType);
      }

      case 'IndexFieldExpr': {
        const objType = this.checkExpr(expr.object, locals);
        this.checkExpr(expr.index, locals);
        return this.getMemberType(objType, expr.field, false, expr.loc);
      }

      case 'SelectExpr': {
        this.checkExpr(expr.cond, locals);
        const ta = this.checkExpr(expr.a, locals);
        const tb = this.checkExpr(expr.b, locals);
        if (!Ty.isError(ta) && !Ty.isError(tb) && !Ty.isAssignable(ta, tb)) {
          this.err('E109', 'select operands must have the same type',
            `Found ${ta.name} and ${tb.name}`, null, expr.loc);
          return Ty.Types.error;
        }
        return ta;
      }

      case 'CastExpr': {
        this.checkExpr(expr.expr, locals);
        const toType = this.resolveType(expr.toType);
        if (toType.kind === 'struct' && this.isLinear(toType.decl)) {
          this.err('E609', `Cannot cast to a #[linear] struct type`,
            `'${toType.name}' is #[linear]; use pointer-based access`, null, expr.loc);
          return Ty.Types.error;
        }
        return toType;
      }

      case 'TestExpr': {
        this.checkExpr(expr.expr, locals);
        const testType = this.resolveType(expr.toType);
        if (testType.kind === 'struct' && this.isLinear(testType.decl)) {
          this.err('E609', `Cannot use a #[linear] struct type in a type test`,
            `'${testType.name}' is #[linear]`, null, expr.loc);
          return Ty.Types.error;
        }
        return Ty.Types.i32;
      }

      case 'NewStructExpr': {
        const t = this.resolveType(expr.typeExpr);
        if (t.kind === 'struct' && this.isLinear(t.decl)) {
          this.err('E607', `Cannot construct a #[linear] struct with new`,
            `'${t.name}' is #[linear]; allocate manually in linear memory`, null, expr.loc);
          return Ty.Types.error;
        }
        for (const v of Object.values(expr.fields ?? {})) this.checkExpr(v, locals);
        return t;
      }

      case 'NewArrayExpr': {
        const t = this.resolveType(expr.typeExpr);
        if (expr.size) this.checkExpr(expr.size, locals);
        for (const item of expr.items ?? []) this.checkExpr(item, locals);
        return t;
      }

      case 'RefFuncExpr':
        return Ty.funcRefType(null);

      case 'SizeofExpr':
        return Ty.Types.isize;

      case 'DataLiteral':
        for (const item of expr.items ?? []) this.checkExpr(item, locals);
        return Ty.Types.i32;

      case 'IfExpr': {
        this.checkExpr(expr.cond, locals);
        // last stmt type is the value
        let thenType = Ty.Types.void;
        let elseType = Ty.Types.void;
        for (const s of expr.then_ ?? []) {
          if (s.kind === 'ExprStmt') thenType = this.checkExpr(s.expr, locals);
          else this.checkStmt(s, locals);
        }
        for (const s of expr.else_ ?? []) {
          if (s.kind === 'ExprStmt') elseType = this.checkExpr(s.expr, locals);
          else this.checkStmt(s, locals);
        }
        if (!Ty.isError(thenType) && !Ty.isError(elseType) &&
            !Ty.isAssignable(thenType, elseType)) {
          this.err('E100', 'if expression branches have different types',
            `Then: ${thenType.name}, Else: ${elseType.name}`, null, expr.loc);
        }
        return thenType;
      }

      case 'TryExpr': {
        let tryType = Ty.Types.void;
        for (const s of expr.body ?? []) {
          if (s.kind === 'ExprStmt') tryType = this.checkExpr(s.expr, locals);
          else this.checkStmt(s, locals);
        }
        // All catch branches must have the same type as try
        for (const c of expr.catches ?? []) {
          const catchLocals = new Map(locals);
          for (const p of c.params ?? []) catchLocals.set(p, Ty.Types.exnref);
          let catchType = Ty.Types.void;
          for (const s of c.body ?? []) {
            if (s.kind === 'ExprStmt') catchType = this.checkExpr(s.expr, catchLocals);
            else this.checkStmt(s, catchLocals);
          }
          if (!Ty.isError(tryType) && !Ty.isError(catchType) &&
              !Ty.isAssignable(catchType, tryType)) {
            this.err('E100', 'try and catch branches have different types',
              `Try: ${tryType.name}, Catch: ${catchType.name}`, null, expr.loc);
          }
        }
        return tryType;
      }

      default:
        return Ty.Types.error;
    }
  }

  intLitType(expr) {
    const suffix = expr.numType;
    // Auto-promote literals that exceed i32 range to i64
    if ((suffix === 'i32' || suffix === 'u32') &&
        (expr.value > 2147483647n || expr.value < -2147483648n)) {
      return Ty.Types.i64;
    }
    return Ty.resolveBuiltin(suffix) ?? Ty.Types.i32;
  }

  floatLitType(expr) {
    const suffix = expr.numType;
    if (suffix === 'f32') return Ty.Types.f32;
    return Ty.Types.f64;
  }

  checkBinary(expr, locals) {
    const lt = this.checkExpr(expr.left, locals);
    const rt = this.checkExpr(expr.right, locals);
    if (Ty.isError(lt) || Ty.isError(rt)) return Ty.Types.error;

    const op = expr.op;

    // Comparison operators always return i32
    if (['==','!=','<','>','<=','>='].includes(op)) {
      if (!Ty.isAssignable(lt, rt)) {
        this.err('E101', `Operator '${op}' cannot be applied to ${lt.name} and ${rt.name}`,
          '', null, expr.loc);
      }
      return Ty.Types.i32;
    }

    // Logical operators
    if (op === '&&' || op === '||') {
      return Ty.Types.i32;
    }

    // Signed/unsigned division and remainder require matching signedness
    if (['/s','/u','%s','%u'].includes(op)) {
      if (!Ty.isAssignable(lt, rt)) {
        this.err('E101', `Operator '${op}' requires matching integer types`,
          `Found ${lt.name} and ${rt.name}`, null, expr.loc);
        return Ty.Types.error;
      }
      // /u and %u require unsigned type on result
      if (op.endsWith('u') && Ty.isSigned(lt)) {
        this.err('E101', `Operator '${op}' expects unsigned type, found ${lt.name}`,
          "Use u32 or u64 for unsigned operations", null, expr.loc);
      }
      return lt;
    }

    // Shift operators
    if (['<<','>>s','>>u'].includes(op)) {
      if (!Ty.isInt(lt)) {
        this.err('E101', `Shift operator requires integer type, found ${lt.name}`, '', null, expr.loc);
        return Ty.Types.error;
      }
      return lt;
    }

    // Mixed types are an error (e.g. i32 + f64)
    if (!Ty.isAssignable(lt, rt)) {
      this.err('E101', `Operator '${op}' cannot be applied to ${lt.name} and ${rt.name}`,
        '', null, expr.loc);
      return Ty.Types.error;
    }

    return lt;
  }

  checkUnary(expr, locals) {
    const t = this.checkExpr(expr.operand, locals);
    if (Ty.isError(t)) return Ty.Types.error;

    switch (expr.op) {
      case '-':
        if (!Ty.isPrim(t)) {
          this.err('E101', `Unary '-' cannot be applied to ${t.name}`, '', null, expr.loc);
          return Ty.Types.error;
        }
        return t;
      case '~':
        if (!Ty.isInt(t)) {
          this.err('E101', `Unary '~' requires integer type, found ${t.name}`, '', null, expr.loc);
          return Ty.Types.error;
        }
        return t;
      case '!':
        return Ty.Types.i32; // logical not returns i32
      case 'ref.as_non_null':
        return t; // same type, non-null assertion
      default:
        return t;
    }
  }

  checkCall(expr, locals) {
    const calleeType = this.checkExpr(expr.callee, locals);
    const argTypes   = (expr.args ?? []).map(a => this.checkExpr(a, locals));

    if (Ty.isError(calleeType)) return Ty.Types.error;

    // funcref with type annotation
    if (calleeType.kind === 'funcref') {
      if (!calleeType.typeRef && !expr.typeArg) {
        this.err('E112', 'funcref call requires a type annotation',
          '', null, expr.loc);
        return Ty.Types.error;
      }
      const ft = calleeType.typeRef ?? this.resolveType(expr.typeArg);
      if (ft.kind === 'func') return ft.results[0] ?? Ty.Types.void;
      return Ty.Types.error;
    }

    // Regular function
    if (calleeType.kind === 'func') {
      if (argTypes.length !== calleeType.params.length) {
        this.err('E108', `Expected ${calleeType.params.length} arguments, got ${argTypes.length}`,
          '', null, expr.loc);
      } else {
        for (let i = 0; i < argTypes.length; i++) {
          if (!Ty.isError(argTypes[i]) && !Ty.isAssignable(argTypes[i], calleeType.params[i])) {
            this.err('E100', `Argument ${i + 1} type mismatch`,
              `Expected ${calleeType.params[i]?.name}, found ${argTypes[i]?.name}`, null, expr.loc);
          }
        }
      }
      if (calleeType.results.length === 1) return calleeType.results[0];
      if (calleeType.results.length === 0) return Ty.Types.void;
      return calleeType.results[0]; // multi-return returns first for expression context
    }

    if (calleeType.kind !== 'error') {
      this.err('E107', `Type ${calleeType.name ?? calleeType.kind} is not callable`, '', null, expr.loc);
    }
    return Ty.Types.error;
  }

  getMemberType(objType, field, forWrite, loc) {
    if (Ty.isError(objType)) return Ty.Types.error;

    // Struct field access: obj.field
    if (objType.kind === 'struct') {
      // #[linear] structs must be accessed through pointers
      if (this.isLinear(objType.decl)) {
        this.err('E608', `Cannot access fields of #[linear] struct '${objType.name}' directly`,
          `Use a pointer: ptr[0].${field}`, null, loc);
        return Ty.Types.error;
      }
      const structDecl = objType.decl;
      const fieldDef = structDecl?.fields?.find(f => f.name === field);
      if (!fieldDef) {
        this.err('E104', `Type '${objType.name}' has no field '${field}'`, '', null, loc);
        return Ty.Types.error;
      }
      if (forWrite && !fieldDef.isMut) {
        this.err('E105', `Field '${field}' is not declared mut`, '', null, loc);
      }
      return this.resolveType(fieldDef.typeExpr);
    }

    // Method calls on primitives (instance methods like .toI32s(), .add(), etc.)
    // Return type depends on method — simplified here
    if (Ty.isPrim(objType) || Ty.isSIMD(objType)) {
      return this.resolveMethodType(objType, field, loc);
    }

    // Memory instance methods
    if (objType.kind === 'MemoryDecl') {
      return Ty.Types.i32;
    }

    return Ty.Types.error;
  }

  resolveMethodType(type, method, loc) {
    // Conversion methods always return the target type
    const conversionMethods = {
      toI32s: Ty.Types.i32, toI32u: Ty.Types.i32, toI32sSat: Ty.Types.i32, toI32uSat: Ty.Types.i32,
      toI64s: Ty.Types.i64, toI64u: Ty.Types.i64,
      toF32s: Ty.Types.f32, toF32u: Ty.Types.f32,
      toF64:  Ty.Types.f64, toF32:  Ty.Types.f32,
      reinterpret: type.wasm === 'f32' ? Ty.Types.i32 : type.wasm === 'f64' ? Ty.Types.i64 :
                   type.wasm === 'i32' ? Ty.Types.f32 : Ty.Types.f64,
      extend8:  Ty.Types.i32, extend16: Ty.Types.i32, extend32: Ty.Types.i64,
      clz: Ty.Types.i32, ctz: Ty.Types.i32, popcnt: Ty.Types.i32, eqz: Ty.Types.i32,
      abs: type, neg: type, sqrt: type, ceil: type, floor: type,
      trunc: type, nearest: type, min: type, max: type, copysign: type,
      rotl: type, rotr: type,
      add: type, sub: type, mul: type, eq: Ty.Types.i32, ne: Ty.Types.i32,
      extractLane: Ty.Types.i32, replaceLane: type,
      splat: type, shuffle: type, swizzle: type,
    };
    if (method in conversionMethods) return conversionMethods[method];
    // Drop / init etc.
    return Ty.Types.void;
  }

  getIndexType(objType) {
    if (Ty.isError(objType)) return Ty.Types.error;
    // Pointer indexing: ptr[n] — returns base type
    if (objType.kind === 'pointer') return objType.baseType;
    // GC array: arr[n]
    if (objType.kind === 'array') return this.resolveType(objType.decl?.elemType) ?? Ty.Types.error;
    // i32 base (memory indexing)
    if (objType.wasm === 'i32') return Ty.Types.i32;
    return Ty.Types.error;
  }

  // ── Warnings ────────────────────────────────────────────────────────────

  checkWarnings() {
    const usedData = new Set();
    const usedElem = new Set();

    // Walk all expressions to find used data/elem segments
    for (const decl of this.ast.decls) {
      if (decl.kind === 'MemoryInit') {
        for (const item of decl.items ?? []) {
          if (item.kind === 'Ident') usedData.add(item.name);
        }
      }
      if (decl.kind === 'TableInit') {
        for (const item of decl.items ?? []) {
          if (item.kind === 'Ident') usedElem.add(item.name);
        }
      }
    }

    for (const [name, sym] of this.symbols) {
      if (sym.kind === 'DataDecl' && !usedData.has(name)) {
        this.errors.push({
          code: 'W001', category: 'Warning', kind: 'UnusedData', severity: 'warning',
          message: `Data segment '${name}' is declared but never placed into memory`,
          detail: '', hint: null, location: sym.loc, recovered: false,
        });
      }
      if (sym.kind === 'ElemDecl' && !usedElem.has(name) && name !== 'declare') {
        this.errors.push({
          code: 'W002', category: 'Warning', kind: 'UnusedElem', severity: 'warning',
          message: `Element segment '${name}' is declared but never used`,
          detail: '', hint: null, location: sym.loc, recovered: false,
        });
      }
    }
  }
}
