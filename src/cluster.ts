import { Env } from "./env";
import { Handler, Server } from "@mikea/cfw-utils/server";
import { endpoint } from "@mikea/cfw-utils/endpoint";
import { call } from "@mikea/cfw-utils/call";
import { cell } from "@mikea/cfw-utils/storage";
import * as d from "@mikea/cfw-utils/decoder";
import { IMemberState, PingMember, StartMember } from "./member";
import { log } from "./log";

export const clusterConfig = d.struct({
  members: d.number,
});
type IClusterConfig = d.TypeOf<typeof clusterConfig>;

interface IClusterState {
  id: string;
  members: IMemberState[];
}

export const StartCluster = endpoint<IClusterConfig, IClusterState>({
  path: "/start_cluster",
});

interface IPingRequest {}
export const PingCluster = endpoint<IPingRequest, IClusterState>({
  path: "/ping_cluster",
});

export class ClusterActor {
  constructor(public readonly state: DurableObjectState, private readonly env: Env) {}

  private readonly clusterState = cell<IClusterState>(this, "clusterState");

  private readonly start: Handler<typeof StartCluster> = async (request) => {
    const maybeMembers = await Promise.all(Array.from(Array(request.members)).map(() => this.startMember()));
    for (const member of maybeMembers) {
      if (member instanceof Error) {
        // todo: better error handling for start.
        return member;
      }
    }
    const members = maybeMembers as IMemberState[];
    const state = { members, id: this.state.id.toString() };
    log({ state });
    return this.clusterState.put(state);
  };

  private async startMember(): Promise<IMemberState | Error> {
    return call(this.env.memberActor.get(this.env.memberActor.newUniqueId()), StartMember, {});
  }

  private readonly ping: Handler<typeof PingCluster> = async () => {
    const state = await this.clusterState.get();
    if (!state) return new Error("bad state");

    const maybeMembers = await Promise.all(state.members.map(this.pingNode));
    for (const member of maybeMembers) {
      if (member instanceof Error) {
        return member;
      }
    }
    const members = maybeMembers as IMemberState[];
    const newState = { ...state, members };
    log({ newState });
    return this.clusterState.put(state);
  };

  private readonly pingNode = async (member: IMemberState): Promise<IMemberState | Error> => {
    return call(this.env.memberActor.get(this.env.memberActor.idFromString(member.id)), PingMember, {});
  };

  readonly server = new Server<Env>().add(StartCluster, this.start).add(PingCluster, this.ping);

  async fetch(request: Request): Promise<Response> {
    return this.server.fetch(request, this.env);
  }
}
