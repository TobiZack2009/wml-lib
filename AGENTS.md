# Commands
- `npm test` — run all tests
- `npm run test:parser` — parser tests
- `npm run test:validator` — validator tests
- `npm run test:emitter` — emitter tests
- `npm run test:features` — integration tests
- Run single test: `node --test test/parser/parser.test.js`
- No linter or typechecker configured

# Code style
- **Module**: ESM (`"type": "module"`), all imports use `.js` extensions
- **Formatting**: 2-space indent, double quotes, semicolons required, no trailing commas
- **Naming**: `camelCase` for variables/functions, `PascalCase` for classes, `UPPER_SNAKE_CASE` for constants and token keys
- **Exports**: named exports only (no default exports)
- **Types**: JSDoc annotations (`@param`, `@returns`, `@typedef`) on all public APIs
- **Error handling**: diagnostic-based (collect `Diagnostic` objects into arrays), not exception-based. Use `mkError()`/`mkWarning()` from `diagnostics/errors.js`
- **Testing**: Node `node:test` with `node:assert/strict`; `describe`/`test` blocks, one assertion per test preferred
- **AST**: plain objects with `kind` discriminator string, built with factory functions from `parser/ast.js`, imported as `import * as AST from './ast.js'`
- **Other**: destructuring preferred, `for...of` over traditional loops, `const` over `let` when possible, `Object.freeze()` for constants
