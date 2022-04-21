import { ActorRef, assign, createMachine } from "xstate";
import { log, pure, send, sendTo } from "xstate/lib/actions";
import { Env } from "../env";
import { IVoteRequest, IVoteResponse, MemberRequest, MemberResponse } from "../messages";
import { IClusterStaticConfig, IMemberConfig, IMemberState } from "../model";
import { SiblingEvent } from "./sibling";
import { newRandom32 } from "@mikea/cfw-utils/random";

export interface MemberContext<S, A extends object> {
  env: Env;
  id: string;
  storage: DurableObjectStorage;
  staticConfig: IClusterStaticConfig<S, A>;

  state: IMemberState<S, A>;
  config: IMemberConfig;
  siblings: ActorRef<SiblingEvent>[];

  // transient state
  votesCollected: number;
}

const random = newRandom32(Date.now());

export type MemberEvent = (MemberRequest & { replyTo: string }) | MemberResponse;
export const memberMachine = createMachine<MemberContext<any, object>, MemberEvent>(
  {
    id: "member",
    initial: "candidate",
    states: {
      follower: {
        after: {
          ELECTION_DELAY: {
            actions: log((ctx) => `[${ctx.id}] election timeout`),
            target: "candidate"
          },
        },
      },
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
            always: [
              { target: "#member.leader", cond: "haveMajorityVotes" },
              { target: "#member.candidate.waitForVote" },
            ]
          }
        },
      },
      leader: {
        entry: [ log((ctx) => `@@@@@@@@@@@ [${ctx.id}] I am the leader`) ]
      },
    },
    on: {
      voteRequest: [
        {
          target: "follower",
          cond: "voteGranted",
          actions: [
            "termCatchup",
            "replyVoteGranted",
            log(
              (ctx, event, meta) =>
                `*** [${ctx.id}] vote granted for ${event.src} meta ${JSON.stringify(meta._event.origin)}`,
            ),
          ],
        },
        {
          actions: [
            "replyVoteNotGranted",
            log((ctx, event, _meta) => `*** [${ctx.id}] vote not granted for ${event.src}`),
          ],
        },
      ],
    },
  },
  {
    delays: {
      ELECTION_DELAY: (context) => context.config?.electionDelayMs,
      RANDOM_DELAY: () => random.randU32() % 100,
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
            () => sibling as any,
            (ctx) => ({
              type: "call",
              msg: buildVoteRequest(ctx),
            }),
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
          ctx.votesCollected + ( evt.type === "voteResponse" && evt.voteGranted && evt.srcTerm == ctx.state.currentTerm ? 1 : 0),
      })
    },

    guards: {
      voteGranted: (ctx, event) => {
        if (event.type !== "voteRequest") return false;

        const state = ctx.state;
        const lastLogEntry = state.log.length > 0 ? state.log[state.log.length - 1] : undefined;
        const lastLogTerm = lastLogEntry ? lastLogEntry.term : -1;
        const lastLogIndex = lastLogEntry ? lastLogEntry.index : -1;
        const logOk =
          event.lastLogTerm > lastLogTerm || (event.lastLogTerm === lastLogTerm && event.lastLogIndex >= lastLogIndex);
        const voteGranted = logOk && (!state.votedFor || state.votedFor === event.src);
        console.error("voteGranted", { event, voteGranted, logOk, state });

        return voteGranted;
      },

      haveMajorityVotes: (ctx) => {
        return ctx.votesCollected > ctx.siblings.length / 2;
      }
    },

    services: {
      putConfig: (context) => context.storage.put("config", context.config),
      putState: (context) => context.storage.put("state", context.state),
    },
  },
);

function buildVoteRequest<S, A extends object>(ctx: MemberContext<S, A>): IVoteRequest {
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

function last<T>(arr: T[]): T | undefined {
  return arr.length > 0 ? arr[arr.length - 1] : undefined;
}
