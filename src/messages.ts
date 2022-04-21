import { endpoint } from "@mikea/cfw-utils/endpoint";
import { ILogEntry, IMemberConfig } from "./model";

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

export interface IAppendRequest<A> extends IMessageBase {
  type: "appendRequest";

  entries: ILogEntry<A>[];
  prevLogIndex: number;
  prevLogTerm: number;
  leaderCommit: number;
}

export type IAppendResponse = {
  type: "appendResponse";
} & IMessageBase &
  (
    | {
        success: false;
      }
    | {
        term: number;
        matchIndex: number;
        success: true;
      }
  );

export type MemberRequest<A> = IVoteRequest | IAppendRequest<A>;
export type MemberResponse = IVoteResponse | IAppendResponse;

export type StartRequest = { type: "startRequest"; config: IMemberConfig };
export type StartResponse = { type: "startResponse"; success: boolean };

export const Event = endpoint<StartRequest, StartResponse>({
  path: "/event",
});
