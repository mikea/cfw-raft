import { Env } from "./env";
import { Handler, Server } from "@mikea/cfw-utils/server";
import { endpoint } from "@mikea/cfw-utils/endpoint";
import { cell } from "@mikea/cfw-utils/storage";

type Role = "follower" | "contender" | "leader";

interface IMemberConfig {}
interface IMemberState {
  role: Role;
}

export const StartMember = endpoint<IMemberConfig, IMemberState>({
  path: "/start_member",
});

export class MemberActor {
  constructor(public readonly state: DurableObjectState, private readonly env: Env) {}

  readonly memberState = cell<IMemberState>(this, "state");

  readonly start: Handler<typeof StartMember> = async () => {
    return this.memberState.put({ role: "follower" });
  };

  readonly server = new Server<Env>().add(StartMember, this.start);

  async fetch(request: Request): Promise<Response> {
    return this.server.fetch(request, this.env);
  }
}
