/**
 * Checks that every promise in the engine is awaited where it is made. A call returning a
 * promise must be the operand of `await`, or be returned (to a caller that awaits it). Any
 * other use, such as a forgotten `await` or a promise tested as a boolean, would let the
 * engine carry on before a player has answered.
 *
 * Usage (from engine/): node test/promises.ts
 */
import ts from "typescript";

const configPath = ts.findConfigFile(".", ts.sys.fileExists, "tsconfig.json");
if (!configPath) throw new Error("tsconfig.json not found");
const config = ts.readConfigFile(configPath, ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, ".");
const program = ts.createProgram(parsed.fileNames, parsed.options);
const checker = program.getTypeChecker();
const problems: string[] = [];

function isPromise(type: ts.Type): boolean {
  return type.getSymbol()?.getName() === "Promise";
}

function awaitedOrReturned(node: ts.Node): boolean {
  let parent = node.parent;
  while (ts.isParenthesizedExpression(parent)) parent = parent.parent;
  if (ts.isAwaitExpression(parent) || ts.isReturnStatement(parent)) return true;
  return ts.isArrowFunction(parent) && parent.body === node;
}

function visit(node: ts.Node): void {
  if (ts.isCallExpression(node) && isPromise(checker.getTypeAtLocation(node)) && !awaitedOrReturned(node)) {
    const file = node.getSourceFile();
    const { line } = file.getLineAndCharacterOfPosition(node.getStart());
    problems.push(`${file.fileName}:${line + 1}: promise not awaited: ${node.getText().split("\n")[0]}`);
  }
  ts.forEachChild(node, visit);
}

for (const file of program.getSourceFiles()) {
  if (!file.isDeclarationFile) visit(file);
}
for (const p of problems) console.log(p);
if (problems.length > 0) process.exit(1);
