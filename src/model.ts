import * as d from "@mikea/cfw-utils/decoder";
import { Env } from "./env";

export const partialClusterConfig = d.partial({
  members: d.number,
  electionDelayMs: d.number,
});
export type IPartialClusterConfig = d.TypeOf<typeof partialClusterConfig>;
export type IClusterConfig = Required<IPartialClusterConfig>;

export interface IClusterState {
  id: string;
  members: string[];
}

export interface IStateMachine<S, A extends object> {
  initial: S;
  reduce(state: S, action: A): S;
}
export interface IClusterStaticConfig<S, A extends object> {
  stateMachine: IStateMachine<S, A>;
  memberActor: keyof Env;
  clusterActor: keyof Env;
}

export interface IMemberConfig {
  others: string[];
  electionDelayMs: number;
}

export interface ILogEntry<A extends object> {
  action: A;
  term: number;
  index: number;
}

export interface IMemberState<S, A extends object> {
  currentTerm: number;
  votedFor?: string;

  log: Array<ILogEntry<A>>;
  state: S;

  // todo: these 2 are volatile
  commitIndex: number;
  lastApplied: number;
  // only on leader
  // todo: volatile
  syncState: Record<string, ISyncState>;
}


export interface ISyncState {
  nextIndex: number;
  matchIndex: number;
}