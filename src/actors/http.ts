import { EventObject, createMachine, ActorRef, send, StateMachine, assign, spawn } from "xstate";

export type HttpRequest = { type: "request"; body: EventObject; callback: (response: Response) => void };

const requestMachine = createMachine<{ request: HttpRequest; ref: ActorRef<any> }>({
  id: "request",
  initial: "start",
  states: {
    start: {
      entry: [send((ctx) => ctx.request.body, { to: (ctx) => ctx.ref })],
    },
    done: {
      type: "final",
    },
  },
  on: {
    "*": {
      actions: [
        (ctx, event) => {
          ctx.request.callback(new Response(JSON.stringify(event), { headers: { "content-type": "text/json" } }));
        },
      ],
      target: "done",
    },
  },
});

export const httpMachine = createMachine<
  { ref?: ActorRef<EventObject>; handler: StateMachine<any, any, any>; lastRequest?: ActorRef<EventObject> },
  HttpRequest
>({
  id: "http",
  initial: "start",
  states: {
    start: {
      entry: assign({
        ref: (ctx) => spawn(ctx.handler),
      }),
      on: {
        request: {
          actions: assign({
            lastRequest: (ctx, request) => spawn(requestMachine.withContext({ request, ref: ctx.ref! })),
          }),
        },
      },
    },
  },
});
