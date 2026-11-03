import {describe, it} from "node:test";
import assert from "node:assert/strict";
import {LambdaClient, GetFunctionConfigurationCommand, GetFunctionCommand, ListVersionsByFunctionCommand, PublishVersionCommand, UpdateFunctionConfigurationCommand} from "@aws-sdk/client-lambda";
import {EventBridgeClient, ListTargetsByRuleCommand, PutTargetsCommand} from "@aws-sdk/client-eventbridge";
import {lambdaKillWarmInstances, scheduledLambdaSetRevision} from "./lambda.ts";
import {mockClients} from "./test-util.ts";

const mocks = mockClients({lambda: LambdaClient, events: EventBridgeClient});

const FN = "arn:aws:lambda:eu-central-1:1:function:f";

describe("scheduledLambdaSetRevision", () => {
    // Published versions 1, 2, 5, 10, 11 (3, 4, 6-9 deleted) over two pages.
    const setup = function (currentQualifier: string | null) {
        mocks.events.on(ListTargetsByRuleCommand).resolves({Targets: [{Id: "t", Arn: FN + (currentQualifier ? ":" + currentQualifier : "")}]});
        mocks.events.on(PutTargetsCommand).resolves({});
        mocks.lambda.on(ListVersionsByFunctionCommand)
            .resolvesOnce({Versions: [{Version: "$LATEST"}, {Version: "1"}, {Version: "2"}, {Version: "5"}], NextMarker: "m"})
            .resolvesOnce({Versions: [{Version: "10"}, {Version: "11"}]});
    };
    const newArn = () => mocks.events.commandCalls(PutTargetsCommand)[0]!.args[0].input.Targets![0]!.Arn;

    for (const [current, revision, expected] of [
        [null, "latest", ":11"],
        [null, undefined, ":11"],
        ["5", "first", ":1"],
        ["5", "-1", ":2"],
        ["5", "+2", ":11"],
        ["$LATEST", "-1", ":10"],
        [null, "$LATEST", ""],
        ["2", "10", ":10"]
    ] as const) {
        it(`moves from ${current ?? "unqualified"} with ${revision} to ${expected || "unqualified"}`, async () => {
            setup(current);
            await scheduledLambdaSetRevision("rule", revision);
            assert.equal(newArn(), FN + expected);
        });
    }

    for (const [current, revision] of [["11", "+1"], ["2", "3"]] as const) {
        it(`rejects ${revision} from ${current}`, async () => {
            setup(current);
            await assert.rejects(scheduledLambdaSetRevision("rule", revision), /Could not find new version/);
            assert.equal(mocks.events.commandCalls(PutTargetsCommand).length, 0);
        });
    }
});

describe("lambdaKillWarmInstances", () => {
    for (const [name, environment, expected] of [
        ["without environment", undefined, {}],
        ["with empty environment", {}, {}],
        ["with variables", {Variables: {X: "1"}}, {X: "1"}]
    ] as const) {
        it(`sets AWSASS and publishes ${name}`, async () => {
            mocks.lambda.on(GetFunctionConfigurationCommand).resolves({Environment: environment, State: "Active", LastUpdateStatus: "Successful"});
            mocks.lambda.on(GetFunctionCommand).resolves({Configuration: {State: "Active", LastUpdateStatus: "Successful"}});
            mocks.lambda.on(UpdateFunctionConfigurationCommand).resolves({});
            mocks.lambda.on(PublishVersionCommand).resolves({Version: "7"});
            assert.equal((await lambdaKillWarmInstances("f")).Version, "7");
            const variables = mocks.lambda.commandCalls(UpdateFunctionConfigurationCommand)[0]!.args[0].input.Environment!.Variables!;
            assert.match(variables.AWSASS!, /^\d+$/);
            delete variables.AWSASS;
            assert.deepEqual(variables, expected);
        });
    }
});
