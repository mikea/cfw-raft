import { getFromString } from "@mikea/cfw-utils";
import { ActorRef, assign, createMachine, EventObject, spawn } from "xstate";
import { log, send } from "xstate/lib/actions.js";
import { Env } from "../env.js";
import { MemberRequest, StartRequest } from "../messages.js";
import { IClusterStaticConfig, IMemberConfig, IMemberState } from "../model.js";
import { createMemberMachine, MemberEvent } from "./member.js";
import { siblingMachine } from "./sibling.js";

export type SupervisorContext<S, A> = {
  env: Env;
  doState: DurableObjectState;

  startOrigin?: string;

  staticConfig: IClusterStaticConfig<S, A>;
  member?: ActorRef<MemberEvent<A>>;
  siblings?: Array<{ id: string; ref: ActorRef<MemberRequest<A>> }>;
  config?: IMemberConfig;
  state?: IMemberState<S, A>;
  lastRequest?: ActorRef<any>;
};

const askMachine = createMachine<{
  from: string;
  to: ActorRef<any>;
  msg: EventObject;
}>({
  initial: "send",
  states: {
    send: {
      entry: [send((ctx) => ctx.msg, { to: (ctx) => ctx.to })],
      on: {
        "*": {
          actions: [send((ctx, event) => event, { to: (ctx) => ctx.from })],
          target: "done",
        },
      },
    },
    done: {
      type: "final",
    },
  },
});

export function createMemberSupervisor<S, A>(initialContext: SupervisorContext<S, A>) {
  return createMachine<SupervisorContext<S, A>, StartRequest | MemberRequest<A>>(
    {
      id: "memberSupervisor",
      initial: "not_initialized",
      states: {
        not_initialized: {
          on: {
            startRequest: {
              target: "putConfig",
              actions: [
                log("starting new member"),
                assign({
                  config: (_ctx, event) => event.config,
                  startOrigin: (_ctx, _event, meta) => meta._event.origin,
                  state: (ctx) => ({
                    currentTerm: 0,
                    log: [],
                    commitIndex: -1,
                    lastApplied: -1,
                    syncState: {},
                    state: ctx.staticConfig.stateMachine.initial,
                  }),
                }),
              ],
            },
          },
        },
        putConfig: {
          invoke: { id: "putConfig", src: "putConfig", onDone: "putState" },
        },
        putState: {
          invoke: { id: "putState", src: "putState", onDone: "startSiblings" },
        },
        startSiblings: {
          entry: assign({
            siblings: (ctx) =>
              ctx.siblings?.map((sibling) => ({
                ref: spawn(
                  siblingMachine.withContext({
                    stub: getFromString(ctx.env[ctx.staticConfig.memberActor], sibling.id),
                  }),
                ),
                id: sibling.id,
              })),
          }),
          always: {
            target: "startMember",
          },
        },
        startMember: {
          entry: assign({
            member: (ctx) => {
              return spawn(
                createMemberMachine({
                  id: ctx.doState.id.toString(),
                  storage: ctx.doState.storage,
                  staticConfig: ctx.staticConfig,
                  config: ctx.config!,
                  siblings: ctx.siblings!,
                  state: ctx.state!,
                  votesCollected: 0,
                  commitIndex: -1,
                  lastApplied: -1,
                  syncState: {},
                }),
              );
            },
          }),
          always: {
            target: "running",
          },
        },
        running: {
          entry: send({ type: "startResponse", success: true }, { to: (ctx) => ctx.startOrigin! }),

          on: {
            "*": { actions: "forwardToMember" },
          },
        },
      },
    },
    {
      actions: {
        forwardToMember: assign({
          lastRequest: (ctx, msg, meta) =>
            spawn(askMachine.withContext({ from: meta._event.origin!, to: ctx.member!, msg })),
        }),
      },
      services: {
        putConfig: (context) => context.doState.storage.put("config", context.config),
        putState: (context) => context.doState.storage.put("state", context.state),
      },
    },
  ).withContext(initialContext);
}
