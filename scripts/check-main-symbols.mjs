import ts from "typescript";
import { pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

// Transitional gate: full main-process strict checking still has legacy type debt.
// Never suppress unresolved names/imports: these can survive Vite and crash at runtime.
const SYMBOL_ERRORS = new Set([2304, 2305, 2307, 2552, 2693, 1361, 18004, 2724]);

export function checkMainSymbols(configPath = "tsconfig.node.json", sourceOverrides = new Map()) {
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) return [config.error];
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, dirname(resolve(configPath)));
  const options = { ...parsed.options, noEmit: true };
  const host = ts.createCompilerHost(options);
  const readFile = host.readFile;
  host.readFile = file => sourceOverrides.get(resolve(file)) ?? readFile(file);
  const program = ts.createProgram(parsed.fileNames, options, host);
  return [...parsed.errors, ...program.getOptionsDiagnostics(), ...program.getSyntacticDiagnostics(),
    ...program.getSemanticDiagnostics().filter(d => SYMBOL_ERRORS.has(d.code))];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const errors = checkMainSymbols();
  if (errors.length) {
    console.error(ts.formatDiagnosticsWithColorAndContext(errors, {
      getCanonicalFileName: f => f, getCurrentDirectory: ts.sys.getCurrentDirectory, getNewLine: () => "\n",
    }));
    process.exitCode = 1;
  } else console.log("Main-process symbol/import check passed (not a full strict typecheck).");
}
