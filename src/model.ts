import { d } from "@mikea/cfw-utils";
import { IPartialClusterConfig } from "./api";
import { Env } from "./env";

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
  actions: d.Decoder<A>;
}

export interface IMemberConfig {
  electionDelayMs: number;
  updatePeriodMs: number;
}

export interface ILogEntry<A> {
  action: A;
  term: number;
  index: number;
}

export interface IMemberPersistentState<S, A> {
  currentTerm: number;

  // persistent to prevent double-voting
  // todo: can be removed by better tracking of votes on candidate
  votedFor?: string;

  // todo: move out.
  log: Array<ILogEntry<A>>;

  // todo: move out.
  replicatedState: IReplicatedState<S>;
}

export interface IReplicatedState<S> {
  s: S;
  term: number;
  index: number;
}
export interface ISyncState {
  nextIndex: number;
  matchIndex: number;
}
