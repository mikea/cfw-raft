import { CreateClusterActor } from "../cluster";
import { IClusterStaticConfig, IStateMachine } from "../model";
import { CreateMemberActor } from "../member";

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

const staticConfig: IClusterStaticConfig<State, Action> = {
  stateMachine,
  memberActor: "counterMember",
  clusterActor: "counterCluster",
};

export const CounterMember = CreateMemberActor(staticConfig);
export const CounterCluster = CreateClusterActor(staticConfig);
