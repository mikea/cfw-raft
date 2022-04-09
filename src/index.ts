export { CounterCluster, CounterMember } from "./examples/counter";

import { endpoint } from "@mikea/cfw-utils/endpoint";
import { PingCluster, StartCluster } from "./cluster";
import * as d from "@mikea/cfw-utils/decoder";
import { Handler, Server } from "@mikea/cfw-utils/server";
import { Env } from "./env";
import { call } from "@mikea/cfw-utils/call";
import { partialClusterConfig } from "./model";

const startResponse = d.struct({
  clusterId: d.string,
});

const Start = endpoint({
  path: "/counter/start",
  request: partialClusterConfig,
  response: startResponse,
});

const Ping = endpoint({
  path: "/counter/ping",
  request: d.struct({ clusterId: d.string }),
  response: d.struct({}),
});

const start: Handler<typeof Start, Env> = async (request, _, env) => {
  const id = env.counterCluster.newUniqueId();
  const clusterState = await call(env.counterCluster.get(id), StartCluster, request);
  if (clusterState instanceof Error) {
    return clusterState;
  }
  return { clusterId: clusterState.id };
};

const ping: Handler<typeof Ping, Env> = async (request, _, env) => {
  const clusterState = await call(
    env.counterCluster.get(env.counterCluster.idFromString(request.clusterId)),
    PingCluster,
    {},
  );
  if (clusterState instanceof Error) {
    return clusterState;
  }
  return { clusterId: clusterState.id };
};

const server = new Server<Env>().add(Start, start).add(Ping, ping);

export default {
  fetch: (request: Request, env: Env) => {
    return server.fetch(request, env);
  },
};
