import { clientAppendEndpoint, createClusterActor } from "../objects/cluster";
import { IClusterStaticConfig, IStateMachine } from "../model";
import { createMemberActor } from "../objects/member";
import * as d from "@mikea/cfw-utils/decoder";

interface State {
  count: number;
}

const actions = d.union([d.struct({ type: d.literal("inc") }), d.struct({ type: d.literal("dec") })]);

type Action = d.TypeOf<typeof actions>;

const stateMachine: IStateMachine<State, Action> = {
  initial: { count: 0 },
  reduce(state, action) {
    switch (action.type) {
      case "inc":
        return { ...state, count: state.count + 1 };
      case "dec":
        return { ...state, count: state.count - 1 };
    }
  },
};

const staticConfig: IClusterStaticConfig<State, Action> = {
  stateMachine,
  actions,
  memberActor: "counterMember",
  clusterActor: "counterCluster",
};

export const CounterMember = createMemberActor(staticConfig);
export const CounterCluster = createClusterActor(staticConfig);

export const CounterClientAppend = clientAppendEndpoint(staticConfig);
