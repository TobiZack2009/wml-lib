/**
 * @fileoverview WML → WASM binary emitter via Binaryen.
 *
 * This emitter takes the validated WAT output from WatEmitter and passes
 * it through Binaryen's parseText API to produce a validated, optimized
 * WASM binary.
 *
 * Binaryen is an optional peer dependency. If it is not installed, this
 * module falls back to returning the WAT text with an informational error.
 *
 * Binaryen adds:
 *   - Full WAT → WASM binary encoding
 *   - Validation of the generated WAT (catches emitter bugs)
 *   - Optional optimization passes (--opt flag)
 *   - Name section generation (for --debug)
 *
 * @example
 * import { BinaryenEmitter } from './binaryen.js';
 * const result = await BinaryenEmitter.emit(watText, { debug: true });
 * // result.wasm: Uint8Array | null
 * // result.error: string | null
 */

/**
 * Try to load Binaryen. Returns null if unavailable.
 * @returns {Promise<Object|null>}
 */
async function tryLoadBinaryen() {
  try {
    const mod = await import('binaryen');
    return mod.default ?? mod;
  } catch {
    return null;
  }
}

export class BinaryenEmitter {
  /**
   * Compile WAT text to WASM binary using Binaryen.
   *
   * @param {string} watText - Valid WAT source
   * @param {{ debug?: boolean, optimize?: boolean }} [options]
   * @returns {Promise<{ wasm: Uint8Array|null, error: string|null, usedFallback: boolean }>}
   */
  static async emit(watText, options = {}) {
    const binaryen = await tryLoadBinaryen();

    if (!binaryen) {
      return {
        wasm: null,
        error: [
          'Binaryen is not installed. Install it as a peer dependency to emit WASM binary:',
          '  npm install binaryen',
          '',
          'You can still emit WAT text with --emit=wat.',
        ].join('\n'),
        usedFallback: true,
      };
    }

    let wasmModule;
    try {
      // Parse the WAT into a Binaryen module
      wasmModule = binaryen.parseText(watText);
    } catch (e) {
      return {
        wasm: null,
        error: `Binaryen failed to parse generated WAT: ${e.message}\n\nThis is likely a compiler bug. Please report it.`,
        usedFallback: false,
      };
    }

    // Validate the module
    if (!wasmModule.validate()) {
      wasmModule.dispose();
      return {
        wasm: null,
        error: 'Binaryen validation failed on generated WAT. This is likely a compiler bug. Please report it.',
        usedFallback: false,
      };
    }

    // Optional optimization
    if (options.optimize) {
      binaryen.setOptimizeLevel(2);
      binaryen.setShrinkLevel(1);
      wasmModule.optimize();
    }

    // Debug: emit name section
    if (options.debug) {
      wasmModule.setDebugInfo(true);
    }

    // Emit binary
    const binary = wasmModule.emitBinary();
    wasmModule.dispose();

    return {
      wasm: binary,
      error: null,
      usedFallback: false,
    };
  }

  /**
   * Validate a WASM binary using Binaryen.
   * @param {Uint8Array} wasm
   * @returns {Promise<{ valid: boolean, error: string|null }>}
   */
  static async validate(wasm) {
    const binaryen = await tryLoadBinaryen();
    if (!binaryen) {
      return { valid: true, error: 'Binaryen not available — skipping binary validation' };
    }
    try {
      const mod = binaryen.readBinary(wasm);
      const valid = mod.validate();
      mod.dispose();
      return { valid, error: valid ? null : 'Binaryen validation failed' };
    } catch (e) {
      return { valid: false, error: e.message };
    }
  }
}
