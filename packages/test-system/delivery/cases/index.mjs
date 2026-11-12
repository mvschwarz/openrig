// Every case the suite runs, in run order: the first cases (s2.mjs), then issue #3076's late-gap cells (r3076.mjs), then dialogs (s3.mjs).

import { CASES as FIRST } from "./s2.mjs";
import { CASES as GAP3076 } from "./r3076.mjs";
import { CASES as DIALOGS } from "./s3.mjs";

export const CASES = [...FIRST, ...GAP3076, ...DIALOGS];
