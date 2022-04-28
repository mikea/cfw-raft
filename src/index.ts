export { CounterCluster, CounterMember } from "./examples/counter";

import { endpoint } from "@mikea/cfw-utils/endpoint";
import { StartCluster } from "./objects/cluster";
import * as d from "@mikea/cfw-utils/decoder";
import { Handler, Server } from "@mikea/cfw-utils/server";
import { Env } from "./env";
import { call } from "@mikea/cfw-utils/call";
import { partialClusterConfig } from "./api";
import { CounterClientAppend } from "./examples/counter";
import { getFromString } from "@mikea/cfw-utils/storage";

const startResponse = d.struct({
  clusterId: d.string,
});

const Start = endpoint({
  path: "/counter/start",
  request: partialClusterConfig,
  response: startResponse,
});

const Inc = endpoint({
  path: "/counter/inc",
  request: d.struct({ clusterId: d.string }),
  response: d.struct({ value: d.number }),
});

const start: Handler<typeof Start, Env> = async (request, _, env) => {
  const id = env.counterCluster.newUniqueId();
  const clusterState = await call(env.counterCluster.get(id), StartCluster, request);
  if (clusterState instanceof Error) {
    return clusterState;
  }
  return { clusterId: clusterState.id };
};

const inc: Handler<typeof Inc, Env> = async (request, _, env) => {
  const clusterState = await call(getFromString(env.counterCluster, request.clusterId), CounterClientAppend, {
    type: "clientAppend",
    entries: [{ type: "inc" }],
    consistency: "no_wait",
  });
  if (clusterState instanceof Error) {
    return clusterState;
  }
  // todo
  return { value: 0 };
};

const server = new Server<Env>().add(Start, start).add(Inc, inc);
export default {
  fetch: (request: Request, env: Env) => {
    return server.fetch(request, env);
  },
};
