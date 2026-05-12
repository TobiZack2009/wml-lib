/**
 * @fileoverview WML Lexer.
 *
 * Converts WML source text into a flat array of tokens.
 * The lexer handles:
 *   - All WML keywords and identifiers
 *   - Integer and float literals (including hex, binary)
 *   - String literals with all four WML string types (cstr, utf8_32, utf8_64, pascal)
 *   - Labels ('name syntax)
 *   - Decorators (@export, @import, @start, @tail, @debug)
 *   - Pragmas (#[...])
 *   - All operators including multi-character ones (/s, /u, >>s, >>u, etc.)
 *   - Line and block comments
 *   - CRLF normalization
 *
 * @example
 * import { Lexer } from './lexer.js';
 * const lexer = new Lexer('add(a: i32, b: i32): i32 { return a + b; }', 'example.wml');
 * const tokens = lexer.tokenize();
 */

import { T, KEYWORDS } from './tokens.js';

/**
 * @typedef {Object} Token
 * @property {string} type - Token type from T enum
 * @property {string} value - Raw source text of the token
 * @property {number} line - 1-indexed line number
 * @property {number} col - 1-indexed column number
 * @property {string} file - Source file name
 */

/**
 * Lexer for WML source text.
 */
export class Lexer {
  /**
   * @param {string} source - WML source text
   * @param {string} [file='source'] - File name for error reporting
   */
  constructor(source, file = 'source') {
    /** @type {string} */
    this.source = source.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    /** @type {string} */
    this.file = file;
    /** @type {number} */
    this.pos = 0;
    /** @type {number} */
    this.line = 1;
    /** @type {number} */
    this.col = 1;
    /** @type {Token[]} */
    this.tokens = [];
    /** @type {import('../diagnostics/errors.js').Diagnostic[]} */
    this.errors = [];
  }

  /**
   * Peek at the current character without advancing.
   * @returns {string}
   */
  peek() { return this.source[this.pos] ?? ''; }

  /**
   * Peek ahead by n characters.
   * @param {number} n
   * @returns {string}
   */
  peekAt(n) { return this.source[this.pos + n] ?? ''; }

  /**
   * Advance and return the current character.
   * @returns {string}
   */
  advance() {
    const ch = this.source[this.pos++];
    if (ch === '\n') { this.line++; this.col = 1; }
    else { this.col++; }
    return ch;
  }

  /**
   * Check if the next characters match a string, and if so consume them.
   * @param {string} s
   * @returns {boolean}
   */
  match(s) {
    if (this.source.startsWith(s, this.pos)) {
      for (let i = 0; i < s.length; i++) this.advance();
      return true;
    }
    return false;
  }

  /**
   * Emit a token at the current position.
   * @param {string} type
   * @param {string} value
   * @param {number} line
   * @param {number} col
   */
  emit(type, value, line, col) {
    this.tokens.push({ type, value, line, col, file: this.file });
  }

  /**
   * Record a lexer error.
   * @param {string} code
   * @param {string} message
   * @param {number} line
   * @param {number} col
   */
  error(code, message, line, col) {
    this.errors.push({
      code,
      category: 'SyntaxError',
      kind: 'LexError',
      severity: 'error',
      message,
      detail: message,
      hint: null,
      location: { file: this.file, line, col, endLine: line, endCol: col + 1 },
      recovered: true,
    });
  }

  /**
   * Tokenize the entire source and return the token array.
   * Always ends with an EOF token.
   * @returns {Token[]}
   */
  tokenize() {
    while (this.pos < this.source.length) {
      this.skipWhitespaceAndComments();
      if (this.pos >= this.source.length) break;
      this.readToken();
    }
    this.emit(T.EOF, '', this.line, this.col);
    return this.tokens;
  }

  /**
   * Skip whitespace and both line (//) and block (/* *\/) comments.
   */
  skipWhitespaceAndComments() {
    while (this.pos < this.source.length) {
      const ch = this.peek();
      if (ch === ' ' || ch === '\t' || ch === '\n') {
        this.advance();
      } else if (ch === '/' && this.peekAt(1) === '/') {
        // Line comment
        while (this.pos < this.source.length && this.peek() !== '\n') this.advance();
      } else if (ch === '/' && this.peekAt(1) === '*') {
        // Block comment
        const startLine = this.line; const startCol = this.col;
        this.advance(); this.advance(); // consume /*
        let closed = false;
        while (this.pos < this.source.length) {
          if (this.peek() === '*' && this.peekAt(1) === '/') {
            this.advance(); this.advance();
            closed = true;
            break;
          }
          this.advance();
        }
        if (!closed) this.error('E004', 'Unclosed block comment', startLine, startCol);
      } else {
        break;
      }
    }
  }

  /**
   * Read one token starting at the current position.
   */
  readToken() {
    const line = this.line;
    const col = this.col;
    const ch = this.peek();

    // ── Pragma #[ ───────────────────────────────────────────
    if (ch === '#' && this.peekAt(1) === '[') {
      this.advance(); this.advance();
      this.emit(T.PRAGMA_OPEN, '#[', line, col);
      return;
    }

    // ── Decorators @ ────────────────────────────────────────
    if (ch === '@') {
      this.advance();
      const start = this.pos;
      while (this.pos < this.source.length && /[a-zA-Z0-9_]/.test(this.peek())) this.advance();
      const name = '@' + this.source.slice(start, this.pos);
      const decoratorMap = {
        '@export': T.AT_EXPORT,
        '@import': T.AT_IMPORT,
        '@start':  T.AT_START,
        '@tail':   T.AT_TAIL,
        '@debug':  T.AT_DEBUG,
      };
      if (decoratorMap[name]) {
        this.emit(decoratorMap[name], name, line, col);
      } else {
        this.error('E001', `Unknown decorator '${name}'`, line, col);
        this.emit(T.IDENT, name, line, col);
      }
      return;
    }

    // ── Labels 'name ─────────────────────────────────────────
    if (ch === "'") {
      this.advance();
      const start = this.pos;
      if (/[a-zA-Z_]/.test(this.peek())) {
        while (this.pos < this.source.length && /[a-zA-Z0-9_]/.test(this.peek())) this.advance();
        this.emit(T.LABEL, this.source.slice(start, this.pos), line, col);
      } else {
        this.error('E001', "Expected label name after '", line, col);
      }
      return;
    }

    // ── String literals ──────────────────────────────────────
    if (ch === '"') {
      this.readString(line, col);
      return;
    }

    // ── Numbers ──────────────────────────────────────────────
    if (/[0-9]/.test(ch) || (ch === '-' && /[0-9]/.test(this.peekAt(1)))) {
      this.readNumber(line, col);
      return;
    }

    // ── Identifiers and keywords ─────────────────────────────
    if (/[a-zA-Z_]/.test(ch)) {
      this.readIdentOrKeyword(line, col);
      return;
    }

    // ── Operators and punctuation ────────────────────────────
    this.readOperator(line, col);
  }

  /**
   * Read a string literal. The opening `"` has not been consumed yet.
   * @param {number} line
   * @param {number} col
   */
  readString(line, col) {
    this.advance(); // consume "
    let value = '';
    while (this.pos < this.source.length && this.peek() !== '"') {
      if (this.peek() === '\\') {
        this.advance();
        const esc = this.advance();
        switch (esc) {
          case 'n':  value += '\n'; break;
          case 't':  value += '\t'; break;
          case 'r':  value += '\r'; break;
          case '0':  value += '\0'; break;
          case '\\': value += '\\'; break;
          case '"':  value += '"'; break;
          case 'x': {
            const hex = this.source.slice(this.pos, this.pos + 2);
            if (/^[0-9a-fA-F]{2}$/.test(hex)) {
              value += String.fromCharCode(parseInt(hex, 16));
              this.pos += 2; this.col += 2;
            } else {
              this.error('E005', `Invalid hex escape \\x${hex}`, line, col);
            }
            break;
          }
          case 'u': {
            if (this.peek() === '{') {
              this.advance();
              const start = this.pos;
              while (this.pos < this.source.length && /[0-9a-fA-F]/.test(this.peek())) this.advance();
              const hex = this.source.slice(start, this.pos);
              if (this.peek() === '}') {
                this.advance();
                const cp = parseInt(hex, 16);
                value += String.fromCodePoint(cp);
              } else {
                this.error('E005', 'Unclosed unicode escape \\u{', line, col);
              }
            } else {
              this.error('E005', "Expected '{' after \\u", line, col);
            }
            break;
          }
          default:
            this.error('E005', `Invalid escape sequence '\\${esc}'`, line, col);
            value += esc;
        }
      } else {
        value += this.advance();
      }
    }
    if (this.peek() === '"') {
      this.advance();
    } else {
      this.error('E004', 'Unclosed string literal', line, col);
    }
    this.emit(T.STRING_LIT, value, line, col);
  }

  /**
   * Read an integer or float literal.
   * @param {number} line
   * @param {number} col
   */
  readNumber(line, col) {
    let value = '';
    let isFloat = false;

    // Optional leading minus
    if (this.peek() === '-') value += this.advance();

    // Hex
    if (this.peek() === '0' && (this.peekAt(1) === 'x' || this.peekAt(1) === 'X')) {
      value += this.advance() + this.advance();
      while (/[0-9a-fA-F_]/.test(this.peek())) value += this.advance();
    }
    // Binary
    else if (this.peek() === '0' && (this.peekAt(1) === 'b' || this.peekAt(1) === 'B')) {
      value += this.advance() + this.advance();
      while (/[01_]/.test(this.peek())) value += this.advance();
    }
    // Decimal
    else {
      while (/[0-9_]/.test(this.peek())) value += this.advance();
      if (this.peek() === '.' && this.peekAt(1) !== '.') {
        isFloat = true;
        value += this.advance();
        while (/[0-9_]/.test(this.peek())) value += this.advance();
      }
      // Exponent
      if (this.peek() === 'e' || this.peek() === 'E') {
        isFloat = true;
        value += this.advance();
        if (this.peek() === '+' || this.peek() === '-') value += this.advance();
        while (/[0-9_]/.test(this.peek())) value += this.advance();
      }
    }

    // Optional type suffix (i32, i64, u32, u64, f32, f64, i8, i16, u8, u16, isize, usize)
    const suffixStart = this.pos;
    if (/[a-zA-Z]/.test(this.peek())) {
      let suffix = '';
      while (/[a-zA-Z0-9]/.test(this.peek())) suffix += this.advance();
      value += ':' + suffix; // encode suffix in value as "number:suffix"
    }

    this.emit(isFloat ? T.FLOAT_LIT : T.INT_LIT, value, line, col);
  }

  /**
   * Read an identifier or keyword.
   * @param {number} line
   * @param {number} col
   */
  readIdentOrKeyword(line, col) {
    let value = '';
    while (this.pos < this.source.length && /[a-zA-Z0-9_]/.test(this.peek())) {
      value += this.advance();
    }
    const kwType = KEYWORDS.get(value);
    this.emit(kwType ?? T.IDENT, value, line, col);
  }

  /**
   * Read an operator or punctuation token.
   * @param {number} line
   * @param {number} col
   */
  readOperator(line, col) {
    const ch = this.advance();

    switch (ch) {
      case '+':
        if (this.peek() === '=') { this.advance(); this.emit(T.PLUS_ASSIGN, '+=', line, col); }
        else this.emit(T.PLUS, '+', line, col);
        return;
      case '-':
        if (this.peek() === '=') { this.advance(); this.emit(T.MINUS_ASSIGN, '-=', line, col); }
        else if (this.peek() === '>') { this.advance(); this.emit(T.ARROW, '->', line, col); }
        else this.emit(T.MINUS, '-', line, col);
        return;
      case '*':
        if (this.peek() === '=') { this.advance(); this.emit(T.STAR_ASSIGN, '*=', line, col); }
        else this.emit(T.STAR, '*', line, col);
        return;
      case '/':
        if (this.peek() === 's') { this.advance(); this.emit(T.SLASH_S, '/s', line, col); }
        else if (this.peek() === 'u') { this.advance(); this.emit(T.SLASH_U, '/u', line, col); }
        else this.emit(T.SLASH_S, '/', line, col); // default to /s
        return;
      case '%':
        if (this.peek() === 's') { this.advance(); this.emit(T.PERCENT_S, '%s', line, col); }
        else if (this.peek() === 'u') { this.advance(); this.emit(T.PERCENT_U, '%u', line, col); }
        else this.emit(T.PERCENT_S, '%', line, col);
        return;
      case '&':
        if (this.peek() === '&') { this.advance(); this.emit(T.AND, '&&', line, col); }
        else this.emit(T.AMP, '&', line, col);
        return;
      case '|':
        if (this.peek() === '|') { this.advance(); this.emit(T.OR, '||', line, col); }
        else this.emit(T.PIPE, '|', line, col);
        return;
      case '^': this.emit(T.CARET, '^', line, col); return;
      case '~': this.emit(T.TILDE, '~', line, col); return;
      case '<':
        if (this.peek() === '<') { this.advance(); this.emit(T.SHL, '<<', line, col); }
        else if (this.peek() === '=') { this.advance(); this.emit(T.LTE, '<=', line, col); }
        else this.emit(T.LT, '<', line, col);
        return;
      case '>':
        if (this.peek() === '>') {
          this.advance();
          if (this.peek() === 's') { this.advance(); this.emit(T.SHR_S, '>>s', line, col); }
          else if (this.peek() === 'u') { this.advance(); this.emit(T.SHR_U, '>>u', line, col); }
          else this.emit(T.SHR_S, '>>', line, col);
        } else if (this.peek() === '=') { this.advance(); this.emit(T.GTE, '>=', line, col); }
        else this.emit(T.GT, '>', line, col);
        return;
      case '=':
        if (this.peek() === '=') { this.advance(); this.emit(T.EQ, '==', line, col); }
        else if (this.peek() === '>') { this.advance(); this.emit(T.FAT_ARROW, '=>', line, col); }
        else this.emit(T.ASSIGN, '=', line, col);
        return;
      case '!':
        if (this.peek() === '=') { this.advance(); this.emit(T.NEQ, '!=', line, col); }
        else this.emit(T.BANG, '!', line, col);
        return;
      case '.':
        if (this.peek() === '.') { this.advance(); this.emit(T.DOTDOT, '..', line, col); }
        else this.emit(T.DOT, '.', line, col);
        return;
      case ':': this.emit(T.COLON, ':', line, col); return;
      case ';': this.emit(T.SEMI, ';', line, col); return;
      case ',': this.emit(T.COMMA, ',', line, col); return;
      case '(': this.emit(T.LPAREN, '(', line, col); return;
      case ')': this.emit(T.RPAREN, ')', line, col); return;
      case '{': this.emit(T.LBRACE, '{', line, col); return;
      case '}': this.emit(T.RBRACE, '}', line, col); return;
      case '[': this.emit(T.LBRACKET, '[', line, col); return;
      case ']': this.emit(T.RBRACKET, ']', line, col); return;
      default:
        this.error('E001', `Unexpected character '${ch}'`, line, col);
    }
  }
}
