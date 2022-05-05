import { ActorRef, assign, createMachine, EventObject, LogAction, LogExpr } from "xstate";
import { log, pure, send, sendTo } from "xstate/lib/actions.js";
import {
  IAppendRequest,
  IAppendResponse,
  IClientAppendResponse,
  IVoteRequest,
  IVoteResponse,
  MemberRequest,
  MemberResponse,
} from "../messages";
import { IClusterStaticConfig, ILogEntry, IMemberConfig, IMemberState, ISyncState } from "../model";

export interface MemberContext<S, A> {
  // environment
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
  lastLeaderId?: string;
  votesCollected: number;
  commitIndex: number;
  lastApplied: number;

  // only on leader
  syncState: Record<string, ISyncState>;
}

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

          on: {
            clientAppend: {
              actions: [
                mlog((ctx, evt) => `received client append ${JSON.stringify(evt)}`),
                "replyClientAppendNotALeader",
              ],
            },
          },
        },
        candidate: {
          initial: "startVoting",
          states: {
            startVoting: {
              entry: [mlog("election timeout, start voting"), "startVoting"],
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

          on: {
            clientAppend: {
              actions: [
                mlog((ctx, evt) => `received client append ${JSON.stringify(evt)}`),
                "replyClientAppendNotALeader",
              ],
            },
          },
        },
        leader: {
          initial: "start",
          states: {
            start: {
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
            },
          },

          on: {
            appendResponse: {
              actions: [
                mlog((_ctx, evt) => `got append response ${JSON.stringify(evt)}`),
                "processAppendResponse",
              ],
            },
            clientAppend: {
              actions: [
                mlog((_ctx, evt) => `processing client append ${JSON.stringify(evt)}`),
                "processClientAppend",
                "replyClientAppendOk",
              ],
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
        UPDATE_PERIOD: (ctx) => ctx.config?.updatePeriodMs,
      },
      actions: {
        startVoting: assign({
          state: (ctx) => ({
            ...ctx.state!,
            currentTerm: (ctx.state?.currentTerm ?? 0) + 1,
            votedFor: ctx.id,
          }),
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
          state: (ctx, event) => {
            // todo: more type safety
            if (event.type !== "voteRequest" && event.type !== "appendRequest") {
              throw new Error(`Wrong event type: ${event.type}`);
            }
            return {
              ...ctx.state!,
              currentTerm: event.srcTerm,
              syncState: {},
            };
          },
          lastLeaderId: (ctx, evt) => {
            // todo: more type safety
            if (evt.type !== "voteRequest" && evt.type !== "appendRequest") {
              throw new Error(`Wrong evt type: ${evt.type}`);
            }
            return evt.src;
          },
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
            console.error("!!!! init leader");
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
          lastLeaderId: (ctx) => ctx.id,
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
          state: (ctx, evt) => {
            // todo: more type safety
            if (evt.type !== "appendRequest") {
              throw new Error(`Wrong event type: ${evt.type}`);
            }
            return { ...ctx.state, log: applyLog(ctx.state.log, evt) };
          },
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
        // todo: failure case
        // todo: commit
        processAppendResponse: assign({
          syncState: (ctx, evt) => {
            if (evt.type !== "appendResponse") return ctx.syncState;
            if (evt.srcTerm !== ctx.state.currentTerm) return ctx.syncState;

            return evt.success
              ? {
                  ...ctx.syncState,
                  [evt.src]: {
                    matchIndex: evt.matchIndex,
                    nextIndex: evt.matchIndex + 1,
                  },
                }
              : {
                  ...ctx.syncState,
                  [evt.src]: {
                    nextIndex: (ctx.syncState[evt.src]?.nextIndex ?? 0) - 1,
                    matchIndex: ctx.syncState[evt.src]?.matchIndex,
                  },
                };
          },
        }),
        replyClientAppendNotALeader: send(
          (ctx) => {
            const response: IClientAppendResponse = {
              type: "clientAppendResponse",
              success: false,
              reason: "not_a_leader",
              leader: ctx.lastLeaderId,
            };
            return response;
          },
          { to: (_ctx, _event, meta) => meta._event.origin! },
        ),
        processClientAppend: assign({
          state: (ctx, evt) => {
            // todo: more type safety
            if (evt.type !== "clientAppend") {
              throw new Error(`Wrong event type: ${evt.type}`);
            }
            // todo
            if (evt.consistency !== "no_wait") {
              throw new Error(`Unsupported append consitency: ${evt.consistency}`);
            }

            const log = [...ctx.state.log];
            let nextIndex = (last(log)?.index ?? -1) + 1;
            evt.entries.forEach((a) => {
              log.push({
                action: a,
                term: ctx.state.currentTerm,
                index: nextIndex,
              });
              nextIndex += 1;
            });

            return { ...ctx.state, log };
          },
        }),
        replyClientAppendOk: send(
          () => {
            const response: IClientAppendResponse = {
              type: "clientAppendResponse",
              success: true,
            };
            return response;
          },
          { to: (_ctx, _event, meta) => meta._event.origin! },
        ),
      },

      guards: {
        voteGranted: (ctx, event) => {
          if (event.type !== "voteRequest") return false;
          const state = ctx.state;
          if (event.srcTerm < state.currentTerm) return false;

          const lastLogEntry = last(state.log);
          const lastLogTerm = lastLogEntry ? lastLogEntry.term : -1;
          const lastLogIndex = lastLogEntry ? lastLogEntry.index : -1;
          const logOk =
            event.lastLogTerm > lastLogTerm ||
            (event.lastLogTerm === lastLogTerm && event.lastLogIndex >= lastLogIndex);
          const voteGranted = logOk && (!ctx.state.votedFor || state.currentTerm < event.srcTerm);
          // todo: check current term
          return voteGranted;
        },

        haveMajorityVotes: (ctx) => {
          return ctx.votesCollected >= ctx.siblings.length / 2;
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

function mlog<TContext extends { id: string }, TEvent extends EventObject>(
  expr: string | LogExpr<TContext, TEvent>,
): LogAction<TContext, TEvent> {
  return log((ctx, evt, meta) => `${Date.now()} [${ctx.id}] ${typeof expr === "string" ? expr : expr(ctx, evt, meta)}`);
}
