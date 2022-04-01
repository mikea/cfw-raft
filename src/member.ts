import { Env } from "./env";
import { Handler, Server } from "@mikea/cfw-utils/server";
import { endpoint } from "@mikea/cfw-utils/endpoint";
import { cell } from "@mikea/cfw-utils/storage";

type Role = "follower" | "contender" | "leader";

interface IMemberConfig {}

export interface IMemberState {
  id: string;
  role: Role;
}

export const StartMember = endpoint<IMemberConfig, IMemberState>({
  path: "/start_member",
});

export const PingMember = endpoint<{}, IMemberState>({
  path: "/ping_member",
});
export class MemberActor {
  constructor(public readonly state: DurableObjectState, private readonly env: Env) {}

  readonly memberState = cell<IMemberState>(this, "state");

  readonly start: Handler<typeof StartMember> = async () => {
    return this.memberState.put({ role: "follower", id: this.state.id.toString() });
  };

  readonly ping: Handler<typeof PingMember> = async () => {
    const state = await this.memberState.get();
    if (!state) return new Error("state missing");
    return state;
  };

  readonly server = new Server<Env>().add(StartMember, this.start).add(PingMember, this.ping);

  async fetch(request: Request): Promise<Response> {
    return this.server.fetch(request, this.env);
  }
}
