import { getFromString } from "@mikea/cfw-utils/storage";
import { ActorRef, assign, createMachine, EventObject, spawn } from "xstate";
import { log, send } from "xstate/lib/actions";
import { Env } from "../env";
import { SupervisorEvent } from "../messages";
import { IClusterStaticConfig, IMemberConfig, IMemberState } from "../model";
import { sendTo } from "../utils";
import { MemberEvent, memberMachine } from "./member";
import { siblingMachine } from "./sibling";

export type SupervisorContext = {
  env: Env;
  doState: DurableObjectState;

  startOrigin?: string;

  staticConfig: IClusterStaticConfig<any, object>;
  member?: ActorRef<MemberEvent>;
  siblings?: ActorRef<any>[];
  config?: IMemberConfig;
  state?: IMemberState<any, object>;
  lastRequest?: ActorRef<any>;
};

const askMachine = createMachine<{
  from: string,
  to: ActorRef<any>,
  msg: EventObject
}>({
  initial: "send",
  states: {
    send: {
      entry: send((ctx) => ctx.msg, { to: (ctx) => ctx.to }),
      on: {
        "*": {
          actions: send((ctx, event) => event, { to: (ctx) => ctx.from }),
          target: "done",
        }
      },
    },
    done: {
      type: "final"
    }
  }
});

/*

                */

export const memberSupervisor = createMachine<SupervisorContext, SupervisorEvent>(
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
            ctx.config?.others.map((memberId) =>
              spawn(
                siblingMachine.withContext({
                  stub: getFromString(ctx.env[ctx.staticConfig.memberActor], memberId),
                }),
              ),
            ),
        }),
        always: {
          target: "startMember",
        },
      },
      startMember: {
        entry: assign({
          member: (ctx) => {
            return spawn(
              memberMachine.withContext({
                id: ctx.doState.id.toString(),
                storage: ctx.doState.storage,
                staticConfig: ctx.staticConfig,
                env: ctx.env,
                config: ctx.config!,
                siblings: ctx.siblings!,
                state: ctx.state!,
                votesCollected: 0,
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
      },
    },
    on: {
      "*": {
        actions: assign({
          lastRequest: (ctx, msg, meta) => spawn(askMachine.withContext({
            from: meta._event.origin!,
            to: ctx.member!,
            msg,
          })),
        })
      }
    }
  },
  {
    actions: {},
    services: {
      putConfig: (context) => context.doState.storage.put("config", context.config),
      putState: (context) => context.doState.storage.put("state", context.state),
    }
  },
);
