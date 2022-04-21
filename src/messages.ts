import { endpoint } from "@mikea/cfw-utils/endpoint";
import { IMemberConfig } from "./model";

interface IMessageBase {
  // id of the sender
  src: string;

  // sender's current term
  srcTerm: number;
}


export interface IVoteRequest extends IMessageBase {
  type: "voteRequest";
  lastLogIndex: number;
  lastLogTerm: number;
}

export interface IVoteResponse extends IMessageBase {
  type: "voteResponse";
  voteGranted: boolean;
}


// interface IAppendRequest<A extends object> {
//   term: number;
//   sourceId: string;

//   entries: ILogEntry<A>[];
//   prevLogIndex: number;
//   prevLogTerm: number;
//   leaderCommit: number;
// }

// export type IAppendResponse = {
//   success: false;
// } | {
//   term: number;
//   matchIndex: number;
//   success: true;
// }

export type MemberRequest = IVoteRequest;
export type MemberResponse = IVoteResponse;

export type SupervisorEvent =
  | { type: "startRequest"; config: IMemberConfig }
  | { type: "startResponse"; success: boolean}
  | MemberRequest;

export type IEventRequest = SupervisorEvent;
export type IEventResponse = true;

export const Event = endpoint<IEventRequest, IEventResponse>({
  path: "/event",
});
