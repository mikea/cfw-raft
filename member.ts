import { Env } from "./env";
import { Server } from "@mikea/cfw-utils/server";

export class MemberActor {
    constructor(public readonly state: DurableObjectState, private readonly env: Env) {}

    readonly server = new Server<Env>();

    async fetch(request: Request): Promise<Response> {
        return this.server.fetch(request, this.env);
    }
  }