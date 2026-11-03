import {describe, it} from "node:test";
import assert from "node:assert/strict";
import {ECRClient, DescribeImagesCommand, DescribeRepositoriesCommand, ListTagsForResourceCommand} from "@aws-sdk/client-ecr";
import {ECSClient, DescribeTaskDefinitionCommand} from "@aws-sdk/client-ecs";
import {EC2Client, DescribeSubnetsCommand} from "@aws-sdk/client-ec2";
import {SchedulerClient, CreateScheduleCommand, CreateScheduleGroupCommand, GetScheduleCommand, ListSchedulesCommand} from "@aws-sdk/client-scheduler";
import {ecsListScheduled, ecsScheduleOnFargate} from "./schedule.ts";
import {HOUR, awsError, mockClients} from "./test-util.ts";

const mocks = mockClients({ecr: ECRClient, ecs: ECSClient, ec2: EC2Client, scheduler: SchedulerClient});

const now = Date.now();
const ephemeralId = "awsass-ephemeral-bob-" + (now - HOUR);

const setup = function (family: string) {
    mocks.ecs.on(DescribeTaskDefinitionCommand).resolves({taskDefinition: {family: family, containerDefinitions: [{name: family}]}});
    mocks.ec2.on(DescribeSubnetsCommand).resolves({Subnets: [{SubnetId: "s1"}]});
    mocks.ecr.on(DescribeRepositoriesCommand).resolves({repositories: [{repositoryName: ephemeralId, repositoryArn: "arn"}]});
    mocks.ecr.on(ListTagsForResourceCommand).resolves({tags: []});
    mocks.ecr.on(DescribeImagesCommand).resolves({imageDetails: []});
    mocks.scheduler.on(CreateScheduleGroupCommand).rejects(awsError("ConflictException"));
    mocks.scheduler.on(CreateScheduleCommand).resolves({ScheduleArn: "sched-arn"});
};

describe("ecsScheduleOnFargate", () => {
    it("schedules an ephemeral in its own group and warns about a missing image", async () => {
        setup(ephemeralId);
        const runAt = new Date(now + 5 * HOUR);
        const result = await ecsScheduleOnFargate(ephemeralId, "cluster", ["A:1"], runAt.toISOString(), "role");
        assert.equal(result.scheduleGroup, ephemeralId);
        assert.match(result.warning ?? "", /has no image yet/);
        const input = mocks.scheduler.commandCalls(CreateScheduleCommand)[0]!.args[0].input;
        assert.equal(input.ScheduleExpression, `at(${runAt.toISOString().substring(0, 19)})`);
        assert.equal(input.ScheduleExpressionTimezone, "UTC");
        assert.equal(input.ActionAfterCompletion, "DELETE");
        assert.equal(input.Target!.Arn, "arn:aws:scheduler:::aws-sdk:ecs:runTask");
        assert.deepEqual(JSON.parse(input.Target!.Input!).overrides, {containerOverrides: [{name: ephemeralId, environment: [{name: "A", value: "1"}]}]});
    });

    it("uses the default group for other task definitions", async () => {
        setup("my-task");
        const result = await ecsScheduleOnFargate("my-task", "cluster", undefined, new Date(now + 200 * HOUR).toISOString(), "role");
        assert.equal(result.scheduleGroup, "default");
        assert.equal(mocks.scheduler.commandCalls(CreateScheduleGroupCommand).length, 0);
    });

    it("rejects runs after the ephemeral expires", async () => {
        setup(ephemeralId);
        await assert.rejects(ecsScheduleOnFargate(ephemeralId, "cluster", undefined, new Date(now + 100 * HOUR).toISOString(), "role"), /expires at/);
    });

    it("rejects times in the past and invalid times", async () => {
        await assert.rejects(ecsScheduleOnFargate(ephemeralId, "cluster", undefined, "2020-01-01T00:00", "role"), /in the past/);
        await assert.rejects(ecsScheduleOnFargate(ephemeralId, "cluster", undefined, "tomorrow", "role"), /Invalid time/);
    });
});

describe("ecsListScheduled", () => {
    it("lists only pending schedules", async () => {
        const future = new Date(now + HOUR).toISOString().substring(0, 19);
        const past = new Date(now - HOUR).toISOString().substring(0, 19);
        mocks.scheduler.on(ListSchedulesCommand).resolves({Schedules: [{Name: "awsass-run-1", GroupName: "g"}, {Name: "awsass-run-2", GroupName: "g"}]});
        mocks.scheduler.on(GetScheduleCommand, {Name: "awsass-run-1"}).resolves({Name: "awsass-run-1", GroupName: "g", ScheduleExpression: `at(${future})`,
            Target: {Arn: "a", RoleArn: "r", Input: JSON.stringify({taskDefinition: "td", cluster: "c"})}});
        mocks.scheduler.on(GetScheduleCommand, {Name: "awsass-run-2"}).resolves({Name: "awsass-run-2", GroupName: "g", ScheduleExpression: `at(${past})`});
        assert.deepEqual(await ecsListScheduled(), [
            {scheduleName: "awsass-run-1", scheduleGroup: "g", runAt: future + ".000Z", taskDefinition: "td", cluster: "c"}
        ]);
    });
});
