import {afterEach, beforeEach} from "node:test";
import {mockClient, type AwsStub} from "aws-sdk-client-mock";
import {configureAws} from "./aws.ts";

type Mock = AwsStub<any, any, any>;

// Mocks the given clients for every test in the calling file and resets them in between.
export function mockClients<T extends Record<string, new (...args: any[]) => any>>(clients: T): {[K in keyof T]: Mock} {
    const mocks = {} as {[K in keyof T]: Mock};
    for (const key in clients)
        mocks[key] = mockClient(clients[key]!);
    beforeEach(() => {
        configureAws({region: "eu-central-1"});
        Object.values(mocks).forEach(mock => mock.reset());
    });
    afterEach(() => Object.values(mocks).forEach(mock => mock.reset()));
    return mocks;
}

export function awsError(name: string): Error {
    const err = new Error(name);
    err.name = name;
    return err;
}

export const HOUR = 60 * 60 * 1000;
