#!/usr/bin/env node
/**
 * @fileoverview WML CLI entry point.
 *
 * Usage:
 *   wml compile <files...> [options]
 *   wml validate <files...> [options]
 *
 * Options:
 *   --emit=wat|wasm        Output format (default: wat)
 *   --debug                Include name section and source maps
 *   --watch                Recompile on file change (requires chokidar)
 *   --format=text|json     Diagnostic format (default: text)
 *   --context=N            Source context lines in text output (default: 1)
 *   --max-errors=N         Max errors before truncation (default: 20)
 *   --no-warn              Suppress all warnings
 *   --warn-as-error        Treat warnings as errors
 *   --no-color             Disable ANSI colors
 *   --version, -v          Print version
 *   --help, -h             Print help
 */

import { readFileSync }   from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath }  from 'node:url';
import { compile, validate } from '../index.js';
import { formatText, formatJSON } from '../diagnostics/errors.js';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf8'));
const VERSION    = packageJson.version;

const HELP = `
wml ${VERSION} — WML (WASM Module Language) compiler

USAGE
  wml compile <files...> [options]
  wml validate <files...> [options]

OPTIONS
  --emit=wat|wasm        Output format (default: wat)
  --out=<path>           Output file path (default: stdout / <name>.wat or <name>.wasm)
  --debug                Include name section and source maps
  --watch                Recompile on file change (requires chokidar peer dependency)
  --format=text|json     Diagnostic format (default: text)
  --context=N            Source context lines in text output (default: 1)
  --max-errors=N         Max errors before truncation (default: 20)
  --no-warn              Suppress all warnings
  --warn-as-error        Treat warnings as errors
  --no-color             Disable ANSI colors
  --version, -v          Print version
  --help, -h             Print this help

EXAMPLES
  wml compile src/app.wml --emit=wat
  wml compile src/*.wml --emit=wasm --out=dist/app.wasm
  wml validate src/app.wml --format=json
  wml compile src/app.wml --watch
`.trim();

// ── Argument parsing ────────────────────────────────────────────────────────

function parseArgs(argv) {
  const files   = [];
  const options = {
    emit:        'wat',
    out:         null,
    debug:       false,
    watch:       false,
    format:      'text',
    context:     1,
    maxErrors:   20,
    noWarn:      false,
    warnAsError: false,
    color:       process.stdout.isTTY,
  };

  for (const arg of argv) {
    if (arg === '--help' || arg === '-h')         { console.log(HELP); process.exit(0); }
    if (arg === '--version' || arg === '-v')      { console.log(`wml ${VERSION}`); process.exit(0); }
    if (arg.startsWith('--emit='))                options.emit        = arg.slice(7);
    else if (arg.startsWith('--out='))            options.out         = arg.slice(6);
    else if (arg === '--debug')                   options.debug       = true;
    else if (arg === '--watch')                   options.watch       = true;
    else if (arg.startsWith('--format='))         options.format      = arg.slice(9);
    else if (arg.startsWith('--context='))        options.context     = parseInt(arg.slice(10), 10);
    else if (arg.startsWith('--max-errors='))     options.maxErrors   = parseInt(arg.slice(13), 10);
    else if (arg === '--no-warn')                 options.noWarn      = true;
    else if (arg === '--warn-as-error')           options.warnAsError = true;
    else if (arg === '--no-color')                options.color       = false;
    else if (!arg.startsWith('-'))                files.push(arg);
    else {
      console.error(`Unknown option: ${arg}`);
      process.exit(1);
    }
  }

  return { files, options };
}

// ── Output helpers ──────────────────────────────────────────────────────────

async function printResult(result, files, options) {
  const sourceMap = {};
  for (const f of files) {
    try {
      const { readFile } = await import('node:fs/promises');
      sourceMap[f] = await readFile(f, 'utf8');
    } catch {}
  }

  const allDiags = result.diagnostics.flatMap(g => g.diagnostics);

  if (allDiags.length > 0) {
    if (options.format === 'json') {
      process.stderr.write(formatJSON(allDiags, { maxErrors: options.maxErrors }) + '\n');
    } else {
      process.stderr.write(formatText(allDiags, sourceMap, {
        color:     options.color,
        context:   options.context,
        maxErrors: options.maxErrors,
      }) + '\n');
    }
  }

  if (result.ok && result.output != null) {
    if (options.out) {
      const { writeFile } = await import('node:fs/promises');
      if (result.output instanceof Uint8Array) {
        await writeFile(options.out, result.output);
      } else {
        await writeFile(options.out, result.output, 'utf8');
      }
      console.log(`Written to ${options.out}`);
    } else {
      if (result.output instanceof Uint8Array) {
        process.stdout.write(result.output);
      } else {
        process.stdout.write(result.output + '\n');
      }
    }
  }

  return result.ok ? 0 : 1;
}

// ── Watch mode ──────────────────────────────────────────────────────────────

async function watch(command, files, options) {
  let chokidar;
  try {
    chokidar = (await import('chokidar')).default;
  } catch {
    console.error('Watch mode requires chokidar: npm install chokidar');
    process.exit(1);
  }

  const run = async () => {
    process.stdout.write('\x1b[2J\x1b[H'); // clear screen
    console.log(`[${new Date().toLocaleTimeString()}] Compiling ${files.join(', ')}...`);
    await runCommand(command, files, options);
  };

  await run();

  const watcher = chokidar.watch(files, { ignoreInitial: true });
  watcher.on('change', run);
  watcher.on('add', run);
  console.error(`\nWatching ${files.join(', ')} — press Ctrl+C to stop`);
}

// ── Command runners ─────────────────────────────────────────────────────────

async function runCommand(command, files, options) {
  let result;
  if (command === 'compile') {
    result = await compile(files, {
      emit:        options.emit,
      debug:       options.debug,
      maxErrors:   options.maxErrors,
      noWarn:      options.noWarn,
      warnAsError: options.warnAsError,
    });
  } else {
    result = await validate(files, {
      maxErrors:   options.maxErrors,
      noWarn:      options.noWarn,
      warnAsError: options.warnAsError,
    });
  }
  return printResult(result, files, options);
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    console.log(HELP);
    process.exit(0);
  }

  const command = argv[0];
  if (command !== 'compile' && command !== 'validate') {
    console.error(`Unknown command: ${command}`);
    console.error('Usage: wml compile <files...> or wml validate <files...>');
    process.exit(1);
  }

  const { files, options } = parseArgs(argv.slice(1));

  if (files.length === 0) {
    console.error(`No input files specified. Usage: wml ${command} <files...>`);
    process.exit(1);
  }

  if (options.watch) {
    await watch(command, files, options);
  } else {
    const code = await runCommand(command, files, options);
    process.exit(code);
  }
}

main().catch(e => {
  console.error(e.message);
  process.exit(1);
});
