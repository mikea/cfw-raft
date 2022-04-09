import * as d from "@mikea/cfw-utils/decoder";

export const partialClusterConfig = d.partial({
  members: d.number,
  initDelayMs: d.number,
});
export type IPartialClusterConfig = d.TypeOf<typeof partialClusterConfig>;
export type IClusterConfig = Required<IPartialClusterConfig>;

export interface IClusterState {
  id: string;
  members: IMemberState[];
}

export interface IStateMachine<S, A extends object> {
  initial: S;
  reduce(state: S, action: A): S;
}

type Role = "follower" | "candidate" | "leader";

export interface IMemberConfig {
  others: string[];
  initDelayMs: number;
}

export interface IMemberState {
  id: string;
  role: Role;
  currentTerm: number;
  votedFor?: string;
}
