import * as d from "@mikea/cfw-utils/decoder";
import { Env } from "./env";

export const partialClusterConfig = d.partial({
  members: d.number,
  electionDelayMs: d.number,
  updatePeriod: d.number,
});
export type IPartialClusterConfig = d.TypeOf<typeof partialClusterConfig>;
export type IClusterConfig = Required<IPartialClusterConfig>;

export interface IClusterState {
  id: string;
  members: string[];
}

export interface IStateMachine<S, A> {
  initial: S;
  reduce(state: S, action: A): S;
}
export interface IClusterStaticConfig<S, A> {
  stateMachine: IStateMachine<S, A>;
  memberActor: keyof Env;
  clusterActor: keyof Env;
}

export interface IMemberConfig {
  others: string[];
  electionDelayMs: number;
  updatePeriodMs: number;
}

export interface ILogEntry<A> {
  action: A;
  term: number;
  index: number;
}

export interface IMemberState<S, A> {
  currentTerm: number;

  log: Array<ILogEntry<A>>;
  state: S;
}


export interface ISyncState {
  nextIndex: number;
  matchIndex: number;
}