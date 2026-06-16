/**
 * Type shim for `uplot`.
 *
 * The published package has no `types` field and exposes its declarations via
 * `export =` at `uplot/dist/uPlot.d.ts`. This ambient module makes a bare
 * `import uPlot from "uplot"` resolve to those types (the default import is
 * synthesized via `esModuleInterop`).
 */
declare module "uplot" {
  // `import = require` is the only way to re-export an `export =` module's types.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  import uPlot = require("uplot/dist/uPlot");
  export = uPlot;
}
