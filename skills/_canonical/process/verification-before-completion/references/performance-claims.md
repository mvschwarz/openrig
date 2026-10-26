# Performance claims

Read this before claiming that a change makes something faster, lighter or more responsive. It's for a performance claim, not for every change.

- Bind the claim to the versions, fixture and workload you measured.
- Count the correct work completed and the failures, as well as the time. A speedup that comes from doing less work isn't one.
- Keep the relevant setup comparable between the runs you compare, and separate what your instrumentation costs from what you measure.
- Report the repetitions and the variability, and state the limits. Choose enough repetitions to support the precision you claim; there's no fixed minimum.
- Freeze a suitable harness while you compare candidates.
- Stop when the selected outcome is met, or when the remaining experiments no longer justify their cost. An honest negative result is a result; keep it.

Adapted from the benchmark-checklist method in Cursor's pstack plugin (https://github.com/cursor/plugins/tree/190d28736eff128ec94f502a22c7fe0c4b56cd37/pstack).
