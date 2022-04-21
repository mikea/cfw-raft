import { ActorRef, assign, createMachine, spawn } from "xstate";
import { log, send } from "xstate/lib/actions";
import { MemberRequest } from "../messages";

type SiblingContext = {
  stub: DurableObjectStub;
  lastRequest?: ActorRef<any>;
};


const fetchMachine = createMachine<{ fetcher: Fetcher; msg: MemberRequest; replyTo: string }>(
  {
    id: "fetch",
    initial: "start",
    states: {
      start: {
        invoke: {
          id: "fetch",
          src: "fetch",
          onDone: {
            target: "done",
            actions: send((ctx, evt) => evt.data, { to: (ctx) => ctx.replyTo }),
          },
        },
      },
      done: {
        type: "final",
      },
    },
  },
  {
    services: {
      fetch: async (ctx) => {
        const response = await ctx.fetcher.fetch("http://localhost/", {
          body: JSON.stringify(ctx.msg),
          method: "POST",
        });
        if (!response.ok) {
          throw new Error(`HTTP error: ${response.status} ${response.statusText}`);
        }
        return response.json();
      },
    },
  },
);

export type SiblingEvent = { type: "call"; msg: MemberRequest };

export const siblingMachine = createMachine<SiblingContext, SiblingEvent>({
  id: "sibling",
  initial: "start",
  states: {
    start: {
      on: {
        call: {
          actions: [
            log((ctx, evt) => `calling ${ctx.stub.id} ${JSON.stringify(evt.msg)}`),
            assign({
              lastRequest: (ctx, event, meta) => spawn(fetchMachine.withContext({ fetcher: ctx.stub, msg: event.msg, replyTo: meta._event.origin! })),
            }),
          ],
        },
      },
    },
  },
});
