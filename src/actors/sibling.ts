import { ActorRef, assign, createMachine, EventObject, spawn } from "xstate";
import { send } from "xstate/lib/actions.js";
import { MemberRequest } from "../messages.js";

type SiblingContext = {
  stub: DurableObjectStub;
  lastRequest?: ActorRef<EventObject>;
};

const fetchMachine = createMachine<{ fetcher: Fetcher; msg: MemberRequest<unknown>; replyTo: string }>(
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
            actions: send((_ctx, evt) => evt.data, { to: (ctx) => ctx.replyTo }),
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

export const siblingMachine = createMachine<SiblingContext, MemberRequest<unknown>>({
  id: "sibling",
  initial: "start",
  states: {
    start: {
      on: {
        "*": {
          actions: [
            assign({
              lastRequest: (ctx, msg, meta) =>
                spawn(fetchMachine.withContext({ fetcher: ctx.stub, msg, replyTo: meta._event.origin! })),
            }),
          ],
        },
      },
    },
  },
});
