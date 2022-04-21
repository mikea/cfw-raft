import { Env } from "./env";
import { IClusterStaticConfig } from "./model";
import { EventObject, interpret } from "xstate";
import { memberSupervisor } from "./actors/memberSupervisor";
import { barrier } from "./promises";
import { httpMachine } from "./actors/http";



// export const Append = endpoint<IAppendRequest<object>, IAppendResponse>({
//   path: "/append",
// });


export const CreateMemberActor = <S, A extends object>(staticConfig: IClusterStaticConfig<S, A>) => {
  return class {
    public readonly fetch: (request: Request) => Promise<Response>;
    constructor(state: DurableObjectState, env: Env) {
      const member = memberSupervisor.withContext({
        doState: state,
        env,
        staticConfig
      });
      const interpreter = interpret(httpMachine.withContext({ handler: member }));
      interpreter.start();

      // interpreter.onChange((ctx) => {
      //   console.error("change", { ctx });
      // });
      // interpreter.onTransition((state, event) => {
      //   console.error(`[${state.machine?.id}]`, "transition", { state: state.value, event });
      // });
      interpreter.onEvent((event) => {
        console.error(`[${state.id}] received`, JSON.stringify(event));
      });
      interpreter.onSend((event) => {
        console.error("send", { event });
      });


      this.fetch = async (request) => {
        const response = barrier<Response>();
        const body = await request.json<EventObject>();
        interpreter.send({ type: "request", body, callback: (t) => response.resolve(t) });
        return response.promise;
      };
    }
  };
};


//     const majority = (config.others.length + 1) / 2;
//     if (votes >= majority) {
//       const syncState:Record<string, ISyncState> = {};
//       for (const memberId of config.others) {
//         syncState[memberId] = {
//           nextIndex: lastLogIndex + 1,
//           matchIndex: 0,
//         };
//       }
//       // todo: re-read state and check it.
//       state = { ...state, role: "leader", syncState };
//       this.log("got majority", { votes, state });
//       await this.memberState.put(state);
//       await this.sendHeartbeats(state, config);
//     }

//     // todo: retry
//   }

//   private async sendHeartbeats(state: IMemberState<S,A>, config: IMemberConfig) {
//     // todo: don't wait for all heartbeats to finish
//     const responses = liftError(
//       await Promise.all(
//         config.others.map((memberId) => {
//           return this.sendAppend(state, memberId);
//         }
//         ),
//       ),
//     );
//     return responses;
//   }

//   readonly onAppend: Handler<typeof Append> = async (request) => {
//     if (!this.memberState.value) return new Error("missing state");
//     let state = this.memberState.value;
//     this.log("append", { request, state });

//     // drop old request
//     if (request.term < state.currentTerm) return { success: false, term: request.term };

//     const prevLogI = state.log.findIndex(e => e.index == request.prevLogIndex);
//     const prevLogEntry = prevLogI >= 0 ? state.log[prevLogI] : undefined;
//     const logOk = (request.prevLogIndex === -1) ||
//       // we need to have an entry corresponding to the prevLogIndex.
//       (prevLogEntry && request.prevLogTerm === prevLogEntry.term);
//     if (!logOk) return { success: false, term: request.term };

//     state = termCatchup(request, state);

//     const newLog = [...state.log];
//     newLog.splice(prevLogI);
//     newLog.push(...(request.entries as ILogEntry<A>[]));

//     state = { ...state, log: newLog, commitIndex: request.leaderCommit };

//     await this.memberState.put(state);
//     const response: IAppendResponse = { success: true, term: state.currentTerm, matchIndex: last(newLog) ? last(newLog)!.index : -1 };
//     this.log("accepted append", { request, response, state });
//     return response;
//   };

//   readonly onVote: Handler<typeof Vote> = async (request) => {
//     if (!this.memberState.value) return new Error("state missing");
//     let state = this.memberState.value;
//     this.log("vote", { request, state });

//     if (voteGranted) {
//       state = { ...state, votedFor: request.sourceId };
//       this.log("vote granted", { state });
//     }

//     await this.memberState.put(state);
//     return { voteGranted, term: state.currentTerm };
//   };

//   readonly server = new Server<Env>().add(StartMember, this.onStart).add(Vote, this.onVote).add(Append, this.onAppend);

//   private async sendAppend(state: IMemberState<S, A>, memberId: string) {
//     const syncState = state.syncState[memberId]!;

//     const prevLogIndex = syncState.nextIndex - 1;
//     const prevLogTerm = prevLogIndex >= 0 ? state.log.find(e => e.index === prevLogIndex)!.term : -1;

//     const response = await call(getFromString(this.memberActor, memberId), Append, {
//       term: state.currentTerm,
//       sourceId: this.id,
//       prevLogIndex,
//       prevLogTerm,
//       leaderCommit: state.commitIndex,
//       entries: state.log.filter(e => e.index > prevLogIndex),
//     });

//     if (response instanceof Error) return response;

//     if (response.success) {
//       syncState.matchIndex = response.matchIndex;
//       syncState.nextIndex = response.matchIndex + 1;
//     }

//     // todo: handle false response

//     return response.success;
//   }

//   async fetch(request: Request): Promise<Response> {
//     return this.server.fetch(request, this.env);
//   }

//   private log(...data: unknown[]) {
//     log(this.constructor.name, this.id, ...data);
//   }
// }

// function termCatchup<S, A extends object>(request: { term: number; sourceId: string }, state: IMemberState<S,A>): IMemberState<S,A> {
//   if (request.term > state.currentTerm) {
//     return { ...state, role: "follower", currentTerm: request.term, votedFor: request.sourceId, syncState: {} };
//   }

//   return state;
// }


// function toSeed(id: string): number {
//   let seed = Date.now();
//   while (id.length > 0) {
//     seed += Number.parseInt(id.substring(0, 8), 16);
//     id = id.substring(8);
//   }
//   return seed;
// }

// // async function waitForMajority<T>(majority: number, promises: Promise<T>, pred: (t: T) => boolean): Promise<T[]> {
// // }
