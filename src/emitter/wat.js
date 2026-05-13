/**
 * @fileoverview WML → WAT emitter.
 *
 * Converts a validated, scope-checked, type-checked WML module AST into
 * WebAssembly Text Format (.wat).  The output is valid WAT that can be
 * assembled by `wat2wasm` or Binaryen's `parseText`.
 *
 * The emitter assumes the AST has already passed all validation phases.
 * It does NOT re-validate — bugs in the AST will produce malformed WAT
 * rather than friendly error messages.
 *
 * Operator mapping
 * ─────────────────
 *  WML            → WAT
 *  /s             → i32.div_s / i64.div_s
 *  /u             → i32.div_u / i64.div_u
 *  %s             → i32.rem_s / i64.rem_s
 *  %u             → i32.rem_u / i64.rem_u
 *  >>s            → i32.shr_s / i64.shr_s
 *  >>u            → i32.shr_u / i64.shr_u
 *  !x             → (i32.eqz x)     — always i32 result
 *  &&             → short-circuit via if
 *  ||             → short-circuit via if
 *
 * @example
 * import { WatEmitter } from './wat.js';
 * const wat = new WatEmitter(ast, symbols).emit();
 * // wat: "(module (func ...))"
 */

/** Indentation unit */
const INDENT = '  ';

export class WatEmitter {
  /**
   * @param {Object} ast - Validated module AST
   * @param {Map<string,Object>} symbols - Module symbol table
   * @param {{ debug?: boolean }} [options]
   */
  constructor(ast, symbols, options = {}) {
    this.ast     = ast;
    this.symbols = symbols;
    this.opts    = options;
    /** @type {string[]} Output lines */
    this.lines   = [];
    /** @type {number} Current indent level */
    this.depth   = 0;
    /** @type {Map<string,number>} Type index map for type section */
    this.typeIdx = new Map();
    /** @type {string[]} Collected type entries */
    this.types   = [];
    /** Fresh label counter for short-circuit operators */
    this._labelN = 0;
    /** Current function local type map: name -> wat type string */
    this.currentLocals = new Map();
    /** Whether we're in relooper mode (cross-block goto) */
    this._relooperState = null;

  }

  // ── Output helpers ──────────────────────────────────────────────────────

  indent()   { this.depth++; }
  dedent()   { this.depth--; }
  pad()      { return INDENT.repeat(this.depth); }

  write(s)   { this.lines.push(this.pad() + s); }
  writeln()  { this.lines.push(''); }

  freshLabel() { return `$__wml_${this._labelN++}`; }

  // ── Entry point ─────────────────────────────────────────────────────────

  /**
   * Emit the entire module as a WAT string.
   * @returns {string}
   */
  emit() {
    this.write('(module');
    this.indent();

    // Collect types (func signatures) first — needed for call_indirect
    this.collectTypes();
    this.emitTypeSection();

    for (const decl of this.ast.decls) {
      this.emitDecl(decl);
    }

    this.dedent();
    this.write(')');
    return this.lines.join('\n');
  }

  // ── Type section ────────────────────────────────────────────────────────

  collectTypes() {
    for (const decl of this.ast.decls) {
      if (decl.kind === 'TypeDecl' && decl.typeExpr?.kind === 'FuncType') {
        this.internFuncType(decl.name, decl.typeExpr);
      }
      if (decl.kind === 'FuncDecl') {
        this.internFuncType(decl.name, { params: decl.params, results: decl.results });
      }
    }
  }

  internFuncType(name, ft) {
    const sig = this.funcTypeSig(ft);
    if (!this.typeIdx.has(sig)) {
      this.typeIdx.set(sig, this.types.length);
      this.types.push({ sig, name });
    }
    return this.typeIdx.get(sig);
  }

  funcTypeSig(ft) {
    const params  = (ft.params  ?? []).map(p => this.watType(p.typeExpr ?? p)).join(',');
    const results = (ft.results ?? []).map(r => this.watType(r)).join(',');
    return `(${params})->(${results})`;
  }

  emitTypeSection() {
    // GC struct/array types via rec group (skip #[linear] structs)
    const gcTypes = [...this.symbols.values()].filter(s =>
      s.kind === 'TypeDecl' && (s.typeExpr?.kind === 'StructType' || s.typeExpr?.kind === 'ArrayType') &&
      !this.isLinear(s.typeExpr));

    if (gcTypes.length > 0) {
      this.write('(rec');
      this.indent();
      for (const t of gcTypes) {
        this.emitGCType(t);
      }
      this.dedent();
      this.write(')');
    }

    // Function types (used for call_indirect)
    for (const [sig, idx] of this.typeIdx) {
      const { name } = this.types[idx];
      // Only emit if it's a named typedef, not an anonymous func type
      const sym = this.symbols.get(name);
      if (sym?.kind === 'TypeDecl' && sym.typeExpr?.kind === 'FuncType') {
        const parts = this.emitFuncTypeParts(sym.typeExpr);
        this.write(`(type $${name} (func ${parts}))`);
      }
    }
  }

  emitGCType(typeDecl) {
    const te = typeDecl.typeExpr;
    const name = typeDecl.name;
    if (te.kind === 'StructType') {
      const repr    = this.resolveRepr(te.pragmas ?? []);
      const final   = te.isFinal ? ' (sub final' : te.superType ? ` (sub $${this.typeExprName(te.superType)}` : '';
      const closing = (te.isFinal || te.superType) ? ')' : '';
      this.write(`(type $${name}${final} (struct`);
      this.indent();
      for (const f of te.fields ?? []) {
        const mut = f.isMut ? '(mut ' : '';
        const end = f.isMut ? ')' : '';
        this.write(`(field $${f.name} ${mut}${this.watType(f.typeExpr)}${end})`);
      }
      this.dedent();
      this.write(`)${closing})`);
    } else if (te.kind === 'ArrayType') {
      const mut = te.isMut ? '(mut ' : '';
      const end = te.isMut ? ')' : '';
      this.write(`(type $${name} (array ${mut}${this.watType(te.elemType)}${end}))`);
    }
  }

  /** @param {Object} typeExpr */
  isLinear(typeExpr) {
    return typeExpr?.kind === 'StructType' &&
      typeExpr.pragmas?.some(p => p.name === 'linear');
  }

  resolveRepr(pragmas) {
    for (const p of pragmas) {
      if (p.name === 'repr') return p.args?.[0]?.name ?? 'default';
    }
    return 'default';
  }

  typeExprName(te) {
    if (te.kind === 'NamedType') return te.name;
    return '';
  }

  // ── Top-level declarations ───────────────────────────────────────────────

  emitDecl(decl) {
    switch (decl.kind) {
      case 'MemoryDecl':  this.emitMemory(decl);  break;
      case 'TableDecl':   this.emitTable(decl);   break;
      case 'GlobalDecl':  this.emitGlobal(decl);  break;
      case 'DataDecl':    this.emitData(decl);     break;
      case 'ElemDecl':    this.emitElem(decl);     break;
      case 'TagDecl':     this.emitTag(decl);      break;
      case 'FuncDecl':    this.emitFunc(decl);     break;
      case 'MemoryInit':  this.emitMemoryInit(decl); break;
      case 'TypeDecl':    break; // emitted in type section
      case 'RecGroup':    break; // emitted in type section
      case 'SectionDecl': this.emitSection(decl); break;
    }
  }

  // ── Memory ───────────────────────────────────────────────────────────────

  emitMemory(decl) {
    const decorators = decl.decorators ?? [];
    const isImport = decorators.find(d => d.name === 'import');
    const isExport = decorators.find(d => d.name === 'export');
    const shared   = decl.isShared ? ' shared' : '';
    const max      = decl.max !== null ? ` ${decl.max}` : '';

    if (isImport) {
      this.write(`(memory $${decl.name} (import "${isImport.args[0]}" "${isImport.args[1]}") ${decl.min}${max})`);
    } else {
      const exportStr = isExport ? ` (export "${decl.name}")` : '';
      this.write(`(memory $${decl.name}${exportStr}${shared} ${decl.min}${max})`);
    }
  }

  // ── Table ────────────────────────────────────────────────────────────────

  emitTable(decl) {
    const decorators = decl.decorators ?? [];
    const isImport = decorators.find(d => d.name === 'import');
    const isExport = decorators.find(d => d.name === 'export');
    const elemType = this.watType(decl.elemType);
    const max      = decl.max !== null ? ` ${decl.max}` : '';

    if (isImport) {
      this.write(`(table $${decl.name} (import "${isImport.args[0]}" "${isImport.args[1]}") ${decl.min}${max} ${elemType})`);
    } else {
      const exportStr = isExport ? ` (export "${decl.name}")` : '';
      this.write(`(table $${decl.name}${exportStr} ${decl.min}${max} ${elemType})`);
    }
  }

  // ── Global ───────────────────────────────────────────────────────────────

  emitGlobal(decl) {
    const decorators = decl.decorators ?? [];
    const isImport   = decorators.find(d => d.name === 'import');
    const isExport   = decorators.find(d => d.name === 'export');
    const watT       = this.watType(decl.typeExpr);
    const typeStr    = decl.isMut ? `(mut ${watT})` : watT;

    if (isImport) {
      this.write(`(global $${decl.name} (import "${isImport.args[0]}" "${isImport.args[1]}") ${typeStr})`);
      return;
    }

    const exportStr = isExport ? ` (export "${decl.name}")` : '';
    if (decl.init) {
      this.write(`(global $${decl.name}${exportStr} ${typeStr}`);
      this.indent();
      this.emitExpr(decl.init);
      this.dedent();
      this.write(')');
    } else {
      this.write(`(global $${decl.name}${exportStr} ${typeStr} (${watT}.const 0))`);
    }
  }

  // ── Data segment ─────────────────────────────────────────────────────────

  emitData(decl) {
    // Passive data segment — placement is handled by MemoryInit
    const bytes = this.dataItemsToBytes(decl.items ?? [], decl.dataType);
    const hexStr = bytes.map(b => `\\${b.toString(16).padStart(2, '0')}`).join('');
    this.write(`(data $${decl.name} "${hexStr}")`);
  }

  emitMemoryInit(decl) {
    // Active segment: (data (memory $Mem) (offset expr) "bytes")
    // Collect bytes from all items (inlining named data segment refs)
    const bytes = [];
    for (const item of decl.items ?? []) {
      if (item.kind === 'Ident') {
        const seg = this.symbols.get(item.name);
        if (seg?.kind === 'DataDecl') {
          bytes.push(...this.dataItemsToBytes(seg.items, seg.dataType));
        }
      } else {
        bytes.push(...this.dataItemsToBytes([item], null));
      }
    }
    const hexStr = bytes.map(b => `\\${b.toString(16).padStart(2, '0')}`).join('');

    // Collect offset as inline expression string
    this.write(`(data (memory $${decl.memory})`);
    this.indent();
    this.write(`(offset`);
    this.indent();
    this.emitExpr(decl.offset);
    this.dedent();
    this.write(')');
    this.write(`"${hexStr}"`);
    this.dedent();
    this.write(')');
  }

  dataItemsToBytes(items, dataType) {
    const bytes = [];
    for (const item of items) {
      bytes.push(...this.itemToBytes(item, dataType));
    }
    return bytes;
  }

  itemToBytes(item, hint) {
    if (!item) return [];
    switch (item.kind) {
      case 'IntLit': {
        const n     = Number(item.value);
        const type  = item.numType ?? hint?.elemType ?? 'i8';
        const size  = { i8:1, u8:1, i16:2, u16:2, i32:4, u32:4, i64:8, u64:8, f32:4, f64:8 }[type] ?? 1;
        const buf   = new ArrayBuffer(size);
        const view  = new DataView(buf);
        if (size === 1) view.setUint8(0, n & 0xFF);
        else if (size === 2) view.setUint16(0, n & 0xFFFF, true);
        else if (size === 4) view.setUint32(0, n >>> 0, true);
        else if (size === 8) {
          view.setUint32(0, Number(BigInt(n) & 0xFFFFFFFFn) >>> 0, true);
          view.setUint32(4, Number(BigInt(n) >> 32n) >>> 0, true);
        }
        return [...new Uint8Array(buf)];
      }
      case 'FloatLit': {
        const type = item.numType ?? hint?.elemType ?? 'f64';
        const buf  = new ArrayBuffer(type === 'f32' ? 4 : 8);
        const view = new DataView(buf);
        if (type === 'f32') view.setFloat32(0, item.value, true);
        else view.setFloat64(0, item.value, true);
        return [...new Uint8Array(buf)];
      }
      case 'StringLit': {
        const enc = new TextEncoder();
        const str = item.value;
        switch (item.strType) {
          case 'cstr': {
            const encoded = enc.encode(str);
            return [...encoded, 0]; // null terminated
          }
          case 'utf8_32': {
            const encoded = enc.encode(str);
            const len = encoded.length;
            const buf  = new ArrayBuffer(4);
            new DataView(buf).setUint32(0, len, true);
            return [...new Uint8Array(buf), ...encoded];
          }
          case 'utf8_64': {
            const encoded = enc.encode(str);
            const len = encoded.length;
            const buf  = new ArrayBuffer(8);
            const view = new DataView(buf);
            view.setUint32(0, len & 0xFFFFFFFF, true);
            view.setUint32(4, 0, true);
            return [...new Uint8Array(buf), ...encoded];
          }
          case 'pascal': {
            const encoded = enc.encode(str.slice(0, 255));
            return [encoded.length, ...encoded];
          }
          default: {
            return [...enc.encode(str)];
          }
        }
      }
      case 'DataLiteral':
        return this.dataItemsToBytes(item.items, item.dataType);
      default:
        return [];
    }
  }

  // ── Element segment ───────────────────────────────────────────────────────

  emitElem(decl) {
    if (decl.isDeclare) {
      // Declarative element segment
      const refs = (decl.items ?? []).map(i => this.elemItemStr(i)).join(' ');
      this.write(`(elem declare funcref ${refs})`);
      return;
    }
    const elemType = decl.elemType ? this.watType(decl.elemType) : 'funcref';
    const refs = (decl.items ?? []).map(i => this.elemItemStr(i)).join(' ');
    this.write(`(elem $${decl.name} ${elemType} ${refs})`);
  }

  elemItemStr(item) {
    if (item.kind === 'RefFuncExpr') return `(ref.func $${item.name})`;
    if (item.kind === 'Ident') return `(ref.func $${item.name})`;
    if (item.kind === 'NullLit') return `(ref.null func)`;
    return `(ref.null func)`;
  }

  // ── Tag ───────────────────────────────────────────────────────────────────

  emitTag(decl) {
    const decorators = decl.decorators ?? [];
    const isImport   = decorators.find(d => d.name === 'import');
    const isExport   = decorators.find(d => d.name === 'export');
    const params     = (decl.params ?? []).map(p => `(param ${this.watType(p)})`).join(' ');

    if (isImport) {
      this.write(`(tag $${decl.name} (import "${isImport.args[0]}" "${isImport.args[1]}") (param ${params}))`);
      return;
    }
    const exportStr = isExport ? ` (export "${decl.name}")` : '';
    this.write(`(tag $${decl.name}${exportStr} (param ${params}))`);
  }

  // ── Custom section ────────────────────────────────────────────────────────

  emitSection(decl) {
    if (decl.builtinName === 'debug') return; // handled by debug emitter
    // Custom sections require binary encoding — emit as a comment placeholder
    this.write(`(; custom section "${decl.customName}" ;)`);
  }

  // ── Function ──────────────────────────────────────────────────────────────

  emitFunc(decl) {
    const decorators = decl.decorators ?? [];
    const isImport   = decorators.find(d => d.name === 'import');
    const isExport   = decorators.find(d => d.name === 'export');

    if (isImport) {
      const params  = (decl.params ?? []).map(p => `(param $${p.name} ${this.watType(p.typeExpr)})`).join(' ');
      const results = this.emitResultTypes(decl.results ?? []);
      this.write(`(func $${decl.name} (import "${isImport.args[0]}" "${isImport.args[1]}") ${params} ${results})`);
      return;
    }

    // Populate local scope for type inference during emission
    this.currentLocals = new Map();
    this.currentTypeMap = new Map();
    for (const p of decl.params ?? []) {
      this.currentLocals.set(p.name, this.watType(p.typeExpr));
      this.currentTypeMap.set(p.name, p.typeExpr);
    }
    for (const l of decl.locals ?? []) {
      this.currentLocals.set(l.name, this.watType(l.typeExpr));
      this.currentTypeMap.set(l.name, l.typeExpr);
    }

    const exportStr = isExport ? ` (export "${decl.name}")` : '';
    const params    = (decl.params ?? []).map(p => `(param $${p.name} ${this.watType(p.typeExpr)})`).join(' ');
    const results   = this.emitResultTypes(decl.results ?? []);
    const locals    = (decl.locals ?? []).map(l => `(local $${l.name} ${this.watType(l.typeExpr)})`).join(' ');

    this.write(`(func $${decl.name}${exportStr} ${params} ${results}`);
    this.indent();

    if (locals) this.write(locals);
    // One temp local for store operations
    this.write(`(local $__wml_temp i32)`);
    // Relooper state local (only used for cross-block goto)
    if (this._needsRelooper(decl.body ?? [])) {
      this.write(`(local $__state i32)`);
    }

    // Emit local initializations
    for (const l of decl.locals ?? []) {
      if (l.init) {
        this.emitExpr(l.init);
        this.write(`local.set $${l.name}`);
      }
    }

    for (const stmt of decl.body ?? []) {
      this.emitStmt(stmt);
    }

    this.dedent();
    this.write(')');
  }

  emitResultTypes(results) {
    if (results.length === 0) return '';
    return results.map(r => `(result ${this.watType(r)})`).join(' ');
  }

  emitFuncTypeParts(ft) {
    const params  = (ft.params  ?? []).map(p => `(param ${this.watType(p)})`).join(' ');
    const results = (ft.results ?? []).map(r => `(result ${this.watType(r)})`).join(' ');
    return [params, results].filter(Boolean).join(' ');
  }

  // ── Statements ────────────────────────────────────────────────────────────

  emitStmt(stmt) {
    if (!stmt) return;
    switch (stmt.kind) {
      case 'ReturnStmt':
        for (const v of stmt.values ?? []) this.emitExpr(v);
        this.write('return');
        break;

      case 'ReturnTailStmt': {
        for (const a of stmt.args ?? []) this.emitExpr(a);
        const callee = this.exprStr(stmt.callee);
        this.write(`return_call ${callee}`);
        break;
      }

      case 'ExprStmt':
        this.emitExpr(stmt.expr);
        // Drop if value is not void
        if (this.exprHasValue(stmt.expr)) this.write('drop');
        break;

      case 'AssignStmt':
        this.emitAssign(stmt);
        break;

      case 'UnreachableStmt':
        this.write('unreachable');
        break;

      case 'NopStmt':
        this.write('nop');
        break;

      case 'IfStmt':
        this.emitIfStmt(stmt);
        break;

      case 'LoopStmt':
        this.emitLoopStmt(stmt);
        break;

      case 'BreakStmt':
        if (stmt.cond) {
          this.emitExpr(stmt.cond);
          this.write('br_if $__loop_exit');
        } else {
          this.write('br $__loop_exit');
        }
        break;

      case 'GotoStmt':
        if (this._relooperState) {
          const target = this._relooperState.blockStates.get(stmt.label);
          if (target !== undefined) {
            // Cross-block goto via state machine
            if (stmt.cond) {
              this.emitExpr(stmt.cond);
              this.write('if');
              this.indent();
              this.write(`i32.const ${target}`);
              this.write('local.set $__state');
              this.write('br $__loop_head');
              this.dedent();
              this.write('end');
            } else {
              this.write(`i32.const ${target}`);
              this.write('local.set $__state');
              this.write('br $__loop_head');
            }
          } else {
            // Label not found in this loop — emit as regular br
            if (stmt.cond) {
              this.emitExpr(stmt.cond);
              this.write(`br_if $${stmt.label}`);
            } else {
              this.write(`br $${stmt.label}`);
            }
          }
        } else {
          // Simple mode: direct br to label
          if (stmt.cond) {
            this.emitExpr(stmt.cond);
            this.write(`br_if $${stmt.label}`);
          } else {
            this.write(`br $${stmt.label}`);
          }
        }
        break;

      case 'GotoTableStmt':
        this.emitExpr(stmt.idx);
        this.write(`br_table ${stmt.labels.map(l => `$${l}`).join(' ')}`);
        break;

      case 'ThrowStmt':
        if (stmt.args.length > 0) {
          for (const a of stmt.args) this.emitExpr(a);
          this.write(`throw $${stmt.tag.name}`);
        } else {
          this.emitExpr(stmt.tag);
          this.write('throw_ref');
        }
        break;

      case 'TryStmt':
        this.emitTryStmt(stmt);
        break;

      case 'ErrorNode':
        this.write('unreachable ;; error node');
        break;
    }
  }

  emitAssign(stmt) {
    const target = stmt.target;
    if (stmt.op !== '=') {
      // Compound assignment: +=, -=, *=
      // Push current value, then new value, then op, then store
      this.emitExpr(target);
      this.emitExpr(stmt.value);
      const opMap = { '+=': 'add', '-=': 'sub', '*=': 'mul' };
      const watT  = this.inferExprWatType(target);
      this.write(`${watT}.${opMap[stmt.op]}`);
    } else {
      this.emitExpr(stmt.value);
    }
    this.emitStore(target);
  }

  emitStore(target) {
    switch (target.kind) {
      case 'Ident': {
        const sym = this.symbols.get(target.name);
        if (sym?.kind === 'GlobalDecl') {
          this.write(`global.set $${target.name}`);
        } else {
          this.write(`local.set $${target.name}`);
        }
        break;
      }
      case 'MemberExpr': {
        // GC struct field set: object already on stack, then value on stack
        // We need to re-emit the object for struct.set
        // WAT struct.set: struct.set $type $field (object) (value)
        // Since we already pushed value, we need to use a local temp
        this.write(`local.set $__wml_temp`);
        this.emitExpr(target.object);
        this.write(`local.get $__wml_temp`);
        const typeName = this.structTypeName(target.object);
        this.write(`struct.set $${typeName} $${target.field}`);
        break;
      }
      case 'IndexExpr': {
        // For GC arrays: array.set
        // For pointers: memory store
        // emitAssign already pushed value: stack = [value]
        // array.set expects [ref] [index] [value] with value on top
        // i32.store expects [address] [value] with value on top
        const typeName = this.arrayTypeName(target.object);
        if (typeName) {
          this.write(`local.set $__wml_temp`);
          this.emitExpr(target.object);
          this.emitExpr(target.index);
          this.write(`local.get $__wml_temp`);
          this.write(`array.set $${typeName}`);
        } else {
          this.write(`local.set $__wml_temp`);
          this.emitExpr(target.object);
          this.emitExpr(target.index);
          this.write(`i32.add`);
          this.write(`local.get $__wml_temp`);
          const watT = this.inferExprWatType(target);
          this.write(`${watT}.store`);
        }
        break;
      }
      case 'IndexFieldExpr': {
        const typeName = this.structTypeName(target.object);
        if (typeName) {
          const sym = this.symbols.get(typeName);
          if (sym?.typeExpr && this.isLinear(sym.typeExpr)) {
            // #[linear] struct through pointer: ptr[n].field = val
            // emitAssign already pushed value; save it, compute address, restore
            this.write(`local.set $__wml_temp`);
            this.emitExpr(target.object);
            this.emitExpr(target.index);
            const size = this.computeStructSize(sym.typeExpr, sym.typeExpr.pragmas ?? []);
            this.write(`i32.const ${size}`);
            this.write(`i32.mul`);
            this.write(`i32.add`);
            const offset = this.computeFieldOffset(typeName, target.field);
            this.write(`local.get $__wml_temp`);
            const fieldType = this.getFieldType(typeName, target.field);
            this.write(`${fieldType}.store offset=${offset}`);
          } else {
            this.emitExpr(target.object);
            this.emitExpr(target.index);
            this.write(`struct.set $${typeName} $${target.field}`);
          }
        }
        break;
      }
    }
  }

  emitIfStmt(stmt) {
    this.emitExpr(stmt.cond);
    this.write('if');
    this.indent();
    this.write('then');
    this.indent();
    for (const s of stmt.then_ ?? []) this.emitStmt(s);
    this.dedent();
    if (stmt.else_?.length > 0) {
      this.dedent();
      this.write('else');
      this.indent();
      for (const s of stmt.else_) this.emitStmt(s);
      this.dedent();
    } else {
      this.dedent();
    }
    this.write('end');
  }

  emitLoopStmt(stmt) {
    if (this._hasCrossBlockGoto(stmt)) {
      this._emitRelooperLoop(stmt);
    } else {
      this._emitSimpleLoop(stmt);
    }
  }

  /** Check if any loop in a function body needs relooper mode */
  _needsRelooper(body) {
    for (const stmt of body) {
      if (stmt?.kind === 'LoopStmt' && this._hasCrossBlockGoto(stmt)) return true;
    }
    return false;
  }

  /** Check if any goto in the loop targets a label in a different block */
  _hasCrossBlockGoto(loopStmt) {
    const blocks = loopStmt.blocks ?? [];
    const labelBlocks = new Map();
    blocks.forEach((block, idx) => {
      for (const lbl of block.labels ?? []) {
        labelBlocks.set(lbl.label, idx);
      }
    });
    for (let blockIdx = 0; blockIdx < blocks.length; blockIdx++) {
      const gotos = this._collectGotos(blocks[blockIdx].stmts ?? []);
      for (const g of gotos) {
        const target = labelBlocks.get(g.label);
        if (target !== undefined && target !== blockIdx) return true;
      }
    }
    return false;
  }

  /** Recursively collect all GotoStmt nodes (stops at nested loops) */
  _collectGotos(stmts) {
    const gotos = [];
    for (const stmt of stmts) {
      if (!stmt) continue;
      if (stmt.kind === 'GotoStmt') {
        gotos.push(stmt);
      } else if (stmt.kind === 'IfStmt') {
        gotos.push(...this._collectGotos(stmt.then_ ?? []));
        gotos.push(...this._collectGotos(stmt.else_ ?? []));
      } else if (stmt.kind === 'TryStmt') {
        gotos.push(...this._collectGotos(stmt.body ?? []));
        for (const c of stmt.catches ?? []) {
          gotos.push(...this._collectGotos(c.body ?? []));
        }
      } else if (stmt.kind === 'GotoTableStmt') {
        // br_table targets are direct label references, handled separately
      } else if (stmt.kind === 'ExprStmt') {
        gotos.push(...this._exprGotos(stmt.expr));
      }
      // LoopStmt: inner loops have their own scope — excluded
    }
    return gotos;
  }

  /** Collect gotos from expressions that contain statements */
  _exprGotos(expr) {
    if (!expr) return [];
    if (expr.kind === 'IfExpr') {
      return [
        ...this._collectGotos(expr.then_ ?? []),
        ...this._collectGotos(expr.else_ ?? []),
      ];
    }
    if (expr.kind === 'TryExpr') {
      const gotos = [...this._collectGotos(expr.body ?? [])];
      for (const c of expr.catches ?? []) {
        gotos.push(...this._collectGotos(c.body ?? []));
      }
      return gotos;
    }
    return [];
  }

  /** Emit a loop with cross-block goto support via state machine */
  _emitRelooperLoop(stmt) {
    const blocks = stmt.blocks ?? [];
    const numBlocks = blocks.length;

    // Build label → block index map
    const blockStates = new Map();
    blocks.forEach((block, idx) => {
      for (const lbl of block.labels ?? []) {
        blockStates.set(lbl.label, idx);
      }
    });

    // Set relooper context for emitGotoStmt
    const prevState = this._relooperState;
    this._relooperState = { blockStates, numBlocks };

    this.write('(block $__loop_exit');
    this.indent();

    // Initialize state to 0 (first block) — runs once on loop entry
    this.write('i32.const 0');
    this.write('local.set $__state');

    this.write('(loop $__loop_head');
    this.indent();

    // 0$ is outer most target. 1$ is inside 0$, 2 inside 1,  etc.
    //      $__default is inside everything.
    //   (block $__default
    //     (block $0
    //       (block $1
    //         (block $2
    //           ...
    //             (block $(N-1)
    //               (block $__dispatch
    //                 (br_table $0 $1 ... $(N-1) $__default (local.get $__state))
    //               )
    //             )
    //             ;; Block N-1 code
    //           ...
    //         ;; Block 2 code
    //         )
    //       ;; Block 1 code
    //       )
    //     ;; Block 0 code
    //     )
    //   )
    //   br $__loop_exit   ;; default/unknown state

    // Phase 1: Open all nesting blocks (outermost to innermost)
    this.write('(block $__default');
    this.indent();
    for (let i = 0; i < numBlocks; i++) {
      this.write(`(block $${i}`);
      this.indent();
    }
    // Innermost dispatch
    this.write('(block $__dispatch');
    this.indent();

    // br_table dispatcher
    const targets = [];
    for (let i = 0; i < numBlocks; i++) targets.push(`$${i}`);
    targets.push('$__default');
    this.write(`(br_table ${targets.join(' ')} (local.get $__state))`);

    // Close dispatch
    this.dedent();
    this.write(')'); // end $__dispatch

    // Phase 2: Close blocks in reverse, emitting code for each
    for (let i = numBlocks - 1; i >= 0; i--) {
      // Close this block's wrapper
      this.dedent();
      this.write(')'); // end $(block i) wrapper

      // Emit this block's statements
      for (const s of blocks[i].stmts ?? []) {
        this.emitStmt(s);
      }

      // Fall through — loop back to dispatcher
      // The loop continues until an explicit break targets $__loop_exit
      if (i < numBlocks - 1) {
        // Set state to next block number and continue loop
        this.write(`i32.const ${i + 1}`);
        this.write('local.set $__state');
      } else {
        // Last block: loop back to first block
        this.write('i32.const 0');
        this.write('local.set $__state');
      }
      this.write('br $__loop_head');
    }

    // Close $__default
    this.dedent();
    this.write(')'); // end $__default

    // Default/unknown state: exit
    this.write('br $__loop_exit');

    this.dedent();
    this.write(')'); // end loop
    this.dedent();
    this.write(')'); // end block __loop_exit

    this._relooperState = prevState;
  }

  /** Emit a loop without cross-block gotos (simple sibling blocks) */
  _emitSimpleLoop(stmt) {
    // WML loop { { 'label ... } } compiles to nested WAT blocks + loop:
    //
    //   (block $__loop_exit
    //     (loop $__loop_head
    //       (block $label1
    //         (block $label2
    //           ... stmts ...
    //         )
    //       )
    //       br $__loop_head  ;; continue
    //     )
    //   )
    //
    // Labels within a block become br targets.
    this.write('(block $__loop_exit');
    this.indent();
    this.write('(loop $__loop_head');
    this.indent();

    for (const block of stmt.blocks ?? []) {
      const labels = (block.labels ?? []).map(l => `$${l.label}`);
      // Wrap in nested blocks for each label
      for (const lbl of labels) {
        this.write(`(block ${lbl}`);
        this.indent();
      }
      for (const s of block.stmts ?? []) {
        this.emitStmt(s);
      }
      for (let i = 0; i < labels.length; i++) {
        this.dedent();
        this.write(')');
      }
    }

    this.write('br $__loop_head');
    this.dedent();
    this.write(')'); // end loop
    this.dedent();
    this.write(')'); // end block __loop_exit
  }

  emitTryStmt(stmt) {
    this.write('try');
    this.indent();
    for (const s of stmt.body) this.emitStmt(s);
    this.dedent();

    for (const c of stmt.catches ?? []) {
      if (c.tag === null && c.params.length === 0) {
        // catch_all
        this.write('catch_all');
        this.indent();
        for (const s of c.body ?? []) this.emitStmt(s);
        this.dedent();
      } else if (c.tag === null && c.params.length > 0) {
        // catch_all with exnref binding
        this.write('catch_all');
        this.indent();
        this.write(`local.set $${c.params[0]}`);
        for (const s of c.body ?? []) this.emitStmt(s);
        this.dedent();
      } else if (c.route) {
        // try_table style: catch Tag => break label
        this.write(`catch $${c.tag}`);
        this.indent();
        // Pop tag params
        for (const p of [...(c.params ?? [])].reverse()) {
          this.write(`local.set $${p}`);
        }
        this.write(`br $${c.route}`);
        this.dedent();
      } else {
        this.write(`catch $${c.tag}`);
        this.indent();
        for (const p of [...(c.params ?? [])].reverse()) {
          this.write(`local.set $${p}`);
        }
        for (const s of c.body ?? []) this.emitStmt(s);
        this.dedent();
      }
    }

    this.write('end');
  }

  // ── Expressions ───────────────────────────────────────────────────────────

  /**
   * Emit WAT instructions for an expression, leaving its value on the stack.
   * @param {Object} expr
   */
  emitExpr(expr) {
    if (!expr) return;
    switch (expr.kind) {
      case 'IntLit': {
        // Infer correct WASM type: if literal doesn't fit in i32 range, use i64
        let numType = expr.numType ?? 'i32';
        const val = expr.value;
        if ((numType === 'i32' || numType === 'u32') &&
            (val > 2147483647n || val < -2147483648n)) {
          numType = 'i64';
        }
        const watT = this.numTypeToWat(numType);
        this.write(`${watT}.const ${val}`);
        break;
      }
      case 'FloatLit': {
        const watT = expr.numType === 'f32' ? 'f32' : 'f64';
        this.write(`${watT}.const ${expr.value}`);
        break;
      }
      case 'NullLit':
        this.write('ref.null none');
        break;
      case 'StringLit':
        // String literals produce a (data offset, length) pair or just offset
        // In this simplified emitter, we output i32.const 0 as placeholder
        // The linker assigns actual offsets
        this.write(`i32.const 0 ;; string "${expr.value.slice(0,20)}"`);
        break;
      case 'Ident':
        this.emitLoad(expr.name);
        break;
      case 'BinaryExpr':
        this.emitBinary(expr);
        break;
      case 'UnaryExpr':
        this.emitUnary(expr);
        break;
      case 'CallExpr':
        this.emitCall(expr);
        break;
      case 'MemberExpr':
        this.emitMember(expr);
        break;
      case 'IndexExpr':
        this.emitIndex(expr);
        break;
      case 'IndexFieldExpr':
        this.emitIndexField(expr);
        break;
      case 'SelectExpr':
        this.emitExpr(expr.a);
        this.emitExpr(expr.b);
        this.emitExpr(expr.cond);
        this.write('select');
        break;
      case 'CastExpr':
        this.emitExpr(expr.expr);
        if (expr.toType.kind === 'NamedType') {
          const op = expr.isUnchecked ? 'ref.cast_nop' : 'ref.cast';
          this.write(`${op} $${expr.toType.name}`);
        }
        break;
      case 'TestExpr':
        this.emitExpr(expr.expr);
        this.write(`ref.test $${expr.toType.name ?? expr.toType.kind}`);
        break;
      case 'NewStructExpr':
        for (const v of Object.values(expr.fields ?? {})) this.emitExpr(v);
        this.write(`struct.new $${this.typeExprName(expr.typeExpr)}`);
        break;
      case 'NewArrayExpr':
        if (expr.size) {
          this.emitExpr(expr.size);
          this.write(`array.new_default $${this.typeExprName(expr.typeExpr)}`);
        } else {
          for (const item of expr.items ?? []) this.emitExpr(item);
          this.write(`array.new_fixed $${this.typeExprName(expr.typeExpr)} ${expr.items?.length ?? 0}`);
        }
        break;
      case 'RefFuncExpr':
        this.write(`ref.func $${expr.name}`);
        break;
      case 'SizeofExpr':
        this.write(`i32.const ${this.sizeofType(expr.typeExpr)}`);
        break;
      case 'IfExpr':
        this.emitIfExpr(expr);
        break;
      case 'DataLiteral':
        // Inline data literals emit as i32.const 0 (offset assigned at link time)
        this.write('i32.const 0 ;; data literal');
        break;
      case 'ErrorNode':
        this.write('unreachable ;; error');
        break;
    }
  }

  emitLoad(name) {
    const sym = this.symbols.get(name);
    if (!sym) {
      this.write(`local.get $${name}`);
      return;
    }
    switch (sym.kind) {
      case 'GlobalDecl': this.write(`global.get $${name}`); break;
      case 'FuncDecl':   this.write(`ref.func $${name}`); break;
      default:           this.write(`local.get $${name}`); break;
    }
  }

  emitBinary(expr) {
    const op   = expr.op;
    const watT = this.inferExprWatType(expr.left);

    // Short-circuit operators use if blocks
    if (op === '&&') {
      const lbl = this.freshLabel();
      this.emitExpr(expr.left);
      this.write(`if (result i32)`);
      this.indent();
      this.write('then');
      this.indent();
      this.emitExpr(expr.right);
      this.dedent();
      this.write('else');
      this.indent();
      this.write('i32.const 0');
      this.dedent();
      this.write('end');
      return;
    }
    if (op === '||') {
      this.emitExpr(expr.left);
      this.write(`if (result i32)`);
      this.indent();
      this.write('then');
      this.indent();
      this.write('i32.const 1');
      this.dedent();
      this.write('else');
      this.indent();
      this.emitExpr(expr.right);
      this.dedent();
      this.write('end');
      return;
    }

    this.emitExpr(expr.left);
    this.emitExpr(expr.right);

    const opMap = {
      '+':  'add',    '-':  'sub',    '*':  'mul',
      '/s': 'div_s',  '/u': 'div_u',  '/':  'div_s',
      '%s': 'rem_s',  '%u': 'rem_u',  '%':  'rem_s',
      '&':  'and',    '|':  'or',     '^':  'xor',
      '<<': 'shl',    '>>s':'shr_s',  '>>u':'shr_u',  '>>': 'shr_s',
      '==': 'eq',     '!=': 'ne',
      '<':  'lt_s',   '>':  'gt_s',   '<=': 'le_s',   '>=': 'ge_s',
    };

    // For floats, comparison ops have no _s/_u suffix
    const isFloat = watT === 'f32' || watT === 'f64';
    let watOp = opMap[op] ?? op;
    if (isFloat && (watOp === 'lt_s' || watOp === 'le_s' || watOp === 'gt_s' || watOp === 'ge_s')) {
      watOp = watOp.replace('_s', '');
    }

    this.write(`${watT}.${watOp}`);
  }

  emitUnary(expr) {
    switch (expr.op) {
      case '-': {
        const watT = this.inferExprWatType(expr.operand);
        if (watT === 'f32' || watT === 'f64') {
          this.emitExpr(expr.operand);
          this.write(`${watT}.neg`);
        } else {
          // Integer negate: 0 - x
          this.write(`${watT}.const 0`);
          this.emitExpr(expr.operand);
          this.write(`${watT}.sub`);
        }
        break;
      }
      case '~': {
        const watT = this.inferExprWatType(expr.operand);
        this.emitExpr(expr.operand);
        const allOnes = watT === 'i64' ? '-1' : '-1';
        this.write(`${watT}.const ${allOnes}`);
        this.write(`${watT}.xor`);
        break;
      }
      case '!':
        // !x = (x == 0)
        this.emitExpr(expr.operand);
        this.write('i32.eqz');
        break;
      case 'ref.as_non_null':
        this.emitExpr(expr.operand);
        this.write('ref.as_non_null');
        break;
    }
  }

  emitCall(expr) {
    // Method calls: emitMethodCall handles args internally
    if (expr.callee.kind === 'MemberExpr') {
      this.emitMethodCall(expr);
      return;
    }

    // Regular function calls — emit args first
    for (const a of expr.args ?? []) this.emitExpr(a);

    // call_indirect: TableName[idx]<Type>(args)
    if (expr.callee.kind === 'IndexExpr' || expr.callee.kind === 'IndexFieldExpr') {
      this.emitExpr(expr.callee.index ?? expr.callee.object);
      const tableName = this.exprStr(expr.callee.object ?? expr.callee);
      const typeArg   = expr.typeArg ? `(type $${this.typeExprName(expr.typeArg)})` : '';
      this.write(`call_indirect ${tableName} ${typeArg}`);
      return;
    }

    // ref.call
    if (expr.callee.kind === 'Ident') {
      const sym = this.symbols.get(expr.callee.name);
      if (sym?.kind === 'FuncDecl') {
        this.write(`call $${expr.callee.name}`);
        return;
      }
      // funcref variable
      this.emitExpr(expr.callee);
      if (expr.typeArg) {
        this.write(`call_ref (type $${this.typeExprName(expr.typeArg)})`);
      } else {
        this.write('call_ref');
      }
      return;
    }

    // Generic: emit callee then call_ref
    this.emitExpr(expr.callee);
    this.write('call_ref');
  }

  emitMethodCall(expr) {
    const obj    = expr.callee.object;
    const method = expr.callee.field;
    const args   = expr.args ?? [];

    // i31ref built-ins
    if (obj.kind === 'Ident' && obj.name === 'i31ref') {
      if (method === 'new') {
        this.emitExpr(args[0]);
        this.write('i31.new');
        return;
      }
      if (method === 'get') {
        this.emitExpr(args[0]);
        this.write('i31.get_s');
        return;
      }
    }

    // Memory instance methods: Mem.load<T>(ptr)
    if (this.symbols.get(obj.name ?? '')?.kind === 'MemoryDecl') {
      this.emitMemoryMethod(obj.name, method, args, expr);
      return;
    }

    // SIMD methods on typed vectors: i32x4.splat(0)
    if (this.isTypeName(obj.name ?? '')) {
      this.emitSIMDMethod(obj.name, method, args, expr);
      return;
    }

    // GC array .length
    if (method === 'length') {
      this.emitExpr(obj);
      this.write('array.len');
      return;
    }

    // Generic instance method call — emit object then call
    this.emitExpr(obj);
    for (const a of args) this.emitExpr(a);
    this.write(`call $${method} ;; method call`);
  }

  emitMemoryMethod(memName, method, args, expr) {
    const typeArg = expr.typeArg;
    const watT    = typeArg ? this.watType(typeArg) : 'i32';
    const mem     = `(memory $${memName})`;

    const loadMap = {
      'load': `${watT}.load`,
      'loadSplat': `v128.load_splat`,
    };

    switch (method) {
      case 'load': {
        this.emitExpr(args[0]);
        const alignment = args[1] ? ` align=${args[1].value}` : '';
        const instr = this.memLoadInstr(typeArg);
        this.write(`${instr} ${mem}${alignment}`);
        break;
      }
      case 'store': {
        this.emitExpr(args[0]); // ptr
        this.emitExpr(args[1]); // value
        const instr = this.memStoreInstr(typeArg);
        this.write(`${instr} ${mem}`);
        break;
      }
      case 'copy':
        this.emitExpr(args[0]);
        this.emitExpr(args[1]);
        this.emitExpr(args[2]);
        this.write(`memory.copy ${mem} ${mem}`);
        break;
      case 'fill':
        this.emitExpr(args[0]);
        this.emitExpr(args[1]);
        this.emitExpr(args[2]);
        this.write(`memory.fill ${mem}`);
        break;
      case 'grow':
        this.emitExpr(args[0]);
        this.write(`memory.grow ${mem}`);
        break;
      case 'size':
        this.write(`memory.size ${mem}`);
        break;
      case 'init': {
        const segName = args[0].name ?? args[0].value;
        this.emitExpr(args[1]);
        this.emitExpr(args[2]);
        this.emitExpr(args[3]);
        this.write(`memory.init $${segName} ${mem}`);
        break;
      }
      default:
        this.write(`i32.const 0 ;; unknown memory method ${method}`);
    }
  }

  memLoadInstr(typeArg) {
    if (!typeArg) return 'i32.load';
    const name = typeArg.name ?? typeArg.kind;
    const map = {
      'i8':  'i32.load8_s', 'u8':  'i32.load8_u',
      'i16': 'i32.load16_s', 'u16': 'i32.load16_u',
      'i32': 'i32.load', 'u32': 'i32.load',
      'i64': 'i64.load', 'u64': 'i64.load',
      'f32': 'f32.load', 'f64': 'f64.load',
      'v128': 'v128.load',
    };
    return map[name] ?? 'i32.load';
  }

  memStoreInstr(typeArg) {
    if (!typeArg) return 'i32.store';
    const name = typeArg.name ?? typeArg.kind;
    const map = {
      'i8': 'i32.store8', 'u8': 'i32.store8',
      'i16': 'i32.store16', 'u16': 'i32.store16',
      'i32': 'i32.store', 'u32': 'i32.store',
      'i64': 'i64.store', 'u64': 'i64.store',
      'f32': 'f32.store', 'f64': 'f64.store',
      'v128': 'v128.store',
    };
    return map[name] ?? 'i32.store';
  }

  emitSIMDMethod(typeName, method, args, expr) {
    // i32x4(1,2,3,4) constructor
    if (method === undefined && args.length > 0) {
      for (const a of args) this.emitExpr(a);
      const shape = typeName;
      this.write(`v128.const ${shape} ${args.map(() => '0').join(' ')} ;; ${typeName} constructor`);
      return;
    }
    switch (method) {
      case 'splat':
        this.emitExpr(args[0]);
        this.write(`${typeName}.splat`);
        break;
      case 'extractLane':
        this.emitExpr(args[0]);
        this.write(`${typeName}.extract_lane ${args[1]?.value ?? 0}`);
        break;
      case 'replaceLane':
        this.emitExpr(args[0]);
        this.emitExpr(args[2]);
        this.write(`${typeName}.replace_lane ${args[1]?.value ?? 0}`);
        break;
      case 'add': case 'sub': case 'mul':
        this.emitExpr(args[0]);
        this.emitExpr(args[1]);
        this.write(`${typeName}.${method}`);
        break;
      case 'shuffle':
        this.emitExpr(args[0]);
        this.emitExpr(args[1]);
        this.write(`i8x16.shuffle ;; lanes`);
        break;
      default:
        this.write(`v128.const i32x4 0 0 0 0 ;; ${typeName}.${method}`);
    }
  }

  emitMember(expr) {
    this.emitExpr(expr.object);
    const typeName = this.structTypeName(expr.object);
    if (typeName) {
      this.write(`struct.get $${typeName} $${expr.field}`);
    } else {
      // Unknown — may be a built-in method reference
      this.write(`struct.get ;; ${expr.field}`);
    }
  }

  emitIndex(expr) {
    this.emitExpr(expr.object);
    this.emitExpr(expr.index);
    const typeName = this.arrayTypeName(expr.object);
    if (typeName) {
      this.write(`array.get $${typeName}`);
    } else {
      // Pointer or memory indexing
      this.write(`i32.add`); // ptr + index (byte arithmetic handled in emitLoad)
      this.write(`i32.load ;; pointer deref`);
    }
  }

  emitIndexField(expr) {
    const typeName = this.structTypeName(expr.object);
    if (typeName) {
      const sym = this.symbols.get(typeName);
      if (sym?.typeExpr && this.isLinear(sym.typeExpr)) {
        // #[linear] struct through pointer: ptr[n].field
        // Address = ptr + n * sizeof(T) + field_offset
        this.emitExpr(expr.object);
        this.emitExpr(expr.index);
        const size = this.computeStructSize(sym.typeExpr, sym.typeExpr.pragmas ?? []);
        this.write(`i32.const ${size}`);
        this.write(`i32.mul`);
        this.write(`i32.add`);
        const offset = this.computeFieldOffset(typeName, expr.field);
        const fieldType = this.getFieldType(typeName, expr.field);
        this.write(`${fieldType}.load offset=${offset}`);
      } else {
        this.emitExpr(expr.object);
        this.emitExpr(expr.index);
        this.write(`struct.get $${typeName} $${expr.field}`);
      }
    }
  }

  /** @param {string} typeName @param {string} fieldName */
  getFieldType(typeName, fieldName) {
    const sym = this.symbols.get(typeName);
    const te  = sym?.typeExpr;
    if (te?.kind !== 'StructType') return 'i32';
    const field = te.fields?.find(f => f.name === fieldName);
    if (!field) return 'i32';
    return this.watType(field.typeExpr);
  }

  emitIfExpr(expr) {
    this.emitExpr(expr.cond);
    this.write('if (result i32)');
    this.indent();
    this.write('then');
    this.indent();
    for (const s of expr.then_ ?? []) {
      if (s.kind === 'ExprStmt') this.emitExpr(s.expr);
      else this.emitStmt(s);
    }
    this.dedent();
    this.write('else');
    this.indent();
    for (const s of expr.else_ ?? []) {
      if (s.kind === 'ExprStmt') this.emitExpr(s.expr);
      else this.emitStmt(s);
    }
    this.dedent();
    this.dedent();
    this.write('end');
  }

  // ── Type helpers ─────────────────────────────────────────────────────────

  /**
   * Convert a WML type expression AST node to its WAT type string.
   * @param {Object} typeExpr
   * @returns {string}
   */
  watType(typeExpr) {
    if (!typeExpr) return 'i32';
    if (typeof typeExpr === 'string') return this.numTypeToWat(typeExpr);
    switch (typeExpr.kind) {
      case 'PrimitiveType': return this.numTypeToWat(typeExpr.name);
      case 'RefType': return typeExpr.name;
      case 'FuncRefType':
        return typeExpr.typeParam ? `(ref $${this.typeExprName(typeExpr.typeParam)})` : 'funcref';
      case 'NamedType': {
        const sym = this.symbols.get(typeExpr.name);
        if (sym?.kind === 'TypeDecl') {
          if (sym.typeExpr?.kind === 'StructType') return `(ref $${typeExpr.name})`;
          if (sym.typeExpr?.kind === 'ArrayType')  return `(ref $${typeExpr.name})`;
          if (sym.typeExpr?.kind === 'FuncType')   return `(ref $${typeExpr.name})`;
        }
        return typeExpr.name;
      }
      case 'PointerType': return 'i32'; // linear memory pointer = i32
      case 'ArrayType':   return 'arrayref';
      case 'FuncType': {
        const parts = this.emitFuncTypeParts(typeExpr);
        return `(func ${parts})`;
      }
      default: return 'i32';
    }
  }

  numTypeToWat(name) {
    const map = {
      i8: 'i32', i16: 'i32', i32: 'i32', i64: 'i64',
      isize: 'i32', u8: 'i32', u16: 'i32', u32: 'i32', u64: 'i64', usize: 'i32',
      f32: 'f32', f64: 'f64', v128: 'v128',
      i8x16: 'v128', i16x8: 'v128', i32x4: 'v128', i64x2: 'v128',
      f32x4: 'v128', f64x2: 'v128',
    };
    return map[name] ?? 'i32';
  }

  inferExprWatType(expr) {
    if (!expr) return 'i32';
    switch (expr.kind) {
      case 'IntLit':   return this.numTypeToWat(expr.numType ?? 'i32');
      case 'FloatLit': return expr.numType === 'f32' ? 'f32' : 'f64';
      case 'Ident': {
        // Check local/param scope first (populated per-function in emitFunc)
        if (this.currentLocals.has(expr.name)) return this.currentLocals.get(expr.name);
        const sym = this.symbols.get(expr.name);
        if (sym?.kind === 'GlobalDecl') return this.watType(sym.typeExpr);
        if (sym?.kind === 'FuncDecl') return 'funcref';
        return 'i32';
      }
      case 'BinaryExpr': return this.inferExprWatType(expr.left);
      case 'UnaryExpr':  return this.inferExprWatType(expr.operand);
      case 'CastExpr':   return this.watType(expr.toType);
      case 'CallExpr': {
        const callee = expr.callee;
        if (callee.kind === 'Ident') {
          const sym = this.symbols.get(callee.name);
          if (sym?.kind === 'FuncDecl' && (sym.results ?? []).length === 1)
            return this.watType(sym.results[0]);
        }
        return 'i32';
      }
      default: return 'i32';
    }
  }

  structTypeName(expr) {
    if (!expr) return null;
    if (expr.kind === 'Ident') {
      // Check function-level params/locals first
      const te = this.currentTypeMap?.get(expr.name);
      if (te) {
        if (te?.kind === 'NamedType') return te.name;
        if (te?.kind === 'PointerType' && te.baseType?.kind === 'NamedType') {
          return te.baseType.name;
        }
        return null;
      }
      // Then check module-level symbols
      const sym = this.symbols.get(expr.name);
      if (sym?.kind === 'LocalDecl' || sym?.kind === 'Param' || sym?.kind === 'GlobalDecl') {
        const type = sym.typeExpr;
        if (type?.kind === 'NamedType') return type.name;
        if (type?.kind === 'PointerType' && type.baseType?.kind === 'NamedType') {
          return type.baseType.name;
        }
      }
    }
    return null;
  }

  /** Get byte size of a field type expression (no padding). */
  fieldRawSize(typeExpr) {
    const sizeMap = {
      'i8':1, 'u8':1, 'i16':2, 'u16':2, 'i32':4, 'u32':4, 'i64':8, 'u64':8,
      'f32':4, 'f64':8, 'isize':4, 'usize':4, 'v128':16,
    };
    if (!typeExpr) return 4;
    if (typeExpr.kind === 'PrimitiveType') return sizeMap[typeExpr.name] ?? 4;
    if (typeExpr.kind === 'PointerType')   return 4;
    if (typeExpr.kind === 'NamedType') {
      const sym = this.symbols.get(typeExpr.name);
      if (sym?.typeExpr?.kind === 'StructType') {
        return this.computeStructSize(sym.typeExpr, sym.typeExpr.pragmas ?? []);
      }
      return 4;
    }
    return 4;
  }

  /** Natural alignment of a field type expression in bytes. */
  fieldAlign(typeExpr, repr) {
    if (repr === 'packed') return 1;
    const size = this.fieldRawSize(typeExpr);
    return Math.min(size, 8);
  }

  /**
   * Compute total struct size with alignment padding.
   * @param {Object} structTypeExpr - AST StructType node
   * @param {Object[]} pragmas
   * @returns {number}
   */
  computeStructSize(structTypeExpr, pragmas) {
    const repr = this.resolveRepr(pragmas);
    let size = 0;
    let maxAlign = 1;
    for (const f of structTypeExpr.fields ?? []) {
      const fs = this.fieldRawSize(f.typeExpr);
      const fa = this.fieldAlign(f.typeExpr, repr);
      maxAlign = Math.max(maxAlign, fa);
      if (fa > 1) size = Math.ceil(size / fa) * fa;
      size += fs;
    }
    if (repr !== 'packed' && maxAlign > 1) {
      size = Math.ceil(size / maxAlign) * maxAlign;
    }
    return size;
  }

  /**
   * Compute byte offset of a named field within a struct.
   * @param {string} typeName
   * @param {string} fieldName
   * @returns {number}
   */
  computeFieldOffset(typeName, fieldName) {
    const sym = this.symbols.get(typeName);
    const te  = sym?.typeExpr;
    if (te?.kind !== 'StructType') return 0;
    const repr = this.resolveRepr(te.pragmas ?? []);
    let offset = 0;
    let maxAlign = 1;
    for (const f of te.fields ?? []) {
      const fs = this.fieldRawSize(f.typeExpr);
      const fa = this.fieldAlign(f.typeExpr, repr);
      maxAlign = Math.max(maxAlign, fa);
      if (fa > 1) offset = Math.ceil(offset / fa) * fa;
      if (f.name === fieldName) return offset;
      offset += fs;
    }
    return 0;
  }

  arrayTypeName(expr) {
    if (!expr) return null;
    if (expr.kind === 'Ident') {
      // Check function-level params/locals first
      const te = this.currentTypeMap?.get(expr.name);
      if (te) {
        if (te?.kind === 'NamedType') {
          const td = this.symbols.get(te.name);
          if (td?.typeExpr?.kind === 'ArrayType') return te.name;
        }
        return null;
      }
      // Then check module-level symbols
      const sym = this.symbols.get(expr.name);
      const type = sym?.typeExpr;
      if (type?.kind === 'NamedType') {
        const td = this.symbols.get(type.name);
        if (td?.typeExpr?.kind === 'ArrayType') return type.name;
      }
    }
    return null;
  }

  sizeofType(typeExpr) {
    const sizeMap = {
      'i8':1, 'u8':1, 'i16':2, 'u16':2, 'i32':4, 'u32':4, 'i64':8, 'u64':8,
      'f32':4, 'f64':8, 'isize':4, 'usize':4, 'v128':16,
    };
    if (typeExpr?.kind === 'PrimitiveType') return sizeMap[typeExpr.name] ?? 4;
    if (typeExpr?.kind === 'PointerType')   return 4;
    if (typeExpr?.kind === 'NamedType') {
      const sym = this.symbols.get(typeExpr.name);
      if (sym?.typeExpr?.kind === 'StructType') {
        return this.computeStructSize(sym.typeExpr, sym.typeExpr.pragmas ?? []);
      }
    }
    return 4;
  }

  exprStr(expr) {
    if (!expr) return '';
    if (expr.kind === 'Ident') {
      const sym = this.symbols.get(expr.name);
      if (sym?.kind === 'TableDecl') return `$${expr.name}`;
      return `$${expr.name}`;
    }
    return '';
  }

  exprHasValue(expr) {
    if (!expr) return false;
    if (expr.kind === 'CallExpr') {
      const callee = expr.callee;
      if (callee.kind === 'Ident') {
        const sym = this.symbols.get(callee.name);
        if (sym?.kind === 'FuncDecl') return (sym.results?.length ?? 0) > 0;
      }
      if (callee.kind === 'MemberExpr') {
        const obj = callee.object;
        if (obj.kind === 'Ident') {
          const sym = this.symbols.get(obj.name);
          if (sym?.kind === 'MemoryDecl') {
            const voidMemMethods = new Set(['store', 'copy', 'fill', 'init']);
            return !voidMemMethods.has(callee.field);
          }
        }
      }
    }
    return true;
  }

  isTypeName(name) {
    const simdNames = new Set(['i8x16','i16x8','i32x4','i64x2','f32x4','f64x2',
      'i8','i16','i32','i64','f32','f64','u8','u16','u32','u64']);
    return simdNames.has(name);
  }
}
