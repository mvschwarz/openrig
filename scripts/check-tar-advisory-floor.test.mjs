// A dependency bump alone drifts: the next `npm install` can move it back into a range that admits the
// advisories this bump left behind. This pins the floor on the dependency that sits on the bundle
// safety path — the archive pre-scan and extraction both use it — so re-admitting the advisory band
// fails a check rather than waiting for someone to run `npm audit`.
//
// The band is the one npm reported: every tar <= 7.5.20, including the PAX size-override
// interpretation differential, the negative-size infinite loop, and the recursion overflow.
//
// The range is read, not just its first number. `^7.5.13`, `<7.5.21` and `^7.5.21 || 7.5.13` all name
// a version at or above the floor first and still admit the band, so the check asks what the range
// admits at its lowest and compares that with the floor.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const FLOOR = [7, 5, 21];
const BAND_TOP = [7, 5, 20];

const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
const below = (a, b) => compare(a, b) < 0;

/**
 * The lowest version this range admits, as a `[major, minor, patch]` triple.
 *
 * The forms below are the ones a manifest here uses. Anything unparsed is treated as unbounded rather
 * than guessed at, which fails closed: a range this cannot read is a range this cannot vouch for.
 */
function lowestAdmitted(range) {
  const results = range.split("||").map((alternative) => {
    let lowest = null;
    for (const token of alternative.trim().split(/\s+/).filter(Boolean)) {
      if (token === "*" || token === "x" || token === "X" || token === "latest") return [0, 0, 0];
      const match = /^(>=|>|<=|<|=|\^|~)?v?(\d+)\.(\d+)\.(\d+)$/.exec(token);
      if (!match) return [0, 0, 0];
      const version = [Number(match[2]), Number(match[3]), Number(match[4])];
      switch (match[1]) {
        // A partial or caret range admits its own version and everything above it.
        case undefined: case "=": case "^": case "~":
          if (lowest === null || compare(version, lowest) > 0) lowest = version;
          break;
        case ">=":
          if (lowest === null || compare(version, lowest) > 0) lowest = version;
          break;
        // `>x` admits nothing at x itself; the next patch is the lowest thing it can admit. The
        // incremented bound is what gets compared, so `>=7.5.20 >7.5.20` is read as 7.5.21 and accepted
        // rather than as its own lower bound of 7.5.20.
        case ">": {
          const above = [version[0], version[1], version[2] + 1];
          if (lowest === null || compare(above, lowest) > 0) lowest = above;
          break;
        }
        // An upper bound alone leaves the range open below.
        case "<": case "<=":
          if (lowest === null) lowest = [0, 0, 0];
          break;
      }
    }
    return lowest ?? [0, 0, 0];
  });
  return results.reduce((lowest, next) => (compare(next, lowest) < 0 ? next : lowest));
}

function tarRange(packageJsonPath) {
  const manifest = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  const range = { ...manifest.dependencies, ...manifest.devDependencies }.tar;
  assert.ok(range, `${packageJsonPath} lists tar`);
  return range;
}

test("the daemon and the CLI require a tar past the advisory band", () => {
  for (const manifest of ["packages/daemon/package.json", "packages/cli/package.json"]) {
    const range = tarRange(path.join(import.meta.dirname, "..", manifest));
    const lowest = lowestAdmitted(range);
    assert.ok(
      !below(lowest, FLOOR),
      `${manifest} requires tar ${range}, whose lowest admitted version ${lowest.join(".")} is inside the band (<= ${BAND_TOP.join(".")})`,
    );
  }
});

test("the range check rejects the ranges that name a high version and still admit the band", () => {
  for (const range of ["^7.5.21", ">=7.5.21", "~7.5.21", "7.5.23", ">=7.5.21 <8.0.0", ">7.5.20", ">=7.5.20 >7.5.20"]) {
    assert.ok(!below(lowestAdmitted(range), FLOOR), `${range} is accepted`);
  }
  for (const range of ["^7.5.13", "7.5.13", ">=7.5.13", "<7.5.21", "*", "latest", "^7.5.21 || 7.5.13", ">=7.5.14 <7.5.20"]) {
    assert.ok(below(lowestAdmitted(range), FLOOR), `${range} is refused`);
  }
});