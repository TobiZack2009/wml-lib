/**
 * @fileoverview WML type system definitions.
 *
 * Defines the type hierarchy, type compatibility rules, and layout computation.
 *
 * WML types:
 *   Primitives: i8, i16, i32, i64, isize, u8, u16, u32, u64, usize, f32, f64, v128
 *   SIMD shaped: i8x16, i16x8, i32x4, i64x2, f32x4, f64x2
 *   References: funcref, externref, anyref, eqref, structref, arrayref, i31ref, nullref
 *   GC types: struct, array (user-defined via type declarations)
 *   Pointer: *T@Mem
 *   Function: (T,T) => T
 *   Error: used for recovery — infects operations silently
 *
 * @example
 * import { Types, isAssignable, layoutOf } from './types.js';
 * const t = Types.i32;
 * isAssignable(t, Types.u32) // true — same bits
 */

// ── Type constructors ──────────────────────────────────────────────────────

export const Types = Object.freeze({
  // Primitives
  i8:    { kind: 'prim', name: 'i8',    wasm: 'i32', signed: true,  size: 1 },
  i16:   { kind: 'prim', name: 'i16',   wasm: 'i32', signed: true,  size: 2 },
  i32:   { kind: 'prim', name: 'i32',   wasm: 'i32', signed: true,  size: 4 },
  i64:   { kind: 'prim', name: 'i64',   wasm: 'i64', signed: true,  size: 8 },
  isize: { kind: 'prim', name: 'isize', wasm: 'i32', signed: true,  size: 4 }, // WASM32
  u8:    { kind: 'prim', name: 'u8',    wasm: 'i32', signed: false, size: 1 },
  u16:   { kind: 'prim', name: 'u16',   wasm: 'i32', signed: false, size: 2 },
  u32:   { kind: 'prim', name: 'u32',   wasm: 'i32', signed: false, size: 4 },
  u64:   { kind: 'prim', name: 'u64',   wasm: 'i64', signed: false, size: 8 },
  usize: { kind: 'prim', name: 'usize', wasm: 'i32', signed: false, size: 4 }, // WASM32
  f32:   { kind: 'prim', name: 'f32',   wasm: 'f32', signed: null,  size: 4 },
  f64:   { kind: 'prim', name: 'f64',   wasm: 'f64', signed: null,  size: 8 },
  v128:  { kind: 'prim', name: 'v128',  wasm: 'v128', signed: null, size: 16 },
  // SIMD shaped types
  i8x16: { kind: 'simd', name: 'i8x16',  wasm: 'v128', lanes: 16, laneType: 'i8'  },
  i16x8: { kind: 'simd', name: 'i16x8',  wasm: 'v128', lanes: 8,  laneType: 'i16' },
  i32x4: { kind: 'simd', name: 'i32x4',  wasm: 'v128', lanes: 4,  laneType: 'i32' },
  i64x2: { kind: 'simd', name: 'i64x2',  wasm: 'v128', lanes: 2,  laneType: 'i64' },
  f32x4: { kind: 'simd', name: 'f32x4',  wasm: 'v128', lanes: 4,  laneType: 'f32' },
  f64x2: { kind: 'simd', name: 'f64x2',  wasm: 'v128', lanes: 2,  laneType: 'f64' },
  // Abstract reference types
  anyref:    { kind: 'ref', name: 'anyref' },
  eqref:     { kind: 'ref', name: 'eqref' },
  structref: { kind: 'ref', name: 'structref' },
  arrayref:  { kind: 'ref', name: 'arrayref' },
  i31ref:    { kind: 'ref', name: 'i31ref' },
  funcref:   { kind: 'ref', name: 'funcref' },
  externref: { kind: 'ref', name: 'externref' },
  nullref:   { kind: 'ref', name: 'nullref' },
  exnref:    { kind: 'ref', name: 'exnref' },
  // Void
  void:  { kind: 'void', name: 'void' },
  // Error recovery
  error: { kind: 'error', name: 'error' },
});

/**
 * Create a function type.
 * @param {Object[]} params
 * @param {Object[]} results
 * @returns {Object}
 */
export function funcType(params, results) {
  return { kind: 'func', params, results };
}

/**
 * Create a named GC struct type reference.
 * @param {string} name
 * @param {Object} decl - The struct declaration
 * @returns {Object}
 */
export function structType(name, decl) {
  return { kind: 'struct', name, decl };
}

/**
 * Create a named GC array type reference.
 * @param {string} name
 * @param {Object} decl
 * @returns {Object}
 */
export function arrayType(name, decl) {
  return { kind: 'array', name, decl };
}

/**
 * Create a typed funcref.
 * @param {Object|null} typeRef
 * @returns {Object}
 */
export function funcRefType(typeRef) {
  return { kind: 'funcref', typeRef };
}

/**
 * Create a pointer type.
 * @param {Object} baseType
 * @param {string|null} memory
 * @returns {Object}
 */
export function pointerType(baseType, memory) {
  return { kind: 'pointer', baseType, memory };
}

// ── Type predicates ────────────────────────────────────────────────────────

/** @param {Object} t @returns {boolean} */
export const isError = t => t?.kind === 'error';

/** @param {Object} t @returns {boolean} */
export const isVoid = t => t?.kind === 'void' || (Array.isArray(t) && t.length === 0);

/** @param {Object} t @returns {boolean} */
export const isPrim = t => t?.kind === 'prim';

/** @param {Object} t @returns {boolean} */
export const isInt = t => isPrim(t) && t.wasm === 'i32' || t?.wasm === 'i64';

/** @param {Object} t @returns {boolean} */
export const isFloat = t => isPrim(t) && (t.wasm === 'f32' || t.wasm === 'f64');

/** @param {Object} t @returns {boolean} */
export const isRef = t => t?.kind === 'ref' || t?.kind === 'struct' || t?.kind === 'array' ||
  t?.kind === 'funcref' || t?.kind === 'pointer';

/** @param {Object} t @returns {boolean} */
export const isPointer = t => t?.kind === 'pointer';

/** @param {Object} t @returns {boolean} */
export const isSigned = t => isPrim(t) && t.signed === true;

/** @param {Object} t @returns {boolean} */
export const isUnsigned = t => isPrim(t) && t.signed === false;

/** @param {Object} t @returns {boolean} */
export const isSIMD = t => t?.kind === 'simd';

// ── Integer compatibility groups ────────────────────────────────────────────

const I32_GROUP = new Set(['i8','i16','i32','u8','u16','u32','isize','usize']);
const I64_GROUP = new Set(['i64','u64']);

/**
 * Check if two integer types are compatible (i32/u32 are interchangeable).
 * @param {Object} a
 * @param {Object} b
 * @returns {boolean}
 */
export function intCompat(a, b) {
  if (isError(a) || isError(b)) return true;
  if (a === b) return true;
  // i32/u32 and i64/u64 are the same WASM type
  if (I32_GROUP.has(a?.name) && I32_GROUP.has(b?.name)) return true;
  if (I64_GROUP.has(a?.name) && I64_GROUP.has(b?.name)) return true;
  return false;
}

/**
 * Check if type `from` can be assigned to type `to`.
 * @param {Object} from
 * @param {Object} to
 * @returns {boolean}
 */
export function isAssignable(from, to) {
  if (isError(from) || isError(to)) return true; // suppress cascading errors
  if (from === to) return true;
  if (from?.name === to?.name) return true;
  // i32/u32/isize/usize/i8/i16/u8/u16 are all i32 at runtime
  if (intCompat(from, to)) return true;
  // nullref is assignable to any ref
  if (from?.name === 'nullref' && isRef(to)) return true;
  // GC subtyping — checked by name hierarchy in validator
  return false;
}

/**
 * Get the common type of two types for binary operations.
 * @param {Object} a
 * @param {Object} b
 * @returns {Object}
 */
export function commonType(a, b) {
  if (isError(a) || isError(b)) return Types.error;
  if (isAssignable(a, b)) return b;
  if (isAssignable(b, a)) return a;
  return Types.error;
}

/**
 * Resolve a type name string to a Types entry.
 * @param {string} name
 * @returns {Object|null}
 */
export function resolveBuiltin(name) {
  return Types[name] ?? null;
}

// ── Layout computation ─────────────────────────────────────────────────────

/**
 * Natural alignment of a type in bytes.
 * @param {Object} type
 * @returns {number}
 */
export function alignOf(type) {
  if (!type) return 1;
  switch (type.kind) {
    case 'prim': return Math.min(type.size, 8);
    case 'simd': return 16;
    case 'pointer': return 4; // WASM32
    case 'struct': return structAlign(type);
    default: return 4;
  }
}

/**
 * Size of a type in bytes.
 * @param {Object} type
 * @returns {number}
 */
export function sizeOf(type) {
  if (!type) return 4;
  switch (type.kind) {
    case 'prim': return type.size;
    case 'simd': return 16;
    case 'pointer': return 4; // WASM32
    case 'struct': return structSize(type);
    default: return 4;
  }
}

/**
 * Compute struct field offsets given repr.
 * @param {Object[]} fields - Array of { name, type }
 * @param {'default'|'packed'|'C'} repr
 * @returns {{ offsets: number[], totalSize: number }}
 */
export function computeLayout(fields, repr = 'default') {
  const offsets = [];
  let offset = 0;
  let maxAlign = 1;

  for (const field of fields) {
    const size  = sizeOf(field.type);
    const align = repr === 'packed' ? 1 : alignOf(field.type);
    maxAlign = Math.max(maxAlign, align);
    // Align current offset
    if (align > 1) offset = Math.ceil(offset / align) * align;
    offsets.push(offset);
    offset += size;
  }

  // Pad to struct alignment
  if (repr !== 'packed' && maxAlign > 1) {
    offset = Math.ceil(offset / maxAlign) * maxAlign;
  }

  return { offsets, totalSize: offset };
}

function structAlign(type) {
  if (!type.decl?.fields) return 4;
  let max = 1;
  for (const f of type.decl.fields) {
    max = Math.max(max, alignOf(f.resolvedType));
  }
  return max;
}

function structSize(type) {
  if (!type.decl?.fields) return 0;
  const { totalSize } = computeLayout(
    type.decl.fields.map(f => ({ name: f.name, type: f.resolvedType })),
    type.decl.repr ?? 'default'
  );
  return totalSize;
}
