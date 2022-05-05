import { assert } from "chai";
import { createMemberMachine } from "./member.js";
import { mock, stub } from "sinon";
import { counterStaticConfig } from "../examples/counter.js";
import { interpret } from "xstate";
import { TestDurableObjectStorage } from "./testUtils.js";

describe("member actor", () => {
  describe("when a leader", () => {
    const machine = createMemberMachine({
      id: "1",
      storage: stub(new TestDurableObjectStorage()),
      siblings: [],
      staticConfig: counterStaticConfig,
      config: {
        electionDelayMs: 100,
        updatePeriodMs: 100,
      },
      state: {
        currentTerm: 1000,
        log: [],
        state: { count: 0 },
      },
      votesCollected: 0,
      commitIndex: -1,
      lastApplied: -1,
      syncState: {
        "2": {
          nextIndex: 20,
          matchIndex: 10,
        },
        "3": {
          nextIndex: 1,
          matchIndex: 0,
        },
      },
    });

    const service = interpret(machine, { logger: () => null });

    before(() => {
      // service.onTransition((state, event) => {
      //   console.error("onTransition: ", JSON.stringify(state.value), JSON.stringify(event));
      // });
    });

    beforeEach(() => {
      service.start("#member.leader");
    });

    afterEach(() => {
      service.stop();
    });

    it("becomes a follower when receives voteRequest with high enough term", () => {
      service.send({
        type: "voteRequest",
        src: "5",
        lastLogIndex: 10,
        lastLogTerm: 1001,
        srcTerm: 1001,
        replyTo: "na",
      });

      assert.deepEqual(service.state.value, { follower: "waitForMessage" });
    });

    it("ignores voteRequest with lower term", () => {
      service.send({ type: "voteRequest", src: "5", lastLogIndex: 10, lastLogTerm: 999, srcTerm: 999, replyTo: "na" });

      assert.deepEqual(service.state.value, { leader: "waitForUpdate" });
    });

    it("on successful append response updates sync state", () => {
      assert.deepEqual(service.state.context.syncState["2"], { nextIndex: 20, matchIndex: 10 });
      service.send({ type: "appendResponse", success: true, src: "2", srcTerm: 1000, matchIndex: 20 });

      assert.deepEqual(service.state.context.syncState["2"], { nextIndex: 21, matchIndex: 20 });
    });

    it("on failed append response updates sync state", () => {
      assert.deepEqual(service.state.context.syncState["2"], { nextIndex: 20, matchIndex: 10 });
      service.send({ type: "appendResponse", success: false, src: "2", srcTerm: 1000 });

      assert.deepEqual(service.state.context.syncState["2"], { nextIndex: 19, matchIndex: 10 });
    });

    it("ignores failed append response with wrong term", () => {
      assert.deepEqual(service.state.context.syncState["2"], { nextIndex: 20, matchIndex: 10 });
      service.send({ type: "appendResponse", success: false, src: "2", srcTerm: 999 });

      assert.deepEqual(service.state.context.syncState["2"], { nextIndex: 20, matchIndex: 10 });
    });
  });
});
