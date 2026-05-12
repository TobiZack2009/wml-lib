/**
 * @fileoverview WML recursive descent parser.
 *
 * Converts a token stream from the lexer into an AST.
 * Uses recursive descent with explicit error recovery:
 *   - Missing delimiters are synthesized
 *   - Bad expressions skip to the next statement boundary
 *   - Bad declarations skip to the next top-level boundary
 *   - ErrorNode is inserted where recovery occurred
 *
 * Operator precedence (C-like, lowest to highest):
 *   1.  ||
 *   2.  &&
 *   3.  == !=
 *   4.  < > <= >=
 *   5.  |
 *   6.  ^
 *   7.  &
 *   8.  << >>s >>u
 *   9.  + -
 *   10. * /s /u %s %u
 *   11. Unary: - ~ !
 *   12. Postfix: . [] () as is
 *
 * @example
 * import { Lexer } from './lexer.js';
 * import { Parser } from './parser.js';
 * const tokens = new Lexer(source, 'module.wml').tokenize();
 * const { ast, errors } = new Parser(tokens, 'module.wml').parse();
 */

import { T } from './tokens.js';
import * as AST from './ast.js';

const STMT_RECOVERY = new Set([T.SEMI, T.RBRACE, T.KW_LOCAL, T.KW_GLOBAL,
  T.KW_RETURN, T.KW_IF, T.KW_LOOP, T.KW_BREAK, T.KW_GOTO,
  T.KW_TRY, T.KW_THROW, T.KW_UNREACHABLE, T.KW_NOP, T.EOF]);

const DECL_RECOVERY = new Set([T.KW_TYPE, T.KW_MEMORY, T.KW_TABLE, T.KW_DATA,
  T.KW_ELEM, T.KW_TAG, T.KW_SECTION, T.KW_REC, T.AT_EXPORT, T.AT_IMPORT,
  T.AT_START, T.PRAGMA_OPEN, T.IDENT, T.EOF]);

export class Parser {
  /**
   * @param {import('./lexer.js').Token[]} tokens
   * @param {string} [file='source']
   */
  constructor(tokens, file = 'source') {
    this.tokens = tokens;
    this.file = file;
    this.pos = 0;
    /** @type {import('../diagnostics/errors.js').Diagnostic[]} */
    this.errors = [];
  }

  // ── Token navigation ────────────────────────────────────────────────────

  peek() { return this.tokens[this.pos] ?? { type: T.EOF, value: '', line: 0, col: 0, file: this.file }; }
  peekType() { return this.peek().type; }
  peekAt(n) { return this.tokens[this.pos + n] ?? { type: T.EOF, value: '', line: 0, col: 0, file: this.file }; }

  advance() {
    const tok = this.peek();
    if (tok.type !== T.EOF) this.pos++;
    return tok;
  }

  check(type) { return this.peekType() === type; }

  checkAny(...types) { return types.includes(this.peekType()); }

  eat(type) {
    if (this.check(type)) return this.advance();
    return null;
  }

  expect(type, hint = null) {
    if (this.check(type)) return this.advance();
    const tok = this.peek();
    this.error('E001', `Expected '${type}', found '${tok.value || tok.type}'`, tok, hint);
    return { type, value: '', line: tok.line, col: tok.col, file: this.file };
  }

  loc(tok) {
    return AST.locFrom(tok);
  }

  spanFrom(tok) {
    const cur = this.tokens[this.pos - 1] ?? tok;
    return AST.span(AST.locFrom(tok), AST.locFrom(cur));
  }

  // ── Error handling ──────────────────────────────────────────────────────

  error(code, message, tok, hint = null) {
    const loc = AST.locFrom(tok);
    this.errors.push({
      code,
      category: 'SyntaxError',
      kind: code,
      severity: 'error',
      message,
      detail: message,
      hint,
      location: loc,
      recovered: false,
    });
  }

  skipTo(recovery) {
    while (!this.check(T.EOF) && !recovery.has(this.peekType())) this.advance();
  }

  // ── Top level ───────────────────────────────────────────────────────────

  /**
   * Parse the entire module.
   * @returns {{ ast: Object, errors: Object[] }}
   */
  parse() {
    const start = this.peek();
    const decls = [];
    while (!this.check(T.EOF)) {
      try {
        const decl = this.parseDecl();
        if (decl) decls.push(decl);
      } catch (e) {
        // Internal error — skip to next declaration boundary
        this.skipTo(DECL_RECOVERY);
        if (!this.check(T.EOF)) this.advance();
      }
    }
    return {
      ast: AST.module_(decls, this.loc(start)),
      errors: this.errors,
    };
  }

  // ── Decorators and pragmas ──────────────────────────────────────────────

  parseDecorators() {
    const decorators = [];
    while (true) {
      if (this.check(T.AT_EXPORT)) {
        const tok = this.advance();
        decorators.push({ kind: 'Decorator', name: 'export', args: [], loc: this.loc(tok) });
      } else if (this.check(T.AT_IMPORT)) {
        const tok = this.advance();
        this.expect(T.LPAREN);
        const mod = this.expect(T.STRING_LIT).value;
        this.expect(T.COMMA);
        const name = this.expect(T.STRING_LIT).value;
        this.expect(T.RPAREN);
        decorators.push({ kind: 'Decorator', name: 'import', args: [mod, name], loc: this.loc(tok) });
      } else if (this.check(T.AT_START)) {
        const tok = this.advance();
        decorators.push({ kind: 'Decorator', name: 'start', args: [], loc: this.loc(tok) });
      } else if (this.check(T.AT_TAIL)) {
        const tok = this.advance();
        decorators.push({ kind: 'Decorator', name: 'tail', args: [], loc: this.loc(tok) });
      } else {
        break;
      }
    }
    return decorators;
  }

  parsePragmas() {
    const pragmas = [];
    while (this.check(T.PRAGMA_OPEN)) {
      const tok = this.advance(); // consume #[
      // Pragma name can be any identifier or keyword (e.g. repr, packed, C)
      const nameTok = this.peek();
      const name = nameTok.value;
      this.advance(); // consume name token (could be keyword or ident)
      const args = [];
      if (this.eat(T.LPAREN)) {
        while (!this.check(T.RPAREN) && !this.check(T.EOF)) {
          // Arg can be keyword (packed, C) or ident
          const argTok = this.peek();
          args.push(AST.ident(argTok.value, this.loc(argTok)));
          this.advance();
          if (!this.eat(T.COMMA)) break;
        }
        this.expect(T.RPAREN);
      }
      this.expect(T.RBRACKET);
      pragmas.push(AST.pragma(name, args, this.loc(tok)));
    }
    return pragmas;
  }

  // ── Declarations ────────────────────────────────────────────────────────

  parseDecl() {
    const pragmas = this.parsePragmas();
    const decorators = this.parseDecorators();

    switch (this.peekType()) {
      case T.KW_TYPE:    return this.parseTypeDecl(decorators);
      case T.KW_MEMORY:  return this.parseMemoryDecl(decorators);
      case T.KW_SHARED: {
        if (this.peekAt(1).type === T.KW_MEMORY) return this.parseMemoryDecl(decorators);
        if (this.peekAt(1).type === T.KW_TABLE)  return this.parseTableDecl(decorators);
        break;
      }
      case T.KW_TABLE:   return this.parseTableDecl(decorators);
      case T.KW_GLOBAL:  return this.parseGlobalDecl(decorators);
      case T.KW_DATA:    return this.parseDataDecl();
      case T.KW_ELEM:    return this.parseElemDecl();
      case T.KW_TAG:     return this.parseTagDecl(decorators);
      case T.KW_SECTION: return this.parseSectionDecl();
      case T.KW_REC:     return this.parseRecGroup();
      case T.IDENT: {
        // Function declaration or memory placement
        return this.parseFuncOrPlacement(decorators, pragmas);
      }
      // Memory placement: MemName[offset] = ...
      default: {
        const tok = this.peek();
        this.error('E001', `Unexpected token '${tok.value || tok.type}' at top level`, tok);
        this.skipTo(DECL_RECOVERY);
        return AST.errorNode('E001', this.loc(tok));
      }
    }
  }

  parseTypeDecl(decorators) {
    const tok = this.advance(); // consume 'type'
    const name = this.expect(T.IDENT, 'type declarations need a name: type Name = ...').value;
    this.expect(T.ASSIGN);
    const typeExpr = this.parseTypeExpr();
    this.expect(T.SEMI);
    return AST.typeDecl(name, typeExpr, this.loc(tok));
  }

  parseMemoryDecl(decorators) {
    const isShared = !!this.eat(T.KW_SHARED);
    const tok = this.advance(); // consume 'memory'
    const name = this.expect(T.IDENT).value;
    this.expect(T.ASSIGN);
    const min = parseInt(this.expect(T.INT_LIT).value, 10);
    let max = null;
    if (this.eat(T.DOTDOT)) {
      max = parseInt(this.expect(T.INT_LIT).value, 10);
    }
    this.expect(T.SEMI);
    return AST.memoryDecl(name, min, max, isShared, decorators, this.loc(tok));
  }

  parseTableDecl(decorators) {
    const isShared = !!this.eat(T.KW_SHARED);
    const tok = this.advance(); // consume 'table'
    const name = this.expect(T.IDENT).value;
    this.expect(T.COLON);
    this.expect(T.LBRACKET);
    const elemType = this.parseTypeExpr();
    this.expect(T.RBRACKET);
    this.expect(T.ASSIGN);
    const min = parseInt(this.expect(T.INT_LIT).value, 10);
    let max = null;
    if (this.eat(T.DOTDOT)) {
      max = parseInt(this.expect(T.INT_LIT).value, 10);
    }
    this.expect(T.SEMI);
    return AST.tableDecl(name, elemType, min, max, isShared, decorators, this.loc(tok));
  }

  parseGlobalDecl(decorators) {
    const tok = this.advance(); // consume 'global'
    const isMut = !!this.eat(T.KW_MUT);
    const name = this.expect(T.IDENT).value;
    this.expect(T.COLON);
    const typeExpr = this.parseTypeExpr();
    let init = null;
    if (this.eat(T.ASSIGN)) {
      init = this.parseExpr();
    }
    this.expect(T.SEMI);
    return AST.globalDecl(name, typeExpr, init, isMut, decorators, this.loc(tok));
  }

  parseDataDecl() {
    const tok = this.advance(); // consume 'data'
    const name = this.expect(T.IDENT).value;
    let dataType = null;
    if (this.eat(T.COLON)) {
      dataType = this.parseDataType();
    }
    this.expect(T.ASSIGN);
    const items = this.parseDataItems();
    this.expect(T.SEMI);
    return AST.dataDecl(name, dataType, items, this.loc(tok));
  }

  parseElemDecl() {
    const tok = this.advance(); // consume 'elem'
    const isDeclare = this.peek().value === 'declare' && this.eat(T.IDENT) != null;
    const name = isDeclare ? 'declare' : this.expect(T.IDENT).value;
    let elemType = null;
    if (this.eat(T.COLON)) {
      elemType = this.parseTypeExpr();
      this.expect(T.LBRACKET); this.expect(T.RBRACKET); // consume []
    }
    this.expect(T.ASSIGN);
    const items = this.parseElemItems();
    this.expect(T.SEMI);
    return AST.elemDecl(name, elemType, items, isDeclare, this.loc(tok));
  }

  parseTagDecl(decorators) {
    const tok = this.advance(); // consume 'tag'
    const name = this.expect(T.IDENT).value;
    this.expect(T.COLON);
    this.expect(T.LPAREN);
    const params = [];
    while (!this.check(T.RPAREN) && !this.check(T.EOF)) {
      params.push(this.parseTypeExpr());
      if (!this.eat(T.COMMA)) break;
    }
    this.expect(T.RPAREN);
    this.expect(T.SEMI);
    return AST.tagDecl(name, params, decorators, this.loc(tok));
  }

  parseSectionDecl() {
    const tok = this.advance(); // consume 'section'
    let builtinName = null;
    let customName = null;

    if (this.check(T.AT_DEBUG)) {
      this.advance();
      builtinName = 'debug';
      this.expect(T.SEMI);
      return AST.sectionDecl(builtinName, null, [], this.loc(tok));
    }

    customName = this.expect(T.STRING_LIT).value;
    const items = [];
    if (this.eat(T.LBRACE)) {
      while (!this.check(T.RBRACE) && !this.check(T.EOF)) {
        items.push(this.parseDataItem());
        if (!this.eat(T.COMMA)) break;
      }
      this.expect(T.RBRACE);
    }
    return AST.sectionDecl(null, customName, items, this.loc(tok));
  }

  parseRecGroup() {
    const tok = this.advance(); // consume 'rec'
    this.expect(T.LBRACE);
    const types = [];
    while (!this.check(T.RBRACE) && !this.check(T.EOF)) {
      if (this.check(T.KW_TYPE)) {
        types.push(this.parseTypeDecl([]));
      } else {
        this.error('E001', 'Expected type declaration inside rec block', this.peek());
        this.skipTo(new Set([T.KW_TYPE, T.RBRACE, T.EOF]));
      }
    }
    this.expect(T.RBRACE);
    return AST.recGroup(types, this.loc(tok));
  }

  // ── Function or memory/table placement ─────────────────────────────────

  parseFuncOrPlacement(decorators, pragmas) {
    // Lookahead: if IDENT followed by '[', it could be placement MemName[offset] = ...
    // If IDENT followed by '(' or ':' it's a function
    const nameTok = this.advance(); // consume IDENT
    const name = nameTok.value;

    if (this.check(T.LBRACKET)) {
      // Memory or table placement: Name[offset] = items;
      return this.parsePlacement(name, nameTok);
    }

    // Function declaration
    return this.parseFuncDecl(name, nameTok, decorators, pragmas);
  }

  parsePlacement(name, nameTok) {
    this.expect(T.LBRACKET);
    const offset = this.parseExpr();
    this.expect(T.RBRACKET);
    this.expect(T.ASSIGN);
    const items = this.parseDataItems();
    this.expect(T.SEMI);
    // Determine if it's memory or table by the item type — resolved in validator
    return AST.memoryInit(name, offset, items, this.loc(nameTok));
  }

  parseFuncDecl(name, nameTok, decorators, pragmas) {
    let params = [];
    let results = [];
    let typeRef = null;

    if (this.check(T.COLON)) {
      // function name: TypeRef { ... }  — using a typedef
      this.advance();
      typeRef = this.parseTypeExpr();
    } else {
      // function name(params): results { ... }
      this.expect(T.LPAREN, 'Expected parameter list or type reference');
      params = this.parseParamList();
      this.expect(T.RPAREN);
      this.expect(T.COLON);
      results = this.parseReturnType();
    }

    // Import — no body
    if (this.check(T.SEMI)) {
      this.advance();
      return AST.funcDecl(name, params, results, typeRef, [], [], decorators, this.loc(nameTok));
    }

    // Body
    this.expect(T.LBRACE);
    const locals = this.parseLocalDecls();
    const body = this.parseStmtList();
    this.expect(T.RBRACE);

    return AST.funcDecl(name, params, results, typeRef, locals, body, decorators, this.loc(nameTok));
  }

  parseParamList() {
    const params = [];
    while (!this.check(T.RPAREN) && !this.check(T.EOF)) {
      const pTok = this.peek();
      const pName = this.expect(T.IDENT, 'Expected parameter name').value;
      this.expect(T.COLON);
      const pType = this.parseTypeExpr();
      params.push(AST.param(pName, pType, this.loc(pTok)));
      if (!this.eat(T.COMMA)) break;
    }
    return params;
  }

  parseReturnType() {
    if (this.check(T.LPAREN)) {
      this.advance();
      if (this.check(T.RPAREN)) {
        this.advance();
        return []; // ()  — no return
      }
      const types = [];
      while (!this.check(T.RPAREN) && !this.check(T.EOF)) {
        types.push(this.parseTypeExpr());
        if (!this.eat(T.COMMA)) break;
      }
      this.expect(T.RPAREN);
      return types;
    }
    return [this.parseTypeExpr()];
  }

  parseLocalDecls() {
    const locals = [];
    while (this.check(T.KW_LOCAL)) {
      const tok = this.advance();
      this.eat(T.KW_MUT); // mut is optional on locals
      const name = this.expect(T.IDENT).value;
      this.expect(T.COLON);
      const typeExpr = this.parseTypeExpr();
      let init = null;
      if (this.eat(T.ASSIGN)) init = this.parseExpr();
      this.expect(T.SEMI);
      locals.push(AST.localDecl(name, typeExpr, init, this.loc(tok)));
    }
    return locals;
  }

  // ── Statements ──────────────────────────────────────────────────────────

  parseStmtList() {
    const stmts = [];
    let prevPos = -1;
    while (!this.check(T.RBRACE) && !this.check(T.EOF)) {
      // Safety guard: if position didn't advance, force-skip to prevent infinite loop
      if (this.pos === prevPos) {
        this.error('E001', `Unexpected token '${this.peek().value || this.peek().type}'`, this.peek());
        this.advance();
        continue;
      }
      prevPos = this.pos;
      const stmt = this.parseStmt();
      if (stmt) stmts.push(stmt);
    }
    return stmts;
  }

  parseStmt() {
    const tok = this.peek();
    switch (tok.type) {
      case T.KW_RETURN:  return this.parseReturn();
      case T.KW_IF:      return this.parseIfStmt();
      case T.KW_LOOP:    return this.parseLoopStmt();
      case T.KW_BREAK:   return this.parseBreak();
      case T.KW_GOTO:    return this.parseGoto();
      case T.KW_TRY:     return this.parseTryStmt();
      case T.KW_THROW:   return this.parseThrow();
      case T.KW_UNREACHABLE: {
        this.advance(); this.expect(T.SEMI);
        return AST.unreachableStmt(this.loc(tok));
      }
      case T.KW_NOP: {
        this.advance(); this.expect(T.SEMI);
        return AST.nopStmt(this.loc(tok));
      }
      case T.KW_LOCAL: {
        this.error('E218', 'Variable declarations must appear at the top of a function, before any statements', tok,
          'Move this declaration to the top of the function body');
        this.advance(); // consume 'local' so we don't loop infinitely
        this.skipTo(new Set([T.SEMI, T.RBRACE, T.EOF]));
        this.eat(T.SEMI);
        return AST.errorNode('E218', this.loc(tok));
      }
      default:
        return this.parseExprOrAssignStmt();
    }
  }

  parseReturn() {
    const tok = this.advance(); // consume 'return'
    if (this.check(T.KW_TAIL)) {
      this.advance();
      // callee is just the function reference — do NOT call parsePostfixExpr
      // because it would consume the '(' making it a CallExpr already
      const calleeTok = this.peek();
      const callee = this.parsePostfixExpr();
      // If callee is already a CallExpr (parsed the () itself), use it directly
      if (callee.kind === 'CallExpr') {
        this.expect(T.SEMI);
        return AST.returnTailStmt(callee.callee, callee.args, this.loc(tok));
      }
      // Otherwise expect explicit argument list
      this.expect(T.LPAREN);
      const args = this.parseArgList();
      this.expect(T.RPAREN);
      this.expect(T.SEMI);
      return AST.returnTailStmt(callee, args, this.loc(tok));
    }

    if (this.check(T.SEMI)) {
      this.advance();
      return AST.returnStmt([], this.loc(tok));
    }

    // Check for explicit multi-value tuple return: return (a, b);
    // Only treat as tuple if the ( contains a comma before the )
    if (this.check(T.LPAREN) && this.peekAt(1).type !== T.RPAREN) {
      const saved = this.pos;
      this.advance(); // consume (
      const first = this.parseExpr();
      if (this.check(T.COMMA)) {
        // Definitely a multi-value tuple: return (a, b, c)
        const values = [first];
        while (this.eat(T.COMMA)) values.push(this.parseExpr());
        this.expect(T.RPAREN);
        this.expect(T.SEMI);
        return AST.returnStmt(values, this.loc(tok));
      }
      // Not a tuple — backtrack and fall through to parseExpr
      this.pos = saved;
    }

    const value = this.parseExpr();
    this.expect(T.SEMI);
    return AST.returnStmt([value], this.loc(tok));
  }

  parseIfStmt() {
    const tok = this.advance(); // consume 'if'
    this.expect(T.LPAREN);
    const cond = this.parseExpr();
    this.expect(T.RPAREN);
    this.expect(T.LBRACE);
    const then_ = this.parseStmtList();
    this.expect(T.RBRACE);
    let else_ = null;
    if (this.eat(T.KW_ELSE)) {
      if (this.check(T.KW_IF)) {
        else_ = [this.parseIfStmt()];
      } else {
        this.expect(T.LBRACE);
        else_ = this.parseStmtList();
        this.expect(T.RBRACE);
      }
    }
    return AST.ifStmt(cond, then_, else_, this.loc(tok));
  }

  parseLoopStmt() {
    const tok = this.advance(); // consume 'loop'
    this.expect(T.LBRACE);
    const blocks = [];
    while (!this.check(T.RBRACE) && !this.check(T.EOF)) {
      blocks.push(this.parseLoopBlock());
    }
    this.expect(T.RBRACE);
    return AST.loopStmt(blocks, this.loc(tok));
  }

  parseLoopBlock() {
    const tok = this.expect(T.LBRACE);
    const labels = [];
    const stmts = [];

    // A block is a sequence of: label definitions and statements
    while (!this.check(T.RBRACE) && !this.check(T.EOF)) {
      if (this.check(T.LABEL)) {
        labels.push({ label: this.peek().value, pos: stmts.length, loc: this.loc(this.peek()) });
        this.advance();
      } else if (this.check(T.KW_LOCAL)) {
        this.error('E218', 'Variable declarations are not allowed inside loop blocks', this.peek());
        this.advance(); // consume 'local'
        this.skipTo(new Set([T.SEMI, T.RBRACE, T.EOF]));
        this.eat(T.SEMI);
      } else {
        stmts.push(this.parseStmt());
      }
    }
    this.expect(T.RBRACE);
    return AST.loopBlock(labels, stmts, this.loc(tok));
  }

  parseBreak() {
    const tok = this.advance(); // consume 'break'
    let cond = null;
    if (this.check(T.KW_IF)) {
      this.advance();
      this.expect(T.LPAREN);
      cond = this.parseExpr();
      this.expect(T.RPAREN);
    }
    this.expect(T.SEMI);
    return AST.breakStmt(cond, this.loc(tok));
  }

  parseGoto() {
    const tok = this.advance(); // consume 'goto'
    // goto ['a, 'b, 'c] idx  — table goto
    if (this.check(T.LBRACKET)) {
      this.advance();
      const labels = [];
      while (this.check(T.LABEL)) {
        labels.push(this.advance().value);
        if (!this.eat(T.COMMA)) break;
      }
      this.expect(T.RBRACKET);
      const idx = this.parseExpr();
      let cond = null;
      if (this.check(T.KW_IF)) {
        this.advance();
        this.expect(T.LPAREN);
        cond = this.parseExpr();
        this.expect(T.RPAREN);
      }
      this.expect(T.SEMI);
      return AST.gotoTableStmt(labels, idx, this.loc(tok));
    }

    const label = this.expect(T.LABEL).value;
    let cond = null;
    if (this.check(T.KW_IF)) {
      this.advance();
      this.expect(T.LPAREN);
      cond = this.parseExpr();
      this.expect(T.RPAREN);
    }
    this.expect(T.SEMI);
    return AST.gotoStmt(label, cond, this.loc(tok));
  }

  parseTryStmt() {
    const tok = this.advance(); // consume 'try'
    this.expect(T.LBRACE);
    const body = this.parseStmtList();
    this.expect(T.RBRACE);
    const catches = [];
    while (this.check(T.KW_CATCH)) {
      catches.push(this.parseCatchClause());
    }
    return AST.tryStmt(body, catches, this.loc(tok));
  }

  parseCatchClause() {
    const tok = this.advance(); // consume 'catch'
    // catch { } — catch-all no binding
    if (this.check(T.LBRACE)) {
      this.advance();
      const body = this.parseStmtList();
      this.expect(T.RBRACE);
      return AST.catchClause(null, [], body, null, this.loc(tok));
    }
    // catch (exn) { } — catch-all with binding
    if (this.check(T.LPAREN)) {
      this.advance();
      const bindName = this.expect(T.IDENT).value;
      this.expect(T.RPAREN);
      // Route style: catch (exn) => break label
      if (this.check(T.FAT_ARROW)) {
        this.advance();
        this.expect(T.KW_BREAK);
        const label = this.expect(T.LABEL).value;
        this.expect(T.SEMI);
        return AST.catchClause(null, [bindName], null, label, this.loc(tok));
      }
      this.expect(T.LBRACE);
      const body = this.parseStmtList();
      this.expect(T.RBRACE);
      return AST.catchClause(null, [bindName], body, null, this.loc(tok));
    }
    // catch TagName(a, b) { } or => break label
    const tagName = this.expect(T.IDENT).value;
    this.expect(T.LPAREN);
    const params = [];
    while (!this.check(T.RPAREN) && !this.check(T.EOF)) {
      params.push(this.expect(T.IDENT).value);
      if (!this.eat(T.COMMA)) break;
    }
    this.expect(T.RPAREN);
    if (this.check(T.FAT_ARROW)) {
      this.advance();
      this.expect(T.KW_BREAK);
      const label = this.expect(T.LABEL).value;
      this.expect(T.SEMI);
      return AST.catchClause(tagName, params, null, label, this.loc(tok));
    }
    this.expect(T.LBRACE);
    const body = this.parseStmtList();
    this.expect(T.RBRACE);
    return AST.catchClause(tagName, params, body, null, this.loc(tok));
  }

  parseThrow() {
    const tok = this.advance(); // consume 'throw'
    const tag = this.parseExpr();
    // throw exn — throw_ref
    if (this.check(T.SEMI)) {
      this.advance();
      return AST.throwStmt(tag, [], this.loc(tok));
    }
    // throw TagName(args)
    this.expect(T.LPAREN);
    const args = this.parseArgList();
    this.expect(T.RPAREN);
    this.expect(T.SEMI);
    return AST.throwStmt(tag, args, this.loc(tok));
  }

  parseExprOrAssignStmt() {
    const expr = this.parseExpr();
    // Assignment: expr = value or expr += value etc.
    const assignOps = new Set([T.ASSIGN, T.PLUS_ASSIGN, T.MINUS_ASSIGN, T.STAR_ASSIGN]);
    if (assignOps.has(this.peekType())) {
      const op = this.advance().value;
      const value = this.parseExpr();
      this.expect(T.SEMI);
      return AST.assignStmt(expr, value, op, expr.loc);
    }
    this.expect(T.SEMI);
    return AST.exprStmt(expr, expr.loc);
  }

  // ── Expressions ─────────────────────────────────────────────────────────

  parseExpr() { return this.parseOr(); }

  parseOr() {
    let left = this.parseAnd();
    while (this.check(T.OR)) {
      const op = this.advance().value;
      left = AST.binaryExpr(op, left, this.parseAnd(), left.loc);
    }
    return left;
  }

  parseAnd() {
    let left = this.parseEquality();
    while (this.check(T.AND)) {
      const op = this.advance().value;
      left = AST.binaryExpr(op, left, this.parseEquality(), left.loc);
    }
    return left;
  }

  parseEquality() {
    let left = this.parseComparison();
    while (this.checkAny(T.EQ, T.NEQ)) {
      const op = this.advance().value;
      left = AST.binaryExpr(op, left, this.parseComparison(), left.loc);
    }
    return left;
  }

  parseComparison() {
    let left = this.parseBitOr();
    while (this.checkAny(T.LT, T.GT, T.LTE, T.GTE)) {
      const op = this.advance().value;
      left = AST.binaryExpr(op, left, this.parseBitOr(), left.loc);
    }
    return left;
  }

  parseBitOr() {
    let left = this.parseBitXor();
    while (this.check(T.PIPE)) {
      const op = this.advance().value;
      left = AST.binaryExpr(op, left, this.parseBitXor(), left.loc);
    }
    return left;
  }

  parseBitXor() {
    let left = this.parseBitAnd();
    while (this.check(T.CARET)) {
      const op = this.advance().value;
      left = AST.binaryExpr(op, left, this.parseBitAnd(), left.loc);
    }
    return left;
  }

  parseBitAnd() {
    let left = this.parseShift();
    while (this.check(T.AMP)) {
      const op = this.advance().value;
      left = AST.binaryExpr(op, left, this.parseShift(), left.loc);
    }
    return left;
  }

  parseShift() {
    let left = this.parseAddSub();
    while (this.checkAny(T.SHL, T.SHR_S, T.SHR_U)) {
      const op = this.advance().value;
      left = AST.binaryExpr(op, left, this.parseAddSub(), left.loc);
    }
    return left;
  }

  parseAddSub() {
    let left = this.parseMulDiv();
    while (this.checkAny(T.PLUS, T.MINUS)) {
      const op = this.advance().value;
      left = AST.binaryExpr(op, left, this.parseMulDiv(), left.loc);
    }
    return left;
  }

  parseMulDiv() {
    let left = this.parseUnary();
    while (this.checkAny(T.STAR, T.SLASH_S, T.SLASH_U, T.PERCENT_S, T.PERCENT_U)) {
      const op = this.advance().value;
      left = AST.binaryExpr(op, left, this.parseUnary(), left.loc);
    }
    return left;
  }

  parseUnary() {
    const tok = this.peek();
    if (this.check(T.MINUS)) {
      this.advance();
      return AST.unaryExpr('-', this.parseUnary(), this.loc(tok));
    }
    if (this.check(T.TILDE)) {
      this.advance();
      return AST.unaryExpr('~', this.parseUnary(), this.loc(tok));
    }
    if (this.check(T.BANG)) {
      this.advance();
      return AST.unaryExpr('!', this.parseUnary(), this.loc(tok));
    }
    return this.parsePostfixExpr();
  }

  parsePostfixExpr() {
    let expr = this.parsePrimaryExpr();

    while (true) {
      if (this.check(T.DOT)) {
        this.advance();
        const field = this.expect(T.IDENT).value;
        expr = AST.memberExpr(expr, field, expr.loc);
      } else if (this.check(T.LBRACKET)) {
        this.advance();
        const idx = this.parseExpr();
        this.expect(T.RBRACKET);
        // Check for .field after index: ptr[n].field
        if (this.check(T.DOT)) {
          this.advance();
          const field = this.expect(T.IDENT).value;
          expr = AST.indexFieldExpr(expr, idx, field, expr.loc);
        } else {
          expr = AST.indexExpr(expr, idx, expr.loc);
        }
      } else if (this.check(T.LPAREN)) {
        // Call expression — may have type arg <Type>
        this.advance();
        const args = this.parseArgList();
        this.expect(T.RPAREN);
        expr = AST.callExpr(expr, args, null, expr.loc);
      } else if (this.check(T.LT) && this.isTypeArgContext()) {
        // call_indirect type arg: Table[idx]<Type>(args)
        this.advance();
        const typeArg = this.parseTypeExpr();
        this.expect(T.GT);
        this.expect(T.LPAREN);
        const args = this.parseArgList();
        this.expect(T.RPAREN);
        expr = AST.callExpr(expr, args, typeArg, expr.loc);
      } else if (this.peek().value === 'as' && this.peekType() === T.IDENT) {
        this.advance();
        const isUnchecked = this.peek().value === '!' && this.advance() != null;
        const toType = this.parseTypeExpr();
        expr = AST.castExpr(expr, toType, isUnchecked, expr.loc);
      } else if (this.peek().value === 'is' && this.peekType() === T.IDENT) {
        this.advance();
        const toType = this.parseTypeExpr();
        expr = AST.testExpr(expr, toType, expr.loc);
      } else if (this.check(T.BANG)) {
        // ref.as_non_null postfix
        this.advance();
        expr = AST.unaryExpr('ref.as_non_null', expr, expr.loc);
      } else {
        break;
      }
    }
    return expr;
  }

  /**
   * Heuristic: is '<' starting a type argument rather than comparison?
   * True when we're after an index expression (Table[idx]<Type>).
   * @returns {boolean}
   */
  isTypeArgContext() {
    // Simple heuristic: look ahead for matching '>' followed by '('
    let depth = 0;
    let i = this.pos;
    while (i < this.tokens.length) {
      const t = this.tokens[i].type;
      if (t === T.LT) depth++;
      else if (t === T.GT) { depth--; if (depth === 0) return this.tokens[i + 1]?.type === T.LPAREN; }
      else if (t === T.SEMI || t === T.RBRACE || t === T.EOF) return false;
      i++;
    }
    return false;
  }

  parsePrimaryExpr() {
    const tok = this.peek();

    switch (tok.type) {
      case T.INT_LIT: {
        this.advance();
        const [rawVal, suffix] = tok.value.includes(':') ? tok.value.split(':') : [tok.value, null];
        const numVal = rawVal.startsWith('0x') ? BigInt(rawVal) :
                       rawVal.startsWith('0b') ? BigInt(rawVal) : BigInt(rawVal.replace(/_/g, ''));
        return AST.intLit(numVal, suffix ?? 'i32', this.loc(tok));
      }
      case T.FLOAT_LIT: {
        this.advance();
        const [rawVal, suffix] = tok.value.includes(':') ? tok.value.split(':') : [tok.value, null];
        return AST.floatLit(parseFloat(rawVal.replace(/_/g, '')), suffix ?? 'f64', this.loc(tok));
      }
      case T.STRING_LIT: {
        this.advance();
        // Check for string type prefix before the string — already consumed as separate token
        return AST.stringLit(tok.value, 'raw', this.loc(tok));
      }
      case T.KW_NULL: {
        this.advance();
        return AST.nullLit(this.loc(tok));
      }
      case T.KW_NEW: {
        return this.parseNewExpr();
      }
      case T.KW_SELECT: {
        this.advance();
        this.expect(T.LPAREN);
        const cond = this.parseExpr();
        this.expect(T.COMMA);
        const a = this.parseExpr();
        this.expect(T.COMMA);
        const b = this.parseExpr();
        this.expect(T.RPAREN);
        return AST.selectExpr(cond, a, b, this.loc(tok));
      }
      case T.KW_SIZEOF: {
        this.advance();
        this.expect(T.LPAREN);
        const typeExpr = this.parseTypeExpr();
        this.expect(T.RPAREN);
        return AST.sizeofExpr(typeExpr, this.loc(tok));
      }
      case T.KW_IF: {
        return this.parseIfExpr();
      }
      case T.KW_TRY: {
        return this.parseTryExpr();
      }
      case T.LPAREN: {
        this.advance();
        const expr = this.parseExpr();
        this.expect(T.RPAREN);
        return expr;
      }
      // String type prefixes used as expression prefix for data literals
      case T.KW_CSTR:
      case T.KW_UTF8_32:
      case T.KW_UTF8_64:
      case T.KW_PASCAL: {
        const strType = tok.value;
        this.advance();
        const strTok = this.expect(T.STRING_LIT);
        return AST.stringLit(strTok.value, strType, this.loc(tok));
      }
      // Typed array literals: i32[1,2,3]
      default: {
        if (this.isNumericTypeToken(tok)) {
          return this.parseTypedArrayOrConversion();
        }
        if (tok.type === T.IDENT) {
          this.advance();
          // ref(fn) syntax
          if (tok.value === 'ref' && this.check(T.LPAREN)) {
            this.advance();
            const fnName = this.expect(T.IDENT).value;
            this.expect(T.RPAREN);
            return AST.refFuncExpr(fnName, this.loc(tok));
          }
          return AST.ident(tok.value, this.loc(tok));
        }
        this.error('E001', `Unexpected token '${tok.value || tok.type}' in expression`, tok);
        this.advance();
        return AST.errorNode('E001', this.loc(tok));
      }
    }
  }

  parseIfExpr() {
    const tok = this.advance(); // consume 'if'
    this.expect(T.LPAREN);
    const cond = this.parseExpr();
    this.expect(T.RPAREN);
    this.expect(T.LBRACE);
    // Collect stmts; last expr is the value
    const thenStmts = this.parseStmtList();
    this.expect(T.RBRACE);
    this.expect(T.KW_ELSE, 'if expression requires an else branch');
    this.expect(T.LBRACE);
    const elseStmts = this.parseStmtList();
    this.expect(T.RBRACE);
    return AST.ifExpr(cond, thenStmts, elseStmts, this.loc(tok));
  }

  parseTryExpr() {
    const tok = this.advance(); // consume 'try'
    this.expect(T.LBRACE);
    const body = this.parseStmtList();
    this.expect(T.RBRACE);
    const catches = [];
    while (this.check(T.KW_CATCH)) catches.push(this.parseCatchClause());
    return AST.tryExpr(body, catches, this.loc(tok));
  }

  parseNewExpr() {
    const tok = this.advance(); // consume 'new'
    const typeExpr = this.parseTypeExpr();
    if (this.check(T.LBRACE)) {
      // Struct: new Point { x: 1, y: 2 }
      this.advance();
      const fields = {};
      while (!this.check(T.RBRACE) && !this.check(T.EOF)) {
        const fname = this.expect(T.IDENT).value;
        this.expect(T.COLON);
        fields[fname] = this.parseExpr();
        if (!this.eat(T.COMMA)) break;
      }
      this.expect(T.RBRACE);
      return AST.newStructExpr(typeExpr, fields, this.loc(tok));
    } else if (this.check(T.LPAREN)) {
      // Array with size: new IntArray(n)
      this.advance();
      const size = this.parseExpr();
      this.expect(T.RPAREN);
      return AST.newArrayExpr(typeExpr, size, null, this.loc(tok));
    } else if (this.check(T.LBRACKET)) {
      // Array literal: new IntArray [a, b, c]
      this.advance();
      const items = [];
      while (!this.check(T.RBRACKET) && !this.check(T.EOF)) {
        items.push(this.parseExpr());
        if (!this.eat(T.COMMA)) break;
      }
      this.expect(T.RBRACKET);
      return AST.newArrayExpr(typeExpr, null, items, this.loc(tok));
    }
    this.error('E001', "Expected '{', '(' or '[' after 'new Type'", this.peek());
    return AST.errorNode('E001', this.loc(tok));
  }

  parseTypedArrayOrConversion() {
    const tok = this.advance(); // consume type name
    const typeName = tok.value;
    if (this.check(T.LBRACKET)) {
      // i32[1, 2, 3] — typed data array
      this.advance();
      const items = [];
      while (!this.check(T.RBRACKET) && !this.check(T.EOF)) {
        items.push(this.parseExpr());
        if (!this.eat(T.COMMA)) break;
      }
      this.expect(T.RBRACKET);
      return AST.dataLiteral(items, AST.primitiveType(typeName, this.loc(tok)), this.loc(tok));
    }
    if (this.check(T.DOT)) {
      // i32x4.splat(0) or i32.reinterpret etc — method call on type
      this.advance();
      const method = this.expect(T.IDENT).value;
      if (this.check(T.LPAREN)) {
        this.advance();
        const args = this.parseArgList();
        this.expect(T.RPAREN);
        return AST.callExpr(
          AST.memberExpr(AST.ident(typeName, this.loc(tok)), method, this.loc(tok)),
          args, null, this.loc(tok)
        );
      }
      return AST.memberExpr(AST.ident(typeName, this.loc(tok)), method, this.loc(tok));
    }
    // Just a type name used as expression (for conversions)
    return AST.ident(typeName, this.loc(tok));
  }

  parseArgList() {
    const args = [];
    while (!this.check(T.RPAREN) && !this.check(T.EOF)) {
      args.push(this.parseExpr());
      if (!this.eat(T.COMMA)) break;
    }
    return args;
  }

  isNumericTypeToken(tok) {
    const numericToks = new Set(['i8','i16','i32','i64','isize','u8','u16','u32','u64','usize',
      'f32','f64','v128','i8x16','i16x8','i32x4','i64x2','f32x4','f64x2']);
    return numericToks.has(tok.value);
  }

  // ── Type expressions ────────────────────────────────────────────────────

  parseTypeExpr() {
    const tok = this.peek();

    // Pointer type: *Type or *Type@Memory
    if (this.check(T.STAR)) {
      this.advance();
      const baseType = this.parseTypeExpr();
      let memory = null;
      // @Mem is lexed as a decorator-style token (value = '@MemName')
      const nextTok = this.peek();
      if (nextTok.value?.startsWith('@') && nextTok.type === T.IDENT) {
        memory = nextTok.value.slice(1); // strip the @
        this.advance();
      } else if (this.check(T.AT)) {
        this.advance();
        memory = this.expect(T.IDENT).value;
      }
      return AST.pointerType(baseType, memory, this.loc(tok));
    }

    // Array type: [T] or [mut T]
    if (this.check(T.LBRACKET)) {
      this.advance();
      const isMut = !!this.eat(T.KW_MUT);
      const elemType = this.parseTypeExpr();
      this.expect(T.RBRACKET);
      return AST.arrayType(elemType, isMut, this.loc(tok));
    }

    // Function type: (T, T) => T  or  (T, T) => ()  or  (T) => (T, T)
    if (this.check(T.LPAREN)) {
      return this.parseFuncTypeExpr();
    }

    // Struct type
    if (this.check(T.KW_STRUCT) || (this.check(T.KW_FINAL) && this.peekAt(1).type === T.KW_STRUCT)) {
      return this.parseStructTypeExpr();
    }

    // funcref / funcref<Type>
    if (this.check(T.KW_FUNCREF)) {
      this.advance();
      let typeParam = null;
      if (this.check(T.LT)) {
        this.advance();
        typeParam = this.parseTypeExpr();
        this.expect(T.GT);
      }
      return AST.funcRefType(typeParam, this.loc(tok));
    }

    // Named primitive/ref types (includes data-layout types for validator rejection)
    const primitiveMap = new Set(['i8','i16','i32','i64','isize','u8','u16','u32','u64','usize',
      'f32','f64','v128','i8x16','i16x8','i32x4','i64x2','f32x4','f64x2',
      'cstr','utf8_32','utf8_64','pascal']);
    const refMap = new Set(['externref','anyref','eqref','structref','arrayref','i31ref','nullref','exnref']);

    if (primitiveMap.has(tok.value)) {
      this.advance();
      return AST.primitiveType(tok.value, this.loc(tok));
    }
    if (refMap.has(tok.value)) {
      this.advance();
      return AST.refType(tok.value, this.loc(tok));
    }

    // Named type (user-defined)
    if (this.check(T.IDENT)) {
      this.advance();
      return AST.namedType(tok.value, this.loc(tok));
    }

    this.error('E009', `Expected type expression, found '${tok.value || tok.type}'`, tok);
    return AST.errorNode('E009', this.loc(tok));
  }

  parseFuncTypeExpr() {
    const tok = this.advance(); // consume '('
    const params = [];
    while (!this.check(T.RPAREN) && !this.check(T.EOF)) {
      params.push(this.parseTypeExpr());
      if (!this.eat(T.COMMA)) break;
    }
    this.expect(T.RPAREN);
    this.expect(T.FAT_ARROW);
    const results = this.parseReturnType();
    return AST.funcType(params, results, this.loc(tok));
  }

  parseStructTypeExpr() {
    const tok = this.peek();
    const isFinal = !!this.eat(T.KW_FINAL);
    this.expect(T.KW_STRUCT);
    let superType = null;
    if (this.eat(T.KW_EXTENDS)) {
      superType = this.parseTypeExpr();
    }
    this.expect(T.LBRACE);
    const fields = [];
    while (!this.check(T.RBRACE) && !this.check(T.EOF)) {
      const fTok = this.peek();
      const isMut = !!this.eat(T.KW_MUT);
      const fname = this.expect(T.IDENT).value;
      this.expect(T.COLON);
      const fType = this.parseTypeExpr();
      this.expect(T.SEMI);
      fields.push(AST.structField(fname, fType, isMut, this.loc(fTok)));
    }
    this.expect(T.RBRACE);
    return AST.structType(fields, superType, isFinal, [], this.loc(tok));
  }

  // ── Data types and items ────────────────────────────────────────────────

  parseDataType() {
    const tok = this.peek();
    // Typed array: i32[] i8[] f64[] etc
    const numericToks = new Set(['i8','i16','i32','i64','isize','u8','u16','u32','u64','usize','f32','f64']);
    if (numericToks.has(tok.value)) {
      this.advance();
      if (this.check(T.LBRACKET) && this.peekAt(1).type === T.RBRACKET) {
        this.advance(); this.advance();
        return { kind: 'ArrayDataType', elemType: tok.value };
      }
      return { kind: 'ScalarDataType', elemType: tok.value };
    }
    // String types
    const strTypes = new Set(['cstr','utf8_32','utf8_64','pascal']);
    if (strTypes.has(tok.value)) {
      this.advance();
      return { kind: 'StringDataType', strType: tok.value };
    }
    // funcref[]
    if (this.check(T.KW_FUNCREF)) {
      this.advance();
      if (this.check(T.LBRACKET) && this.peekAt(1).type === T.RBRACKET) {
        this.advance(); this.advance();
        return { kind: 'ArrayDataType', elemType: 'funcref' };
      }
    }
    // Named type[]
    if (this.check(T.IDENT)) {
      const name = this.advance().value;
      if (this.check(T.LBRACKET) && this.peekAt(1).type === T.RBRACKET) {
        this.advance(); this.advance();
        return { kind: 'ArrayDataType', elemType: name };
      }
      return { kind: 'NamedDataType', name };
    }
    return null;
  }

  parseDataItems() {
    const items = [];
    items.push(this.parseDataItem());
    while (this.eat(T.COMMA)) {
      items.push(this.parseDataItem());
    }
    return items;
  }

  parseDataItem() {
    const tok = this.peek();
    // String type prefix: cstr "hello"
    const strTypes = new Set(['cstr','utf8_32','utf8_64','pascal']);
    if (strTypes.has(tok.value)) {
      const strType = tok.value;
      this.advance();
      const strTok = this.expect(T.STRING_LIT);
      return AST.stringLit(strTok.value, strType, this.loc(tok));
    }
    // Typed array: i32[1,2,3]
    const numericToks = new Set(['i8','i16','i32','i64','isize','u8','u16','u32','u64','usize','f32','f64']);
    if (numericToks.has(tok.value) && this.peekAt(1).type === T.LBRACKET) {
      const typeName = this.advance().value;
      this.advance(); // consume [
      const items = [];
      while (!this.check(T.RBRACKET) && !this.check(T.EOF)) {
        items.push(this.parseExpr());
        if (!this.eat(T.COMMA)) break;
      }
      this.expect(T.RBRACKET);
      return AST.dataLiteral(items, AST.primitiveType(typeName, this.loc(tok)), this.loc(tok));
    }
    // Bare bracket array literal: [0x00, 0x61, ...]
    if (this.check(T.LBRACKET)) {
      this.advance();
      const items = [];
      while (!this.check(T.RBRACKET) && !this.check(T.EOF)) {
        items.push(this.parseExpr());
        if (!this.eat(T.COMMA)) break;
      }
      this.expect(T.RBRACKET);
      return AST.dataLiteral(items, null, this.loc(tok));
    }
    // Named data reference or expression
    return this.parseExpr();
  }

  parseElemItems() {
    // funcref[fn1, fn2] or just [fn1, fn2]
    const tok = this.peek();
    if (this.check(T.KW_FUNCREF) && this.peekAt(1).type === T.LBRACKET) {
      this.advance(); this.advance();
      const items = [];
      while (!this.check(T.RBRACKET) && !this.check(T.EOF)) {
        items.push(this.parseExpr());
        if (!this.eat(T.COMMA)) break;
      }
      this.expect(T.RBRACKET);
      return items;
    }
    if (this.check(T.LBRACKET)) {
      this.advance();
      const items = [];
      while (!this.check(T.RBRACKET) && !this.check(T.EOF)) {
        items.push(this.parseExpr());
        if (!this.eat(T.COMMA)) break;
      }
      this.expect(T.RBRACKET);
      return items;
    }
    return this.parseDataItems();
  }
}
