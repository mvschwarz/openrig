# Worktree builds: use a per-worktree install, never a symlinked `node_modules`

**Filed as** build friction (a TS2688 `@types/node` failure). **Grounded as** something worse:
the symlink shortcut that avoids the install produces builds and typechecks that silently
consume ANOTHER tree's source — a false-green generator, not an inconvenience.

## What actually happens

`npm install` in a worktree creates `node_modules/@openrig/<pkg>` as a RELATIVE symlink
(`-> ../../packages/<pkg>`). Relative links resolve against the directory they live in, so:

| setup | `@openrig/daemon` resolves to | verdict |
|---|---|---|
| per-worktree `npm install` | that worktree's `packages/daemon` | correct |
| `ln -s <primary>/node_modules node_modules` | **the PRIMARY tree's** `packages/daemon` | **cross-tree** |

Verified by discriminator, not by inference: with a symlinked `node_modules`, a deliberate type
error introduced in the WORKTREE's `packages/daemon` is seen by that package's own `tsc` and NOT
seen by `packages/cli`'s `tsc`, which exits 0 — because it type-checked the primary tree's daemon.
A worktree can therefore report green against code it does not contain.

## Rules

1. **Run `npm install` in each worktree** (~4s, one time). It is not the slow path; it is the
   only path that resolves workspace packages to the worktree's own source.
2. **Never symlink `node_modules` from the primary checkout.** It appears to work — builds pass,
   typechecks pass — which is exactly the danger.
3. **`npx tsc` with no `node_modules` installs an unrelated 12-year-old `tsc` package** and prints
   "This is not the tsc command you are looking for". That message means *no install*, not a
   TypeScript error.
4. **Build `@openrig/daemon` before typechecking `@openrig/cli`** in a fresh worktree: cli imports
   `@openrig/daemon/crash-cart` etc., which resolve to daemon's `dist`. Absent dist reads as
   TS2307 "Cannot find module" plus a cascade of implicit-any — a provisioning artifact, not a
   code defect.

## Self-check before trusting any worktree build

    [ "$(readlink -f packages/daemon)" = "$(readlink -f node_modules/@openrig/daemon)" ] \
      || echo "CROSS-TREE: this worktree resolves @openrig/* into another tree"
