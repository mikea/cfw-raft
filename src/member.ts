import { Env } from "./env";
import { IClusterStaticConfig } from "./model";
import { EventObject, interpret } from "xstate";
import { barrier } from "./promises";
import { httpMachine } from "./actors/http";
import { createMemberSupervisor } from "./actors/memberSupervisor";

export const CreateMemberActor = <S, A extends object>(staticConfig: IClusterStaticConfig<S, A>) => {
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

      interpreter.onEvent((event) => {
        console.error(`[${state.id}] received`, JSON.stringify(event));
      });

      this.fetch = async (request) => {
        const response = barrier<Response>();
        const body = await request.json<EventObject>();
        interpreter.send({ type: "request", body, callback: (t) => response.resolve(t) });
        return response.promise;
      };
    }
  };
};
