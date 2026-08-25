import ts from "typescript";

const PLAYWRIGHT_VITE_ASSET = /^node_modules\/playwright-core\/lib\/vite\/(?:recorder|traceViewer)\/assets\/[^/]+\.js$/u;
const VITE_IMPORT_ANALYSIS_SOURCE = "../../../src/node/plugins/importAnalysisBuild.ts";

function isImportMetaUrl(node: ts.Node | undefined): boolean {
  return Boolean(node
    && ts.isPropertyAccessExpression(node)
    && node.name.text === "url"
    && ts.isMetaProperty(node.expression)
    && node.expression.keywordToken === ts.SyntaxKind.ImportKeyword
    && node.expression.name.text === "meta");
}

function isViteGeneratedPlaywrightResolutionBase(path: string, node: ts.NewExpression): boolean {
  if (!PLAYWRIGHT_VITE_ASSET.test(path)
    || !ts.isIdentifier(node.expression)
    || node.expression.text !== "URL"
    || node.arguments?.length !== 2
    || (ts.isStringLiteralLike(node.arguments[0]) && /\.ts(?:[?#].*)?$/iu.test(node.arguments[0].text))) {
    return false;
  }
  const base = node.arguments[1];
  return ts.isNewExpression(base)
    && ts.isIdentifier(base.expression)
    && base.expression.text === "URL"
    && base.arguments?.length === 2
    && ts.isStringLiteralLike(base.arguments[0])
    && base.arguments[0].text === VITE_IMPORT_ANALYSIS_SOURCE
    && isImportMetaUrl(base.arguments[1]);
}

export function retainsTypeScriptRuntimeReference(path: string, content: string): boolean {
  const source = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
  let found = false;
  const isTypeScriptPath = (node: ts.Node | undefined): boolean =>
    Boolean(node && ts.isStringLiteralLike(node) && /\.ts(?:[?#].*)?$/i.test(node.text));
  const visit = (node: ts.Node): void => {
    if (found) return;
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && isTypeScriptPath(node.moduleSpecifier)) {
      found = true;
      return;
    }
    if (ts.isCallExpression(node)
      && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === "require"))
      && isTypeScriptPath(node.arguments[0])) {
      found = true;
      return;
    }
    if (ts.isNewExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === "URL") {
      if (isTypeScriptPath(node.arguments?.[0])) {
        found = true;
        return;
      }
      if (isViteGeneratedPlaywrightResolutionBase(path, node)) {
        // Playwright 1.62's Vite output retains this source label only as the
        // base of an already-compiled modulepreload URL. Inspect the real
        // dependency argument, but do not misclassify the inert generated base.
        visit(node.arguments![0]);
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}
