/**
 * Where a registration block may legally go, answered with the real TypeScript
 * parser instead of counting braces.
 *
 * Brace counting breaks on ordinary prose: an apostrophe in a comment
 * ("don't") reads as a string opener and swallows the code up to the next
 * quote, so the running depth drifts and the component's own JSX return stops
 * being recognised as the component's. Placement then fell back to "right
 * after the anchor line", which for a multi-line `const onRevoke = useCallback(`
 * lands INSIDE the argument list and breaks the file with `TS1005: ')'
 * expected` — losing every action wired in that file.
 *
 * Every function here fails soft: if TypeScript cannot be loaded or the file
 * cannot be parsed, callers keep their previous behaviour.
 */
'use strict';

const path = require('path');

const ts = loadTypeScript();

function loadTypeScript() {
  try {
    return require('typescript');
  } catch {
    try {
      return require(path.join(__dirname, '../../../node_modules/typescript'));
    } catch {
      return null;
    }
  }
}

function scriptKind(file) {
  const f = String(file || '');
  if (f.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (f.endsWith('.ts')) return ts.ScriptKind.TS;
  if (f.endsWith('.jsx')) return ts.ScriptKind.JSX;
  // A plain .js file in a React project may still hold JSX; JSX parsing is the
  // tolerant choice and never rejects ordinary JavaScript.
  return ts.ScriptKind.JSX;
}

function parse(content, file) {
  if (!ts) return null;
  try {
    return ts.createSourceFile(
      String(file || 'file.tsx'),
      String(content || ''),
      ts.ScriptTarget.Latest,
      /* setParentNodes */ true,
      scriptKind(file),
    );
  } catch {
    return null;
  }
}

function isFunctionLike(node) {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

/** The innermost function body that contains `idx`, or null at module level. */
function innermostFunctionAt(sourceFile, idx) {
  let found = null;
  const visit = (node) => {
    if (idx < node.getStart(sourceFile) || idx >= node.getEnd()) return;
    if (isFunctionLike(node)) found = node;
    node.forEachChild(visit);
  };
  sourceFile.forEachChild(visit);
  return found;
}

function enclosingFunction(node) {
  let parent = node.parent;
  while (parent && !isFunctionLike(parent)) parent = parent.parent;
  return parent || null;
}

function returnsJsx(expr) {
  let e = expr;
  while (e && ts.isParenthesizedExpression(e)) e = e.expression;
  if (!e) return false;
  if (ts.isJsxElement(e) || ts.isJsxFragment(e) || ts.isJsxSelfClosingElement(e)) return true;
  if (ts.isConditionalExpression(e)) return returnsJsx(e.whenTrue) || returnsJsx(e.whenFalse);
  return false;
}

/** The function's own rendering `return`, ignoring returns of nested closures. */
function jsxReturnOf(fn) {
  const body = fn && fn.body;
  if (!body || !ts.isBlock(body)) return null;
  let last = null;
  for (const st of body.statements) {
    if (ts.isReturnStatement(st) && st.expression && returnsJsx(st.expression)) last = st;
  }
  return last;
}

/**
 * Index of the JSX `return` of the body that ENCLOSES `anchorIdx` — walking
 * outwards, so an anchor inside an event handler resolves to the component's
 * return and never to a neighbour's. -1 when there is none (an object-returning
 * factory, a non-JSX framework), which leaves the caller's fallback in charge.
 */
function enclosingJsxReturnIndex(content, file, anchorIdx) {
  const sourceFile = parse(content, file);
  if (!sourceFile) return -1;
  try {
    let fn = innermostFunctionAt(sourceFile, anchorIdx);
    while (fn) {
      const ret = jsxReturnOf(fn);
      if (ret) return ret.getStart(sourceFile);
      fn = enclosingFunction(fn);
    }
  } catch {
    return -1;
  }
  return -1;
}

/**
 * Do both positions live in the same function body? Used to refuse inserting
 * after a statement that sits in a nested closure: it compiles, but the
 * registration only runs if that closure is ever called, and the action dies
 * at runtime with FYODOS_HANDLER_UNREADY.
 */
function sameFunctionScope(content, file, a, b) {
  const sourceFile = parse(content, file);
  if (!sourceFile) return true;
  try {
    return innermostFunctionAt(sourceFile, a) === innermostFunctionAt(sourceFile, b);
  } catch {
    return true;
  }
}

module.exports = { enclosingJsxReturnIndex, sameFunctionScope };
