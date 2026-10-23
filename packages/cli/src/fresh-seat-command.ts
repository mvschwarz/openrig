/**
 * The one-seat command printed for a seat a restore left awaiting a decision. `rig up --existing <rig> --fresh <seat>`
 * is refused while sibling seats run, which is the state a partial restore leaves. The restore result names each
 * seat by its logical id and carries the rig's name, but not the seat's session name. `rig seat launch` resolves
 * `<logical id>@<rig>` to the seat with exactly that logical id in that rig, so dotted legacy ids such as
 * `dev.ops.impl` and `dev.ops-impl` each get a command for their own seat.
 */
export function freshSeatCommand(logicalId: string, rigName: string): string {
  return `rig seat launch ${logicalId}@${rigName} --fresh --reason "fresh-prime after restore"`;
}
