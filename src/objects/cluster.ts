import { Env } from "../env";
import { Handler, Server } from "@mikea/cfw-utils/server";
import { endpoint } from "@mikea/cfw-utils/endpoint";
import { call } from "@mikea/cfw-utils/call";
import { cell, getFromString } from "@mikea/cfw-utils/storage";
import { log } from "../log";
import { liftError } from "../errors";
import { IClusterConfig, IClusterState, IClusterStaticConfig } from "../model";
import { IClientAppendResponse, Start } from "../messages";
import { clientAppendRequestDecoder, IClientAppendRequest, IPartialClusterConfig, partialClusterConfig } from "../api";
import { newRandom32 } from "@mikea/cfw-utils/random";

const random = newRandom32(Date.now());

const defaultClusterConfig: IClusterConfig = {
  members: 5,
  electionDelayMs: 5000,
  updatePeriod: 1000,
};

export const StartCluster = endpoint<IPartialClusterConfig, IClusterState>({
  path: "/start_cluster",
  request: partialClusterConfig,
});

export function clientAppendEndpoint<S, A>(staticConfig: IClusterStaticConfig<S, A>) {
  return endpoint<IClientAppendRequest<A>, IClientAppendResponse>({
    path: "/client_append",
    request: clientAppendRequestDecoder(staticConfig.actions),
  });
}

export const createClusterActor = <S, A extends object>(staticConfig: IClusterStaticConfig<S, A>) => {
  return class {
    public readonly fetch: (request: Request) => Promise<Response>;

    constructor(durableObjectState: DurableObjectState, env: Env) {
      const clusterState = cell<IClusterState>({ state: durableObjectState }, "clusterState");
      const memberActor = env[staticConfig.memberActor];

      const onStart: Handler<typeof StartCluster> = async (request) => {
        const ids: DurableObjectId[] = [];
        const config = { ...defaultClusterConfig, ...request };
        for (let i = 0; i < config.members; i++) {
          ids.push(memberActor.newUniqueId());
        }
        const strIds = ids.map((id) => id.toString());

        const members = liftError(
          await Promise.all(
            ids.map((id, idx) => {
              const others = Array.from(strIds);
              others.splice(idx, 1);
              return call(memberActor.get(id), Start, {
                type: "startRequest",
                config: {
                  electionDelayMs: config.electionDelayMs + (random.randU32() % config.updatePeriod),
                  updatePeriodMs: config.updatePeriod,
                },
              });
            }),
          ),
        );
        if (members instanceof Error) {
          return members;
        }
        const state = { members: strIds, id: durableObjectState.id.toString() };
        log("cluster start", { state });
        return clusterState.put(state);
      };

      const clientAppend = clientAppendEndpoint(staticConfig);
      const onClientAppend: Handler<typeof clientAppend> = async (request) => {
        const state = await clusterState.get();
        if (!state) return new Error("bad state");

        let memberId = state.members[random.randU32() % state.members.length];

        for (;;) {
          const reply = await call(getFromString(memberActor, memberId), clientAppend, request);
          if (reply instanceof Error) return reply;
          if (reply.success) return reply;

          switch (reply.reason) {
            case "not_a_leader": {
              memberId = reply.leader ?? state.members[random.randU32() % state.members.length];
              break;
            }
            default: {
              return new Error("unexpected error: " + JSON.stringify(reply));
            }
          }
        }
      };

      const server = new Server<Env>().add(StartCluster, onStart).add(clientAppend, onClientAppend);
      this.fetch = (request) => server.fetch(request, env);
    }
  };
};
