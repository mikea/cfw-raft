import { assert } from "chai";
import { createMemberMachine } from "./member.js";
import { stub } from "sinon";
import { counterStaticConfig } from "../examples/counter.js";
import { assign, createMachine, EventObject, interpret, InterpreterFrom, spawn } from "xstate";
import { TestDurableObjectStorage } from "./testUtils.js";
import { log } from "xstate/lib/actions.js";

// todo: record all messages
const recorderMachine = createMachine<
  {
    log: unknown[];
  },
  EventObject
>({
  initial: "start",
  states: {
    start: {
      on: {
        "*": {
          actions: [assign({ log: (ctx, evt) => [...ctx.log, evt] }), log("*******")],
        },
      },
    },
  },
});

describe("member actor", () => {
  const recorder2 = spawn(recorderMachine.withContext({ log: [] }));
  recorder2.subscribe((x) => console.error("******", x));

  const initialContext = {
    id: "1",
    storage: stub(new TestDurableObjectStorage()),
    siblings: [
      { id: "2", ref: recorder2 },
      { id: "3", ref: spawn(recorderMachine) },
    ],
    staticConfig: counterStaticConfig,
    config: {
      electionDelayMs: 100,
      updatePeriodMs: 100,
    },
    state: {
      currentTerm: 1000,
      log: [
        { action: { type: "inc" }, index: 98, term: 1000 },
        { action: { type: "inc" }, index: 99, term: 1000 },
      ],
      state: { count: 0 },
    },
    votesCollected: 0,
    commitIndex: -1,
    lastApplied: -1,
    syncState: { },
  };
  const machine = createMemberMachine(initialContext);
  let service: InterpreterFrom<typeof machine>;

  beforeEach(() => {
    service = interpret(machine, { logger: () => null });
    service.start();

    // service.onTransition((state, event) => {
    //   console.error("onTransition: ", JSON.stringify(state.value), JSON.stringify(event));
    // });
  });

  afterEach(() => {
    service.stop();
  });

  describe("candidate", () => {
    beforeEach(() => {
      service.send({ type: "test.candidate" });
    });

    it("advances term and sends voting requests", () => {
      assert.equal(1001, service.state.context.state.currentTerm);
      assert.deepEqual(service.state.value, { candidate: "putState" });
    });
  });

  describe("leader", () => {
    beforeEach(() => {
      service.send({ type: "test.leader" });
    });


    it("initializes syncState", () => {
      assert.deepEqual(service.state.context.syncState, {
        "2": { nextIndex: 100, matchIndex: 0 },
        "3": { nextIndex: 100, matchIndex: 0 },
      });
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
      service.send({ type: "voteRequest", src: "2", lastLogIndex: 10, lastLogTerm: 999, srcTerm: 999, replyTo: "na" });

      assert.deepEqual(service.state.value, { leader: "waitForUpdate" });
    });

    it("on successful append response updates sync state", () => {
      service.send({ type: "appendResponse", success: true, src: "2", srcTerm: 1000, matchIndex: 102 });

      assert.deepEqual(service.state.context.syncState["2"], { nextIndex: 103, matchIndex: 102 });
    });

    it("ignores successful append response with wrong term", () => {
      service.send({ type: "appendResponse", success: true, src: "2", srcTerm: 999, matchIndex: 999 });

      assert.deepEqual(service.state.context.syncState["2"], { nextIndex: 100, matchIndex: 0 });
    });

    it("on failed append response decrements nextIndex in sync state", () => {
      service.send({ type: "appendResponse", success: false, src: "2", srcTerm: 1000 });

      assert.deepEqual(service.state.context.syncState["2"], { nextIndex: 99, matchIndex: 0 });
    });

    it("ignores failed append response with wrong term", () => {
      service.send({ type: "appendResponse", success: false, src: "2", srcTerm: 999 });

      assert.deepEqual(service.state.context.syncState["2"], { nextIndex: 100, matchIndex: 0 });
    });
  });
});
