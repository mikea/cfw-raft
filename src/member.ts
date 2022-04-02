import { Env } from "./env";
import { Handler, Server } from "@mikea/cfw-utils/server";
import { call } from "@mikea/cfw-utils/call";
import { endpoint } from "@mikea/cfw-utils/endpoint";
import { cell, getFromString } from "@mikea/cfw-utils/storage";
import { IRandom32, newRandom32 } from "@mikea/cfw-utils/random";
import { log } from "./log";
import { timeout } from "./promises";
import { liftError } from "./errors";

type Role = "follower" | "candidate" | "leader";

export interface IMemberConfig {
  others: string[];
  initDelayMs: number;
}
export interface IMemberState {
  id: string;
  role: Role;
  currentTerm: number;
  config: IMemberConfig;
  leader?: string;
  votedFor?: string;
}

export const StartMember = endpoint<IMemberConfig, IMemberState>({
  path: "/start_member",
});

export const PingMember = endpoint<{}, IMemberState>({
  path: "/ping_member",
});

interface IVoteRequest {
  term: number;
  sourceId: string;

  // todo
  // lastLogIndex: number
  // lastLogTerm: number
}

interface IVoteResponse {
  term: number;
  voteGranted: boolean;
}

export const Vote = endpoint<IVoteRequest, IVoteResponse>({
  path: "/vote",
});

interface IAppendRequest {
  term: number;
  sourceId: string;

  entries: [];
  // todo
  // prevLogIndex: number;
  // prevLogTerm: number;
  // leaderCommit: number;
}

interface IAppendResponse {
  term: number;
  success: boolean;
}

export const Append = endpoint<IAppendRequest, IAppendResponse>({
  path: "/append",
});
export class MemberActor {
  readonly id: string;
  readonly random: IRandom32;

  constructor(public readonly state: DurableObjectState, private readonly env: Env) {
    this.id = this.state.id.toString();
    this.random = newRandom32(toSeed(this.id));
  }

  readonly memberState = cell<IMemberState>(this, "state");

  readonly start: Handler<typeof StartMember> = async (config) => {
    const initDelay = this.random.randU32() % config.initDelayMs + config.initDelayMs;
    log(this.id, "start", { config });
    const state: IMemberState = { role: "follower", id: this.id, currentTerm: 0, config };
    await this.memberState.put(state);

    await timeout(initDelay);

    await this.maybeStartElection();
    log(this.id, "member started");
    return state;
  };

  private async maybeStartElection() {
    const state = await this.memberState.get();
    if (!state) return new Error("missing state");
    if (state.leader || state.role !== "follower") return;

    log(this.id, "starting election");
    state.currentTerm = state.currentTerm + 1;
    state.votedFor = this.id;
    state.role = "candidate";
    await this.memberState.put(state);

    const voteRequest: IVoteRequest = { term: state.currentTerm, sourceId: this.id };
    
    // todo: election timer
    // todo: wait for majority, not all
    const responses = liftError(await Promise.all(state.config.others.map((memberId) => call(getFromString(this.env.memberActor, memberId), Vote, voteRequest))));
    if (responses instanceof Error) return responses;
    const votes = responses.filter((r) => r.voteGranted && r.term === state.currentTerm).length;
    log(this.id, "got all vote responses", { votes });

    const majority = (state.config.others.length + 1) / 2;
    if (votes >= majority) {
      // todo: re-read state and check it.
      state.role = "leader";
      log(this.id, "got majority", { votes, state });
      await this.memberState.put(state);
      await this.sendHeartbeats(state);
    }
  }

  private async sendHeartbeats(state: IMemberState) {
    const responses = liftError(await Promise.all(state.config.others.map((memberId) => call(getFromString(this.env.memberActor, memberId), Append, {
      term: state.currentTerm,
      sourceId: this.id,
      entries: [],
    }))));
    return responses;
  }

  readonly append: Handler<typeof Append> = async (request) => {
    const state = await this.memberState.get();
    log(this.id, "append", { request, state });
    if (!state) return new Error("missing state");

    // drop old request
    if (request.term < state.currentTerm) return { success: false, term: request.term };

    termCatchup(request, state);

    // todo: check commits

    log(this.id, "accepted append", { request, state });
    await this.memberState.put(state);
    return { success: true, term: state.currentTerm };
  };

  readonly vote: Handler<typeof Vote> = async (request) => {
    const state = await this.memberState.get();
    if (!state) return new Error("state missing");
    log(this.id, "vote", { request, state });

    termCatchup(request, state);

    // todo: check log
    const voteGranted = !state.votedFor || state.votedFor === request.sourceId;
    
    if (voteGranted) {
      state.votedFor = request.sourceId;
      log(this.id, "vote granted", { state });
      await this.memberState.put(state);
    }

    return { voteGranted, term: state.currentTerm };
  };

  readonly ping: Handler<typeof PingMember> = async () => {
    const state = await this.memberState.get();
    if (!state) return new Error("state missing");
    log(this.id, "ping", { state });
    return state;
  };

  readonly server = new Server<Env>().add(StartMember, this.start).add(Vote, this.vote).add(Append, this.append);

  async fetch(request: Request): Promise<Response> {
    return this.server.fetch(request, this.env);
  }
}
function termCatchup(request: { term: number, sourceId: string }, state: IMemberState) {
  if (request.term > state.currentTerm) {
    state.role = "follower";
    state.currentTerm = request.term;
    state.votedFor = undefined;
    state.leader = request.sourceId;
  }
}

function toSeed(id: string): number {
  let seed = Date.now();
  while (id.length > 0) {
    seed += Number.parseInt(id.substring(0, 8), 16);
    id = id.substring(8);
  }
  return seed;
}

