import { assert } from "chai";
import { createMemberMachine } from "./member.js";
import { mock, stub } from "sinon";
import { counterStaticConfig } from "../examples/counter.js";

class TestDurableObjectStorage implements DurableObjectStorage {
  get<T = unknown>(key: string, options?: DurableObjectGetOptions): Promise<T | undefined>;
  get<T = unknown>(keys: string[], options?: DurableObjectGetOptions): Promise<Map<string, T>>;
  get<T = unknown>(_keys: string | string[], _options?: DurableObjectGetOptions): Promise<T | undefined> | Promise<Map<string, T>> {
    throw new Error("Method not implemented.");
  }
  list<T = unknown>(_options?: DurableObjectListOptions): Promise<Map<string, T>> {
    throw new Error("Method not implemented.");
  }
  put<T>(key: string, value: T, options?: DurableObjectPutOptions): Promise<void>;
  put<T>(entries: Record<string, T>, options?: DurableObjectPutOptions): Promise<void>;
  put<T>(_keyOrEntries: string | Record<string,T>, _valueOrOptions?: T | DurableObjectPutOptions, _options?: DurableObjectPutOptions): Promise<void> {
    throw new Error("Method not implemented.");
  }
  delete(key: string, options?: DurableObjectPutOptions): Promise<boolean>;
  delete(keys: string[], options?: DurableObjectPutOptions): Promise<number>;
  delete(_keys: string | string[], _options?: DurableObjectPutOptions): Promise<boolean> | Promise<number> {
    throw new Error("Method not implemented.");
  }
  
  deleteAll(_options?: DurableObjectPutOptions): Promise<void> {
    throw new Error("Method not implemented.");
  }
  transaction<T>(_closure: (txn: DurableObjectTransaction) => Promise<T>): Promise<T> {
    throw new Error("Method not implemented.");
  }
  
  getAlarm(_options?: DurableObjectGetAlarmOptions): Promise<number | null> {
    throw new Error("Method not implemented.");
  }
  
  setAlarm(_arg2: Date, _options?: DurableObjectSetAlarmOptions): Promise<void> {
    throw new Error("Method not implemented.");
  }

  deleteAlarm(_options?: DurableObjectSetAlarmOptions): Promise<void> {
    throw new Error("Method not implemented.");
  }
}

describe("member actor", () => {
  describe("when a leader", () => {
    it("works", () => {
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
        syncState: {},
      });

      assert(false, "test");
    });
  });
});
