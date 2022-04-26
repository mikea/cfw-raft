import { ActorRef, assign, createMachine, EventObject, LogAction, LogExpr } from "xstate";
import { log, pure, send, sendTo } from "xstate/lib/actions";
import { Env } from "../env";
import {
  IAppendRequest,
  IAppendResponse,
  IVoteRequest,
  IVoteResponse,
  MemberRequest,
  MemberResponse,
} from "../messages";
import { IClusterStaticConfig, ILogEntry, IMemberConfig, IMemberState, ISyncState } from "../model";
import { newRandom32 } from "@mikea/cfw-utils/random";

export interface MemberContext<S, A> {
  // environment
  env: Env;
  id: string;
  storage: DurableObjectStorage;
  siblings: Array<{ id: string; ref: ActorRef<MemberRequest<A>> }>;

  // configuration
  staticConfig: IClusterStaticConfig<S, A>;
  config: IMemberConfig;

  // persistent state
  // todo: move log out
  state: IMemberState<S, A>;

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

export function createMemberMachine<S, A>(initialContext: MemberContext<S, A>) {
  return createMachine<MemberContext<S, A>, MemberEvent<A>>(
    {
      id: "member",
      initial: "follower",
      states: {
        follower: {
          initial: "waitForMessage",

          states: {
            waitForMessage: {
              after: {
                ELECTION_DELAY: { target: "#member.candidate" },
              },
            },
            gotMessage: {
              always: { target: "waitForMessage" },
            },
          },
        },
        candidate: {
          initial: "waitRandom",
          states: {
            waitRandom: {
              entry: [mlog("election timeout")],
              after: {
                RANDOM_DELAY: { target: "startVoting" },
              },
            },
            startVoting: {
              entry: [mlog("start voting"), "startVoting"],
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
                voteResponse: { actions: "countVote", target: "checkVotes" },
              },
              after: {
                ELECTION_DELAY: { target: "#member.candidate" },
              },
            },
            checkVotes: {
              entry: [mlog((ctx) => `have ${ctx.votesCollected} votes`)],
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
              entry: ["initLeader", mlog("I am the leader")],
              always: { target: "sendUpdates" },
            },
            sendUpdates: {
              entry: [mlog("sending updates"), "sendUpdates"],
              always: { target: "waitForUpdate" },
            },
            waitForUpdate: {
              after: {
                UPDATE_PERIOD: {
                  actions: mlog("update period"),
                  target: "sendUpdates",
                },
              },
              on: {
                appendResponse: {
                  actions: [
                    "registerAppendResponse",
                    mlog(
                      (ctx, evt) =>
                        `append response ${JSON.stringify(evt)} -> ${JSON.stringify(ctx.syncState)}`,
                    ),
                  ],
                },
              },
            },
          },
        },
      },
      on: {
        voteRequest: [
          {
            target: "follower.gotMessage",
            cond: "voteGranted",
            actions: ["termCatchup", "replyVoteGranted", mlog("vote granted")],
          },
          {
            actions: ["replyVoteNotGranted", mlog("vote not granted")],
          },
        ],
        appendRequest: [
          {
            target: "follower.gotMessage",
            cond: "appendOk",
            actions: [
              mlog((_ctx, evt) => `ok append request ${JSON.stringify(evt)}`),
              "termCatchup",
              "applyAppend",
              "replyAppendOk",
            ],
          },
          {
            actions: [mlog((_ctx, evt) => `append request ${JSON.stringify(evt)}`), "replyAppendNotOk"],
          },
        ],
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
        replyAppendNotOk: send(
          (ctx) =>
            ({
              type: "appendResponse",
              src: ctx.id,
              srcTerm: ctx.state.currentTerm,
              success: false,
            } as IAppendResponse),
          { to: (_ctx, _event, meta) => meta._event.origin! },
        ),
        applyAppend: assign({
          state: (ctx, evt) => ({ ...ctx.state, log: applyLog(ctx.state.log, evt as IAppendRequest<any>) }),
          commitIndex: (ctx, evt) => (evt as IAppendRequest<any>).leaderCommit,
        }),
        replyAppendOk: send(
          (ctx) =>
            ({
              type: "appendResponse",
              src: ctx.id,
              srcTerm: ctx.state.currentTerm,
              success: true,
              matchIndex: last(ctx.state.log) ? last(ctx.state.log)!.index : -1,
            } as IAppendResponse),
          { to: (_ctx, _event, meta) => meta._event.origin! },
        ),
        registerAppendResponse: assign({
          syncState: (ctx, evt) =>
            evt.type === "appendResponse" && evt.success
              ? {
                  ...ctx.syncState,
                  [evt.src]: {
                    matchIndex: evt.matchIndex,
                    nextIndex: evt.matchIndex + 1,
                  },
                }
              : ctx.syncState,
        }),
      },

      guards: {
        voteGranted: (ctx, event) => {
          if (event.type !== "voteRequest") return false;

          const state = ctx.state;
          const lastLogEntry = last(state.log);
          const lastLogTerm = lastLogEntry ? lastLogEntry.term : -1;
          const lastLogIndex = lastLogEntry ? lastLogEntry.index : -1;
          const logOk =
            event.lastLogTerm > lastLogTerm ||
            (event.lastLogTerm === lastLogTerm && event.lastLogIndex >= lastLogIndex);
          const voteGranted = logOk && (!ctx.votedFor || ctx.votedFor === event.src);
          return voteGranted;
        },

        haveMajorityVotes: (ctx) => {
          return ctx.votesCollected > ctx.siblings.length / 2;
        },

        appendOk: (ctx, event) => {
          if (event.type !== "appendRequest") return false;

          const state = ctx.state;

          // drop old request
          if (event.srcTerm < state.currentTerm) return false;

          const prevLogI = state.log.findIndex((e) => e.index == event.prevLogIndex);
          const prevLogEntry = prevLogI >= 0 ? state.log[prevLogI] : undefined;
          const logOk =
            event.prevLogIndex === -1 ||
            // we need to have an entry corresponding to the prevLogIndex.
            (prevLogEntry && event.prevLogTerm === prevLogEntry.term);
          return logOk ?? false;
        },
      },

      services: {
        putConfig: (context) => context.storage.put("config", context.config),
        putState: (context) => context.storage.put("state", context.state),
      },
    },
  ).withContext(initialContext);
}

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

function applyLog<A>(log: ILogEntry<A>[], evt: IAppendRequest<A>): ILogEntry<A>[] {
  const prevLogI = log.findIndex((e) => e.index == evt.prevLogIndex);
  const newLog = [...log];
  newLog.splice(prevLogI);
  newLog.push(...evt.entries);
  return newLog;
}

function mlog<TContext extends { id: string }, TEvent extends EventObject>(expr: string | LogExpr<TContext, TEvent>): LogAction<TContext, TEvent> {
  return log((ctx, evt, meta) => `${Date.now()} [${ctx.id}] ${typeof expr === "string" ? expr : expr(ctx, evt, meta)}`);
}
