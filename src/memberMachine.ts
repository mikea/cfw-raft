import { createMachine } from "xstate";

export const memberMachine = createMachine({
    initial: "follower",
    states: {
        follower: {

        },
        candidate: {

        },
        leader: {

        },
    }
});