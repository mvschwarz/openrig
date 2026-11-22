// Loaded only by the conformance-check tests that ask for it: node --require into the check, and through NODE_OPTIONS
// (passed on with the check's --pass-env) into the runner double and the fake agent it starts. With OPENRIG_TEST_CLOCK_SCALE
// (a factor above 1) and OPENRIG_TEST_CLOCK_EPOCH (a shared start, in ms) both set, the three processes read one clock that
// runs that many times faster: Date counts scaled time from the shared start, and every timer's delay shrinks by the same
// factor. Each window the check waits, each beat the double sends and each time the check compares then keeps its value
// in scaled time, so a bound is exactly as strict as in a real run. Only real I/O latency counts for more in scaled terms.
// Without both variables, nothing changes.
const factor = Number(process.env.OPENRIG_TEST_CLOCK_SCALE);
const epoch = Number(process.env.OPENRIG_TEST_CLOCK_EPOCH);
if (factor > 1 && Number.isFinite(epoch)) {
  const RealDate = Date;
  const scaledNow = () => Math.floor(epoch + (RealDate.now() - epoch) * factor);
  globalThis.Date = class extends RealDate {
    constructor(...args) { if (args.length === 0) super(scaledNow()); else super(...args); }
    static now() { return scaledNow(); }
  };
  const shrink = (ms) => (typeof ms === "number" && ms > 0 ? ms / factor : ms);
  const { setTimeout: realSetTimeout, setInterval: realSetInterval } = globalThis;
  globalThis.setTimeout = (fn, ms, ...rest) => realSetTimeout(fn, shrink(ms), ...rest);
  globalThis.setInterval = (fn, ms, ...rest) => realSetInterval(fn, shrink(ms), ...rest);
}
