import { Env } from "../env.js";
import { IClusterStaticConfig } from "../model.js";
import { EventObject, interpret } from "xstate";
import { barrier } from "../promises.js";
import { httpMachine } from "../actors/http.js";
import { createMemberSupervisor } from "../actors/memberSupervisor.js";

export const createMemberActor = <S, A>(staticConfig: IClusterStaticConfig<S, A>) => {
  return class {
    public readonly fetch: (request: Request) => Promise<Response>;
    constructor(state: DurableObjectState, env: Env) {
      const member = createMemberSupervisor({
        doState: state,
        env,
        staticConfig,
      });
      const interpreter = interpret(httpMachine.withContext({ handler: member }));
      interpreter.start();

      this.fetch = async (request) => {
        const response = barrier<Response>();
        const body = await request.json<EventObject>();
        interpreter.send({ type: "request", body, callback: (t) => response.resolve(t) });
        return response.promise;
      };
    }
  };
};
