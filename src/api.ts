import * as d from "@mikea/cfw-utils/decoder";

export const partialClusterConfig = d.partial({
  members: d.number,
  electionDelayMs: d.number,
  updatePeriod: d.number,
});
export type IPartialClusterConfig = d.TypeOf<typeof partialClusterConfig>;

const appendRequestBase = {
  type: d.literal("clientAppend"),
  consistency: d.literal("no_wait"),
};

export function clientAppendRequestDecoder<A>(entry: d.Decoder<A>) {
  return d.struct({ ...appendRequestBase, entries: d.array(entry) });
}
const clientAppendRequestNoEntries = d.struct(appendRequestBase);
export type IClientAppendRequest<A> = d.TypeOf<typeof clientAppendRequestNoEntries> & { entries: A[] };
