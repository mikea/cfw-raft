import { clientAppendEndpoint, createClusterActor } from "../objects/cluster.js";
import { IClusterStaticConfig, IStateMachine } from "../model.js";
import { createMemberActor } from "../objects/member.js";
import * as d from "@mikea/cfw-utils/dist/decoder.js";
import { MemberContext, MemberMessage } from "../actors/member.js";

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

export const counterStaticConfig: IClusterStaticConfig<State, Action> = {
  stateMachine,
  actions,
  memberActor: "counterMember",
  clusterActor: "counterCluster",
};

export const CounterMember = createMemberActor(counterStaticConfig);
export const CounterCluster = createClusterActor(counterStaticConfig);

export const CounterClientAppend = clientAppendEndpoint(counterStaticConfig);

// these types help write tests
export type CounterContext = MemberContext<State, Action>;
export type CounterMessage = MemberMessage<Action>;
