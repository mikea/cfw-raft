import { Env } from "./env";
import { Handler, Server } from "@mikea/cfw-utils/server";
import { call } from "@mikea/cfw-utils/call";
import { endpoint } from "@mikea/cfw-utils/endpoint";
import { cachedCell, getFromString, ICachedCell } from "@mikea/cfw-utils/storage";
import { IRandom32, newRandom32 } from "@mikea/cfw-utils/random";
import { log } from "./log";
import { timeout } from "./promises";
import { liftError } from "./errors";
import { IClusterStaticConfig, ILogEntry, IMemberConfig, IMemberState, ISyncState } from "./model";

export const StartMember = endpoint<IMemberConfig, IMemberState<unknown, object>>({
  path: "/start_member",
});

export const PingMember = endpoint<object, IMemberState<unknown, object>>({
  path: "/ping_member",
});

interface IVoteRequest {
  term: number;
  sourceId: string;
  lastLogIndex: number;
  lastLogTerm: number;
}

interface IVoteResponse {
  term: number;
  voteGranted: boolean;
}

export const Vote = endpoint<IVoteRequest, IVoteResponse>({
  path: "/vote",
});

interface IAppendRequest<A extends object> {
  term: number;
  sourceId: string;

  entries: ILogEntry<A>[];
  prevLogIndex: number;
  prevLogTerm: number;
  leaderCommit: number;
}

export type IAppendResponse = {
  success: false;
} | {
  term: number;
  matchIndex: number;
  success: true;
}

export const Append = endpoint<IAppendRequest<object>, IAppendResponse>({
  path: "/append",
});

export const CreateMemberActor = <S, A extends object>(staticConfig: IClusterStaticConfig<S, A>) => {
  return class {
    public readonly fetch: (request: Request) => Promise<Response>;
    constructor(state: DurableObjectState, env: Env) {
      const impl = new MemberActor<S, A>(state, env, staticConfig);
      this.fetch = (request) => impl.fetch(request);
    }
  };
};

class MemberActor<S, A extends object> {
  readonly id: string;
  readonly random: IRandom32;
  readonly memberConfig: ICachedCell<IMemberConfig>;
  readonly memberState: ICachedCell<IMemberState<S, A>>;
  readonly memberActor: DurableObjectNamespace;

  constructor(
    public readonly state: DurableObjectState,
    private readonly env: Env,
    private readonly staticConfig: IClusterStaticConfig<S, A>,
  ) {
    this.id = this.state.id.toString();
    this.random = newRandom32(toSeed(this.id));
    this.memberConfig = cachedCell(this.state, "config");
    this.memberState = cachedCell(this.state, "state");
    this.memberActor = env[staticConfig.memberActor];
  }

  readonly onStart: Handler<typeof StartMember> = async (config) => {
    const initDelay = (this.random.randU32() % config.initDelayMs) + config.initDelayMs;
    this.log("start", { config });
    await this.memberConfig.put(config);

    const state: IMemberState<S, A> = {
      role: "follower",
      id: this.id,
      currentTerm: 0,
      log: [],
      state: this.staticConfig.stateMachine.initial,

      commitIndex: -1,
      lastApplied: -1,
      syncState: {},
    };
    await this.memberState.put(state);

    await timeout(initDelay);

    await this.maybeStartElection();
    this.log("member started");
    return state;
  };

  private async maybeStartElection() {
    const config = this.memberConfig.value;
    if (!config) return new Error("missing config");

    if (!this.memberState.value) return new Error("missing state");
    let state = this.memberState.value;

    if (state.votedFor || state.role !== "follower") return;

    this.log("starting election");
    const currentTerm = state.currentTerm + 1;
    state = { ...state, currentTerm, votedFor: this.id, role: "candidate" };
    await this.memberState.put(state);

    const lastLogEntry = last(state.log);
    // todo: replace -1 with 0?
    const lastLogTerm = lastLogEntry ? lastLogEntry.term : -1;
    const lastLogIndex = lastLogEntry ? lastLogEntry.index : -1;

    const voteRequest: IVoteRequest = {
      term: state.currentTerm,
      sourceId: this.id,
      lastLogIndex: lastLogIndex,
      lastLogTerm: lastLogTerm,
    };

    // todo: election timer
    // todo: wait for majority, not all
    const responses = liftError(
      await Promise.all(
        config.others.map((memberId) => call(getFromString(this.memberActor, memberId), Vote, voteRequest)),
      ),
    );
    // todo: some errors are OK.
    if (responses instanceof Error) return responses;

    // todo: check current state term

    const votes = responses.filter((r) => r.voteGranted && r.term === state.currentTerm).length;
    this.log("got all vote responses", { votes });

    const majority = (config.others.length + 1) / 2;
    if (votes >= majority) {
      const syncState:Record<string, ISyncState> = {};
      for (const memberId of config.others) {
        syncState[memberId] = {
          nextIndex: lastLogIndex + 1,
          matchIndex: 0,
        };
      }
      // todo: re-read state and check it.
      state = { ...state, role: "leader", syncState };
      this.log("got majority", { votes, state });
      await this.memberState.put(state);
      await this.sendHeartbeats(state, config);
    }

    // todo: retry
  }

  private async sendHeartbeats(state: IMemberState<S,A>, config: IMemberConfig) {
    // todo: don't wait for all heartbeats to finish
    const responses = liftError(
      await Promise.all(
        config.others.map((memberId) => {
          return this.sendAppend(state, memberId);
        }
        ),
      ),
    );
    return responses;
  }

  readonly onAppend: Handler<typeof Append> = async (request) => {
    if (!this.memberState.value) return new Error("missing state");
    let state = this.memberState.value;
    this.log("append", { request, state });

    // drop old request
    if (request.term < state.currentTerm) return { success: false, term: request.term };

    const prevLogI = state.log.findIndex(e => e.index == request.prevLogIndex);
    const prevLogEntry = prevLogI >= 0 ? state.log[prevLogI] : undefined;
    const logOk = (request.prevLogIndex === -1) ||
      // we need to have an entry corresponding to the prevLogIndex.
      (prevLogEntry && request.prevLogTerm === prevLogEntry.term);
    if (!logOk) return { success: false, term: request.term };

    state = termCatchup(request, state);

    const newLog = [...state.log];
    newLog.splice(prevLogI);
    newLog.push(...(request.entries as ILogEntry<A>[]));

    state = { ...state, log: newLog, commitIndex: request.leaderCommit };

    await this.memberState.put(state);
    const response: IAppendResponse = { success: true, term: state.currentTerm, matchIndex: last(newLog) ? last(newLog)!.index : -1 };
    this.log("accepted append", { request, response, state });
    return response;
  };

  readonly onVote: Handler<typeof Vote> = async (request) => {
    if (!this.memberState.value) return new Error("state missing");
    let state = this.memberState.value;
    this.log("vote", { request, state });

    state = termCatchup(request, state);

    const lastLogEntry = state.log.length > 0 ? state.log[state.log.length - 1] : undefined;
    const lastLogTerm = lastLogEntry ? lastLogEntry.term : -1;
    const lastLogIndex = lastLogEntry ? lastLogEntry.index : -1;
    const logOk =
      request.lastLogTerm > lastLogTerm ||
      (request.lastLogTerm === lastLogTerm && request.lastLogIndex >= lastLogIndex);
    const voteGranted = logOk && (!state.votedFor || state.votedFor === request.sourceId);

    if (voteGranted) {
      state = { ...state, votedFor: request.sourceId };
      this.log("vote granted", { state });
    }

    await this.memberState.put(state);
    return { voteGranted, term: state.currentTerm };
  };

  readonly server = new Server<Env>().add(StartMember, this.onStart).add(Vote, this.onVote).add(Append, this.onAppend);

  private async sendAppend(state: IMemberState<S, A>, memberId: string) {
    const syncState = state.syncState[memberId]!;

    const prevLogIndex = syncState.nextIndex - 1;
    const prevLogTerm = prevLogIndex >= 0 ? state.log.find(e => e.index === prevLogIndex)!.term : -1;

    const response = await call(getFromString(this.memberActor, memberId), Append, {
      term: state.currentTerm,
      sourceId: this.id,
      prevLogIndex,
      prevLogTerm,
      leaderCommit: state.commitIndex,
      entries: state.log.filter(e => e.index > prevLogIndex),
    });

    if (response instanceof Error) return response;

    if (response.success) {
      syncState.matchIndex = response.matchIndex;
      syncState.nextIndex = response.matchIndex + 1;
    }

    // todo: handle false response

    return response.success;
  }

  async fetch(request: Request): Promise<Response> {
    return this.server.fetch(request, this.env);
  }

  private log(...data: unknown[]) {
    log(this.constructor.name, this.id, ...data);
  }
}

function termCatchup<S, A extends object>(request: { term: number; sourceId: string }, state: IMemberState<S,A>): IMemberState<S,A> {
  if (request.term > state.currentTerm) {
    return { ...state, role: "follower", currentTerm: request.term, votedFor: request.sourceId, syncState: {} };
  }

  return state;
}

function last<T>(arr: T[]): T | undefined {
  return arr.length > 0 ? arr[arr.length - 1] : undefined;
}

function toSeed(id: string): number {
  let seed = Date.now();
  while (id.length > 0) {
    seed += Number.parseInt(id.substring(0, 8), 16);
    id = id.substring(8);
  }
  return seed;
}

// async function waitForMajority<T>(majority: number, promises: Promise<T>, pred: (t: T) => boolean): Promise<T[]> {
// }
