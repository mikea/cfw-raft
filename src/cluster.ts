import { Env } from "./env";
import { Handler, Server } from "@mikea/cfw-utils/server";
import { endpoint } from "@mikea/cfw-utils/endpoint";
import { call } from "@mikea/cfw-utils/call";
import { cell, getFromString } from "@mikea/cfw-utils/storage";
import { PingMember, StartMember } from "./member";
import { log } from "./log";
import { liftError } from "./errors";
import { IClusterConfig, IClusterState, IPartialClusterConfig, partialClusterConfig } from "./model";

const defaultClusterConfig: IClusterConfig = {
  members: 5,
  initDelayMs: 100,
};

export const StartCluster = endpoint<IPartialClusterConfig, IClusterState>({
  path: "/start_cluster",
  request: partialClusterConfig,
});

interface IPingRequest {}
export const PingCluster = endpoint<IPingRequest, IClusterState>({
  path: "/ping_cluster",
});

export class ClusterActor {
  private readonly memberActor: DurableObjectNamespace;
  private readonly clusterActor: DurableObjectNamespace;

  constructor(public readonly state: DurableObjectState, private readonly env: Env) {
    const config = this.config(env);
    this.memberActor = config.member;
    this.clusterActor = config.cluster;
  }

  protected config(_env: Env): { member: DurableObjectNamespace; cluster: DurableObjectNamespace } {
    throw new Error("not implemented");
  }

  private readonly clusterState = cell<IClusterState>(this, "clusterState");

  private readonly start: Handler<typeof StartCluster> = async (request) => {
    const ids: DurableObjectId[] = [];
    const config = { ...defaultClusterConfig, ...request };
    for (let i = 0; i < config.members; i++) {
      ids.push(this.memberActor.newUniqueId());
    }
    const strIds = ids.map((id) => id.toString());

    const members = liftError(
      await Promise.all(
        ids.map((id, idx) => {
          const others = Array.from(strIds);
          others.splice(idx, 1);
          return call(this.memberActor.get(id), StartMember, { others, initDelayMs: config.initDelayMs });
        }),
      ),
    );
    if (members instanceof Error) {
      return members;
    }
    const state = { members, id: this.state.id.toString() };
    log("cluster start", { state });
    return this.clusterState.put(state);
  };

  private readonly ping: Handler<typeof PingCluster> = async () => {
    const state = await this.clusterState.get();
    if (!state) return new Error("bad state");

    const members = liftError(
      await Promise.all(
        state.members.map((member) => {
          return call(getFromString(this.memberActor, member.id), PingMember, {});
        }),
      ),
    );
    if (members instanceof Error) {
      return members;
    }
    const newState = { ...state, members };
    log({ newState });
    return this.clusterState.put(newState);
  };

  readonly server = new Server<Env>().add(StartCluster, this.start).add(PingCluster, this.ping);

  async fetch(request: Request): Promise<Response> {
    return this.server.fetch(request, this.env);
  }
}
