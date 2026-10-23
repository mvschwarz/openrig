/**
 * Shipped decision templates, authored as YAML and parsed by the same loader as a custom
 * `<decisions.template_dir>/<name>.yaml`, which replaces the shipped template of that name.
 * A template is instructions plus a typed answer contract; it never runs a command or a tool.
 * `criteria_from` names options the consumer supplies at call time (its real owners or work).
 */
export const SHIPPED_TEMPLATES: Record<string, string> = {
  stream: `name: stream
version: 1
instructions: >-
  An agent posted an observation to the OpenRig stream. Decide what should happen to it, using only
  the observation and the owners and work supplied with it.
questions:
  disposition:
    type: choice
    instructions: What should happen to this observation?
    criteria:
      create: It warrants new owned work that none of the supplied work already covers.
      join: It belongs to one of the supplied current work items.
      duplicate: It repeats a supplied work item without adding anything new.
      no_action: It is information only; no work is warranted.
  owner:
    type: choice
    instructions: Which supplied owner should hold the work it creates or joins?
    criteria_from: owners
    required: false
  work:
    type: choice
    instructions: Which supplied work item does it join or duplicate?
    criteria_from: work
    required: false
`,
};
