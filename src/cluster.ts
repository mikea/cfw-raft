import { Env } from "./env";
import { Handler, Server } from "@mikea/cfw-utils/server";
import { endpoint } from "@mikea/cfw-utils/endpoint";
import { call } from "@mikea/cfw-utils/call";
import { cell } from "@mikea/cfw-utils/storage";
import * as d from "@mikea/cfw-utils/decoder";
import { StartMember } from "./member";
import { log } from "./log";

export const clusterConfig = d.struct({
  nodes: d.number,
});
type IClusterConfig = d.TypeOf<typeof clusterConfig>;

interface INodeState {
  id: string;
}

interface IClusterState {
  clusterId: string;
  nodes: INodeState[];
}

export const StartCluster = endpoint<IClusterConfig, IClusterState>({
  path: "/start",
});

export class ClusterActor {
  constructor(public readonly state: DurableObjectState, private readonly env: Env) {}

  private readonly clusterState = cell<IClusterState>(this, "clusterState");

  private readonly start: Handler<typeof StartCluster> = async (request) => {
    const maybeNodes = await Promise.all(Array.from(Array(request.nodes)).map(() => this.startMember()));
    for (const node of maybeNodes) {
      if (node instanceof Error) {
        // todo: better error handling for start.
        return node;
      }
    }
    const nodes = maybeNodes as INodeState[];
    const state = { nodes, clusterId: this.state.id.toString() };
    log({ state });
    return this.clusterState.put(state);
  };

  private async startMember(): Promise<INodeState | Error> {
    const id = this.env.memberActor.newUniqueId();
    const result = await call(this.env.memberActor.get(id), StartMember, {});
    if (result instanceof Error) {
      return result;
    }
    return { id: id.toString() };
  }

  readonly server = new Server<Env>().add(StartCluster, this.start);

  async fetch(request: Request): Promise<Response> {
    return this.server.fetch(request, this.env);
  }
}
