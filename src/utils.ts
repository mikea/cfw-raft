import { ActorRef, Cast, EventFrom, EventObject, send, SendAction, SendActionOptions, SendExpr } from "xstate";

declare type InferEvent<E extends EventObject> = {
    [T in E["type"]]: {
        type: T;
    } & Extract<E, {
        type: T;
    }>;
}[E["type"]];

export function sendTo<
  TContext,
  TEvent extends EventObject,
  TargetEvent extends EventObject
>(
  actor: (ctx: TContext) => ActorRef<TargetEvent>,
  event:
    | EventFrom<ActorRef<TargetEvent>>
    | SendExpr<
        TContext,
        TEvent,
        TargetEvent
      >,
  options?: SendActionOptions<TContext, TEvent>
): SendAction<TContext, TEvent, any> {
  return send<TContext, TEvent, any>(event, {
    ...options,
    to: actor
  });
}