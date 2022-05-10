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

describe("in a 3-member cluster", () => {
  const recorder2 = spawn(recorderMachine.withContext({ log: [] }));
  // todo: recorders don't work.
  recorder2.subscribe((x) => console.error("******", x));

  describe("member actor", () => {
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
        replicatedState: {
          s: { count: 0 },
          term: 999,
          index: 97,
        },
      },
      votesCollected: 0,
      commitIndex: 97,
      lastApplied: -1,
      syncState: {},
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

    describe("follower", () => {
      it("waits for message", () => {
        assert.deepEqual(service.state.value, { follower: "waitForMessage" });
      });

      it("applies log entries when told by leader", () => {
        service.send({
          type: "appendRequest",
          entries: [],
          prevLogIndex: 99,
          prevLogTerm: 1000,
          leaderCommit: 99,
          src: "5",
          srcTerm: 1000,
          replyTo: "na",
        });

        assert.deepEqual(service.state.context.state.log, initialContext.state.log);
        assert.equal(service.state.context.commitIndex, 99);
        assert.deepEqual(service.state.context.state.replicatedState, { s: { count: 2 }, term: 1000, index: 99 });
      });

      it("appends new entries", () => {
        service.send({
          type: "appendRequest",
          entries: [{ action: { type: "inc" }, term: 1000, index: 100 }],
          prevLogIndex: 99,
          prevLogTerm: 1000,
          leaderCommit: 97,
          src: "5",
          srcTerm: 1000,
          replyTo: "na",
        });

        assert.deepEqual(service.state.context.state.log, [
          ...initialContext.state.log,
          { action: { type: "inc" }, term: 1000, index: 100 },
        ]);
      });

      it("appends entries with overlap", () => {
        service.send({
          type: "appendRequest",
          entries: [
            { action: { type: "inc" }, term: 1000, index: 99 },
            { action: { type: "inc" }, term: 1000, index: 100 },
          ],
          prevLogIndex: 98,
          prevLogTerm: 1000,
          leaderCommit: 97,
          src: "5",
          srcTerm: 1000,
          replyTo: "na",
        });

        assert.deepEqual(service.state.context.state.log, [
          ...initialContext.state.log,
          { action: { type: "inc" }, term: 1000, index: 100 },
        ]);
      });
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
        service.send({
          type: "voteRequest",
          src: "2",
          lastLogIndex: 10,
          lastLogTerm: 999,
          srcTerm: 999,
          replyTo: "na",
        });

        assert.deepEqual(service.state.value, { leader: "waitForUpdate" });
      });

      it("on successful append response updates sync state and commits entries", () => {
        service.send({ type: "appendResponse", success: true, src: "2", srcTerm: 1000, matchIndex: 99 });

        assert.deepEqual(service.state.context.syncState["2"], { nextIndex: 100, matchIndex: 99 });
        // 1 follower consitutes a mojority in 3-member case.
        assert.equal(service.state.context.commitIndex, 99);
        assert.deepEqual(service.state.context.state.replicatedState, { s: { count: 2 }, term: 1000, index: 99 });
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
});

describe("in a 5-member cluster", () => {
  const recorder2 = spawn(recorderMachine.withContext({ log: [] }));
  recorder2.subscribe((x) => console.error("******", x));

  describe("member actor", () => {
    const initialContext = {
      id: "1",
      storage: stub(new TestDurableObjectStorage()),
      siblings: [
        { id: "2", ref: recorder2 },
        { id: "3", ref: spawn(recorderMachine) },
        { id: "4", ref: spawn(recorderMachine) },
        { id: "5", ref: spawn(recorderMachine) },
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
        replicatedState: {
          s: { count: 0 },
          term: 999,
          index: 97,
        },
      },
      votesCollected: 0,
      commitIndex: 97,
      lastApplied: -1,
      syncState: {},
    };
    const machine = createMemberMachine(initialContext);
    let service: InterpreterFrom<typeof machine>;

    beforeEach(() => {
      service = interpret(machine, { logger: () => null });
      service.start();
    });

    afterEach(() => {
      service.stop();
    });

    describe("leader", () => {
      beforeEach(() => {
        service.send({ type: "test.leader" });
      });

      it("initializes syncState", () => {
        assert.deepEqual(service.state.context.syncState, {
          "2": { nextIndex: 100, matchIndex: 0 },
          "3": { nextIndex: 100, matchIndex: 0 },
          "4": { nextIndex: 100, matchIndex: 0 },
          "5": { nextIndex: 100, matchIndex: 0 },
        });
      });

      it("on successful append response updates sync state", () => {
        service.send({ type: "appendResponse", success: true, src: "2", srcTerm: 1000, matchIndex: 99 });

        assert.deepEqual(service.state.context.syncState["2"], { nextIndex: 100, matchIndex: 99 });

        // 1 follower is not a majority
        assert.equal(service.state.context.commitIndex, 0);
        assert.deepEqual(service.state.context.state.replicatedState, { s: { count: 0 }, term: 999, index: 97 });
      });
    });
  });
});
