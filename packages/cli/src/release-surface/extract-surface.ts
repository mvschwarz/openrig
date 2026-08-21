// OPR.0.3.3.13.1 - CLI surface-detection parser (Component 1 of slice 13).
//
// Extracts the Commander command surface from `packages/cli/src/commands/*.ts`
// source text via the TypeScript compiler API (already a devDependency; no new
// dep per the slice governance ruling). The surface is the set of command paths
// (e.g. `scope slice create`) and option name-tokens (e.g. `--body-file`) per
// command, taken from the Commander registration chain - NOT from the filename
// and NOT from option descriptions (which are frequently template literals).
//
// Two registration idioms are resolved:
//   - chained inline subcommands: `cmd.command("create").requiredOption(...)`,
//   - factory indirection: `parent.addCommand(buildChildCommand())` where the
//     builder returns `new Command("child")...`.
// The registration NAME wins over the filename (the `rig-mode.ts` file's
// `new Command("policy")` surfaces as `policy`, never `rig-policy`).

import ts from "typescript";

export interface Surface {
  /** Full command paths, space-joined (e.g. "queue create", "scope slice create"). */
  commands: Set<string>;
  /** "<command-path> <--flag>" entries, split on FLAG_SEP. */
  flags: Set<string>;
}

// NUL separator between a command path and a flag. Command paths are
// space-joined, so a space cannot unambiguously split a "<path> <flag>" entry
// (the path itself contains spaces). NUL never occurs in a path or flag token,
// so it splits cleanly. It lives only inside Set keys and never reaches output.
export const FLAG_SEP = "\u0000";

interface CmdNode {
  name: string;
  flags: Set<string>;
  children: CmdNode[];
}

function firstToken(s: string): string {
  return s.trim().split(/\s+/)[0] ?? "";
}

function stringLiteralText(node: ts.Node | undefined): string | null {
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

/**
 * Reduce an option's first argument (the flags string) to its canonical long
 * flag, ignoring the value placeholder. Examples:
 *   "--body-file <path>"  -> "--body-file"
 *   "-l, --literal"       -> "--literal"
 *   "--no-mission-notes"  -> "--no-mission-notes"
 *   "-y"                  -> "-y"
 * Returns null when no flag token is present.
 */
export function normalizeFlag(flagsArg: string): string | null {
  const tokens = flagsArg.split(/[\s,]+/).filter(Boolean);
  const longs = tokens.filter((t) => t.startsWith("--"));
  if (longs.length > 0) return longs[longs.length - 1]!;
  const shorts = tokens.filter((t) => /^-[^-]/.test(t));
  return shorts.length > 0 ? shorts[0]! : null;
}

function unwrap(e: ts.Expression): ts.Expression {
  let cur = e;
  while (ts.isParenthesizedExpression(cur)) cur = cur.expression;
  return cur;
}

function freshNode(rawName: string): CmdNode {
  return { name: firstToken(rawName), flags: new Set(), children: [] };
}

/** Extract the root command node(s) for a single source file. */
function extractFile(fileName: string, text: string): CmdNode[] {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.ES2022, true);

  const fnDecls = new Map<string, ts.FunctionDeclaration>();
  const exportedFnNames: string[] = [];
  sf.forEachChild((node) => {
    if (ts.isFunctionDeclaration(node) && node.name) {
      fnDecls.set(node.name.text, node);
      const exported = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      if (exported) exportedFnNames.push(node.name.text);
    }
  });

  const fnRoots = new Map<string, CmdNode | null>();
  const inProgress = new Set<string>();

  function rootOfFunction(name: string): CmdNode | null {
    if (fnRoots.has(name)) return fnRoots.get(name)!;
    if (inProgress.has(name)) return null; // cycle guard
    const decl = fnDecls.get(name);
    if (!decl || !decl.body) {
      fnRoots.set(name, null);
      return null;
    }
    inProgress.add(name);
    const root = processBody(decl.body);
    inProgress.delete(name);
    fnRoots.set(name, root);
    return root;
  }

  function processBody(body: ts.Block): CmdNode | null {
    const vars = new Map<string, CmdNode>();
    let root: CmdNode | null = null;
    for (const stmt of body.statements) {
      if (ts.isVariableStatement(stmt)) {
        for (const decl of stmt.declarationList.declarations) {
          if (ts.isIdentifier(decl.name) && decl.initializer) {
            const node = evalExpr(decl.initializer, vars);
            if (node) vars.set(decl.name.text, node);
          }
        }
      } else if (ts.isExpressionStatement(stmt)) {
        evalExpr(stmt.expression, vars); // side effects: .command / .addCommand / .option
      } else if (ts.isReturnStatement(stmt) && stmt.expression) {
        root = evalExpr(stmt.expression, vars);
      }
    }
    return root;
  }

  // Resolve an expression that evaluates to (or mutates) a command node.
  // `.command()` returns the freshly-created CHILD (Commander semantics);
  // every other builder method returns the receiver (`this`).
  function evalExpr(input: ts.Expression, vars: Map<string, CmdNode>): CmdNode | null {
    const expr = unwrap(input);

    if (ts.isNewExpression(expr) && ts.isIdentifier(expr.expression) && expr.expression.text === "Command") {
      const nameLit = stringLiteralText(expr.arguments?.[0]);
      return nameLit == null ? null : freshNode(nameLit);
    }

    if (ts.isIdentifier(expr)) {
      return vars.get(expr.text) ?? null;
    }

    if (ts.isCallExpression(expr)) {
      const callee = expr.expression;

      // builderFn() -> the root command that function returns
      if (ts.isIdentifier(callee) && fnDecls.has(callee.text)) {
        return rootOfFunction(callee.text);
      }

      if (ts.isPropertyAccessExpression(callee)) {
        const method = callee.name.text;
        const recv = evalExpr(callee.expression, vars);

        if (method === "command") {
          const nameLit = stringLiteralText(expr.arguments[0]);
          if (nameLit == null) return recv;
          const child = freshNode(nameLit);
          if (recv) recv.children.push(child);
          return child; // chained calls attach to the child
        }
        if (method === "option" || method === "requiredOption") {
          const flagLit = stringLiteralText(expr.arguments[0]);
          if (recv && flagLit != null) {
            const f = normalizeFlag(flagLit);
            if (f) recv.flags.add(f);
          }
          return recv;
        }
        if (method === "addCommand") {
          const arg0 = expr.arguments[0];
          const child = arg0 ? evalExpr(arg0, vars) : null;
          if (recv && child) recv.children.push(child);
          return recv;
        }
        // description / action / argument / alias / addHelpText / etc. -> receiver
        return recv;
      }
    }

    return null;
  }

  const roots: CmdNode[] = [];
  const seen = new Set<CmdNode>();
  for (const name of exportedFnNames) {
    const r = rootOfFunction(name);
    if (r && !seen.has(r)) {
      roots.push(r);
      seen.add(r);
    }
  }
  return roots;
}

function walk(node: CmdNode, prefix: string[], surface: Surface): void {
  const path = [...prefix, node.name];
  const pathStr = path.join(" ");
  surface.commands.add(pathStr);
  for (const f of node.flags) surface.flags.add(pathStr + FLAG_SEP + f);
  for (const child of node.children) walk(child, path, surface);
}

/** Build the combined command surface from a set of `{name, text}` sources. */
export function extractSurfaceFromSources(files: { name: string; text: string }[]): Surface {
  const surface: Surface = { commands: new Set(), flags: new Set() };
  for (const file of files) {
    for (const root of extractFile(file.name, file.text)) {
      walk(root, [], surface);
    }
  }
  return surface;
}
