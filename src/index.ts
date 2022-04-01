export { MemberActor } from "./member";
export { ClusterActor } from "./cluster";
import { endpoint } from "@mikea/cfw-utils/endpoint";
import { clusterConfig, StartCluster } from "./cluster";
import * as d from "@mikea/cfw-utils/decoder";
import { Handler, Server } from "@mikea/cfw-utils/server";
import { Env } from "./env";
import { call } from "@mikea/cfw-utils/call";

const startResponse = d.struct({
    clusterId: d.string,
});

const Start = endpoint({
    path: "/start",
    request: clusterConfig,
    response: startResponse,
});

const start: Handler<typeof Start, Env> = async (request, _, env) => {
    const id = env.clusterActor.newUniqueId();
    const clusterState = await call(env.clusterActor.get(id), StartCluster, request);
    if (clusterState instanceof Error) {
        return clusterState;
    }
    return { clusterId: clusterState.clusterId };
};

const server = new Server<Env>().add(Start, start);


export default {
    fetch: (request: Request, env: Env) => { return server.fetch(request, env); },
  };
   