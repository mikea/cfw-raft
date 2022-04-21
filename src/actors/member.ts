import { ActorRef, assign, createMachine } from "xstate";
import { log, pure, send, sendTo } from "xstate/lib/actions";
import { Env } from "../env";
import { IAppendRequest, IVoteRequest, IVoteResponse, MemberRequest, MemberResponse } from "../messages";
import { IClusterStaticConfig, IMemberConfig, IMemberState, ISyncState } from "../model";
import { newRandom32 } from "@mikea/cfw-utils/random";

export interface MemberContext<S, A> {
  env: Env;
  id: string;
  storage: DurableObjectStorage;
  staticConfig: IClusterStaticConfig<S, A>;

  state: IMemberState<S, A>;
  config: IMemberConfig;
  siblings: Array<{ id: string; ref: ActorRef<MemberEvent<A>> }>;

  // volatile state
  votedFor?: string;
  votesCollected: number;
  commitIndex: number;
  lastApplied: number;
  // only on leader
  syncState: Record<string, ISyncState>;
}

const random = newRandom32(Date.now());

export type MemberEvent<A> = (MemberRequest<A> & { replyTo: string }) | MemberResponse;

export const memberMachine = createMachine<MemberContext<any, object>, MemberEvent<any>>(
  {
    id: "member",
    initial: "follower",
    states: {
      follower: {},
      candidate: {
        initial: "waitRandom",
        states: {
          waitRandom: {
            after: {
              RANDOM_DELAY: { target: "startVoting" },
            },
          },
          startVoting: {
            entry: [log((ctx) => `[${ctx.id}] start voting`), "startVoting"],
            always: { target: "putState" },
          },
          putState: {
            invoke: { id: "putState", src: "putState", onDone: "putStateDone" },
          },
          putStateDone: {
            entry: ["sendVoteRequests"],
            always: { target: "waitForVote" },
          },
          waitForVote: {
            on: {
              voteResponse: {
                actions: "countVote",
                target: "checkVotes",
              },
            },
          },
          checkVotes: {
            entry: [log((ctx) => `[${ctx.id}] have ${ctx.votesCollected} votes`)],
            always: [
              { target: "#member.leader", cond: "haveMajorityVotes" },
              { target: "#member.candidate.waitForVote" },
            ],
          },
        },
      },
      leader: {
        initial: "init",
        states: {
          init: {
            entry: ["initLeader", log((ctx) => `[${ctx.id}] I am leader`)],
            always: { target: "sendUpdates" },
          },
          sendUpdates: {
            entry: [log((ctx) => `@@@@@@@@@@@ [${ctx.id}] sending updates`), "sendUpdates"],
            after: {
              UPDATE_PERIOD: {
                actions: log((ctx) => `&&&&&&&& [${ctx.id}] update period`),
              },
            },
          },
        },
      },
    },
    on: {
      voteRequest: [
        {
          target: "follower",
          cond: "voteGranted",
          actions: ["termCatchup", "replyVoteGranted", log((ctx, evt) => `[${ctx.id}] vote granted`)],
        },
        {
          actions: ["replyVoteNotGranted", log((ctx, evt) => `[${ctx.id}] vote not granted`)],
        },
      ],
      appendRequest: [
        {
          actions: [log((ctx, evt) => `<<<< [${ctx.id}] append request ${JSON.stringify(evt)}`)],
        },
      ],
    },
    after: {
      ELECTION_DELAY: {
        actions: log((ctx) => `[${ctx.id}] election timeout`),
        target: "candidate",
      },
    },
  },
  {
    delays: {
      ELECTION_DELAY: (ctx) => ctx.config?.electionDelayMs,
      RANDOM_DELAY: (ctx) => random.randU32() % ctx.config?.electionDelayMs,
      UPDATE_PERIOD: (ctx) => ctx.config?.updatePeriodMs,
    },
    actions: {
      startVoting: assign({
        state: (ctx) => ({
          ...ctx.state!,
          currentTerm: (ctx.state?.currentTerm ?? 0) + 1,
        }),
        votedFor: (ctx) => ctx.id,
        votesCollected: (_ctx) => 0,
      }),
      sendVoteRequests: pure((ctx) =>
        ctx.siblings.map((sibling) =>
          sendTo(
            () => sibling.ref as any,
            (ctx) => buildVoteRequest(ctx),
          ),
        ),
      ),
      termCatchup: assign({
        state: (ctx, event) => ({
          ...ctx.state!,
          currentTerm: event.srcTerm,
          votedFor: event.src,
          syncState: {},
        }),
      }),
      replyVoteGranted: send(
        (ctx) =>
          ({
            type: "voteResponse",
            src: ctx.id,
            srcTerm: ctx.state.currentTerm,
            voteGranted: true,
          } as IVoteResponse),
        { to: (_ctx, _event, meta) => meta._event.origin! },
      ),
      replyVoteNotGranted: send(
        (ctx) =>
          ({
            type: "voteResponse",
            src: ctx.id,
            srcTerm: ctx.state.currentTerm,
            voteGranted: false,
          } as IVoteResponse),
        { to: (_ctx, _event, meta) => meta._event.origin! },
      ),
      countVote: assign({
        votesCollected: (ctx, evt) =>
          ctx.votesCollected +
          (evt.type === "voteResponse" && evt.voteGranted && evt.srcTerm == ctx.state.currentTerm ? 1 : 0),
      }),
      initLeader: assign({
        syncState: (ctx) => {
          const syncState: Record<string, ISyncState> = {};
          const lastLogEntry = last(ctx.state.log);
          const lastLogIndex = lastLogEntry ? lastLogEntry.index : -1;

          for (const sibling of ctx.siblings) {
            syncState[sibling.id] = {
              nextIndex: lastLogIndex + 1,
              matchIndex: 0,
            };
          }
          return syncState;
        },
      }),
      sendUpdates: pure((ctx) =>
        ctx.siblings.map((sibling) =>
          sendTo(
            () => sibling.ref as any,
            (ctx) => buildAppendRequest(ctx, sibling.id),
          ),
        ),
      ),
    },

    guards: {
      voteGranted: (ctx, event) => {
        if (event.type !== "voteRequest") return false;

        const state = ctx.state;
        const lastLogEntry = last(state.log);
        const lastLogTerm = lastLogEntry ? lastLogEntry.term : -1;
        const lastLogIndex = lastLogEntry ? lastLogEntry.index : -1;
        const logOk =
          event.lastLogTerm > lastLogTerm || (event.lastLogTerm === lastLogTerm && event.lastLogIndex >= lastLogIndex);
        const voteGranted = logOk && (!ctx.votedFor || ctx.votedFor === event.src);
        return voteGranted;
      },

      haveMajorityVotes: (ctx) => {
        return ctx.votesCollected > ctx.siblings.length / 2;
      },
    },

    services: {
      putConfig: (context) => context.storage.put("config", context.config),
      putState: (context) => context.storage.put("state", context.state),
    },
  },
);

function buildVoteRequest<S, A>(ctx: MemberContext<S, A>): IVoteRequest {
  const lastLogEntry = last(ctx.state.log);
  // todo: replace -1 with 0?
  const lastLogTerm = lastLogEntry ? lastLogEntry.term : -1;
  const lastLogIndex = lastLogEntry ? lastLogEntry.index : -1;

  return {
    type: "voteRequest",
    src: ctx.id,
    srcTerm: ctx.state.currentTerm,
    lastLogIndex: lastLogIndex,
    lastLogTerm: lastLogTerm,
  };
}

function buildAppendRequest<S, A>(ctx: MemberContext<S, A>, memberId: string): IAppendRequest<A> {
  const state = ctx.state;
  const syncState = ctx.syncState[memberId]!;

  const prevLogIndex = syncState.nextIndex - 1;
  const prevLogTerm = prevLogIndex >= 0 ? state.log.find((e) => e.index === prevLogIndex)!.term : -1;

  // const response = await call(getFromString(this.memberActor, memberId), Append, {
  //   term: state.currentTerm,
  //   sourceId: this.id,
  // });
  return {
    type: "appendRequest",
    src: ctx.id,
    srcTerm: state.currentTerm,
    prevLogIndex,
    prevLogTerm,
    leaderCommit: ctx.commitIndex,
    entries: state.log.filter((e) => e.index > prevLogIndex),
  };
}

function last<T>(arr: T[]): T | undefined {
  return arr.length > 0 ? arr[arr.length - 1] : undefined;
}