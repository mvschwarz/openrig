// The learned host bindings' queue-routing rule, for the CLI: the queue verbs that call another host's daemon
// directly (#2637) resolve a self-id through the same eligible bindings the daemon's queue forwarder does.
export { eligibleQueueBindings, ineligibleBindingDetail } from "./domain/hosts/learned-host-bindings.js";
