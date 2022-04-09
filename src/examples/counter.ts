import { ClusterActor } from "../cluster";
import { MemberActor } from "../member";
import { IStateMachine } from "../model";
import { Env } from "../env";

interface State {
  count: number;
}

type Action = { type: "inc" };

const stateMachine: IStateMachine<State, Action> = {
  initial: { count: 0 },
  reduce(state, action) {
    switch (action.type) {
      case "inc":
        return { ...state, count: state.count + 1 };
    }
  },
};

// todo: doesn't work;
// export const CounterMember = CreateMemberActor(stateMachine);

export class CounterMember extends MemberActor<State, Action> {
  protected override config(env: Env) {
    return { stateMachine, member: env.counterMember };
  }
}

export class CounterCluster extends ClusterActor {
  protected override config(env: Env) {
    return { member: env.counterMember, cluster: env.counterCluster };
  }
}
