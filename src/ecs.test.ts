import {describe, it} from "node:test";
import assert from "node:assert/strict";
import {ECSClient, DescribeTaskDefinitionCommand, DescribeTasksCommand, RegisterTaskDefinitionCommand} from "@aws-sdk/client-ecs";
import {EC2Client, DescribeSubnetsCommand} from "@aws-sdk/client-ec2";
import {CloudWatchLogsClient, GetLogEventsCommand} from "@aws-sdk/client-cloudwatch-logs";
import {applyEnvironmentVariables, ec2GetSubnets, ecsCreateNewRevisionForContainer, ecsFargateRunTaskParams, ecsTaskLogs} from "./ecs.ts";
import {mockClients} from "./test-util.ts";

const mocks = mockClients({ecs: ECSClient, ec2: EC2Client, logs: CloudWatchLogsClient});

describe("applyEnvironmentVariables", () => {
    it("overrides and adds variables, splitting at the first colon only", () => {
        assert.deepEqual(applyEnvironmentVariables([{name: "A", value: "1"}, {name: "C", value: "3"}], ["A:2", "B:x:y", "D"]), [
            {name: "A", value: "2"}, {name: "C", value: "3"}, {name: "B", value: "x:y"}, {name: "D", value: ""}
        ]);
    });

    it("works for containers without environment", () => {
        assert.deepEqual(applyEnvironmentVariables(undefined, ["A:1"]), [{name: "A", value: "1"}]);
    });
});

describe("ec2GetSubnets", () => {
    it("prefers default subnets across pages", async () => {
        mocks.ec2.on(DescribeSubnetsCommand)
            .resolvesOnce({Subnets: [{SubnetId: "s1"}, {SubnetId: "s2", DefaultForAz: true}], NextToken: "n"})
            .resolvesOnce({Subnets: [{SubnetId: "s3", DefaultForAz: true}]});
        assert.deepEqual(await ec2GetSubnets(), ["s2", "s3"]);
    });

    it("falls back to all subnets", async () => {
        mocks.ec2.on(DescribeSubnetsCommand).resolves({Subnets: [{SubnetId: "s1"}, {SubnetId: "s2"}]});
        assert.deepEqual(await ec2GetSubnets(), ["s1", "s2"]);
    });
});

describe("ecsFargateRunTaskParams", () => {
    it("builds fargate params with environment overrides", async () => {
        mocks.ecs.on(DescribeTaskDefinitionCommand).resolves({taskDefinition: {family: "f", containerDefinitions: [{name: "c"}]}});
        mocks.ec2.on(DescribeSubnetsCommand).resolves({Subnets: [{SubnetId: "s1", DefaultForAz: true}]});
        const {params} = await ecsFargateRunTaskParams("f", "cluster", ["A:1"]);
        assert.deepEqual(params, {
            taskDefinition: "f",
            cluster: "cluster",
            launchType: "FARGATE",
            networkConfiguration: {awsvpcConfiguration: {assignPublicIp: "ENABLED", subnets: ["s1"]}},
            overrides: {containerOverrides: [{name: "c", environment: [{name: "A", value: "1"}]}]}
        });
    });

    it("has no overrides without environment variables", async () => {
        mocks.ecs.on(DescribeTaskDefinitionCommand).resolves({taskDefinition: {family: "f", containerDefinitions: [{name: "c"}]}});
        mocks.ec2.on(DescribeSubnetsCommand).resolves({Subnets: [{SubnetId: "s1"}]});
        assert.equal((await ecsFargateRunTaskParams("f", "cluster")).params.overrides, undefined);
    });
});

describe("ecsCreateNewRevisionForContainer", () => {
    it("registers a copy with the new image and without read-only fields", async () => {
        mocks.ecs.on(DescribeTaskDefinitionCommand).resolves({taskDefinition: {
            family: "f", taskDefinitionArn: "arn", revision: 3, status: "ACTIVE", registeredAt: new Date(), cpu: "256",
            containerDefinitions: [{name: "a", image: "old-a"}, {name: "b", image: "old-b"}]
        }});
        mocks.ecs.on(RegisterTaskDefinitionCommand).resolves({});
        await ecsCreateNewRevisionForContainer("f", "b", "new-b");
        assert.deepEqual(mocks.ecs.commandCalls(RegisterTaskDefinitionCommand)[0]!.args[0].input, {
            family: "f", cpu: "256", containerDefinitions: [{name: "a", image: "old-a"}, {name: "b", image: "new-b"}]
        });
    });

    it("fails for an unknown container", async () => {
        mocks.ecs.on(DescribeTaskDefinitionCommand).resolves({taskDefinition: {family: "f", containerDefinitions: [{name: "a"}]}});
        await assert.rejects(ecsCreateNewRevisionForContainer("f", "x", "img"), /Could not find container definition x/);
    });
});

describe("ecsTaskLogs", () => {
    it("reads the awslogs stream of the task", async () => {
        mocks.ecs.on(DescribeTasksCommand).resolves({tasks: [{taskDefinitionArn: "td"}]});
        mocks.ecs.on(DescribeTaskDefinitionCommand).resolves({taskDefinition: {containerDefinitions: [{
            name: "app",
            logConfiguration: {logDriver: "awslogs", options: {"awslogs-group": "/ecs/app", "awslogs-stream-prefix": "ecs"}}
        }]}});
        mocks.logs.on(GetLogEventsCommand).resolves({events: [{message: "hello"}, {message: "world"}]});
        assert.deepEqual(await ecsTaskLogs("arn:aws:ecs:eu-central-1:1:task/cluster/abc123", "cluster"), ["hello", "world"]);
        assert.deepEqual(mocks.logs.commandCalls(GetLogEventsCommand)[0]!.args[0].input, {
            logGroupName: "/ecs/app", logStreamName: "ecs/app/abc123", limit: 100
        });
    });
});
