import {describe, it} from "node:test";
import assert from "node:assert/strict";
import {ECRClient, CreateRepositoryCommand, DeleteRepositoryCommand, DescribeRepositoriesCommand, ListTagsForResourceCommand} from "@aws-sdk/client-ecr";
import {ECSClient, DeregisterTaskDefinitionCommand, ListTaskDefinitionsCommand, RegisterTaskDefinitionCommand} from "@aws-sdk/client-ecs";
import {CloudWatchLogsClient, CreateLogGroupCommand, DeleteLogGroupCommand} from "@aws-sdk/client-cloudwatch-logs";
import {SchedulerClient, DeleteScheduleGroupCommand} from "@aws-sdk/client-scheduler";
import {EPHEMERAL_EXPIRES_AT_TAG, ecrEcsEphemeralCleanup, ecrEcsEphemeralCreateOnly, ecrEcsEphemeralDestroy, ecrEcsEphemeralList} from "./ephemeral.ts";
import {HOUR, awsError, mockClients} from "./test-util.ts";

const mocks = mockClients({ecr: ECRClient, ecs: ECSClient, logs: CloudWatchLogsClient, scheduler: SchedulerClient});

const now = Date.now();
const aliceOld = "awsass-ephemeral-alice-" + (now - 100 * HOUR);
const bobFresh = "awsass-ephemeral-bob-x-" + (now - 1 * HOUR);
const bobTaggedExpired = "awsass-ephemeral-bob-x-" + (now - 2 * HOUR);

// Three ephemerals over two pages plus an unrelated repository.
const mockRepositories = function () {
    mocks.ecr.on(DescribeRepositoriesCommand)
        .resolvesOnce({repositories: [aliceOld, "unrelated"].map(name => ({repositoryName: name, repositoryArn: "arn/" + name})), nextToken: "n"})
        .resolvesOnce({repositories: [bobFresh, bobTaggedExpired].map(name => ({repositoryName: name, repositoryArn: "arn/" + name}))});
    mocks.ecr.on(ListTagsForResourceCommand).resolves({tags: []});
    mocks.ecr.on(ListTagsForResourceCommand, {resourceArn: "arn/" + bobTaggedExpired})
        .resolves({tags: [{Key: EPHEMERAL_EXPIRES_AT_TAG, Value: new Date(now - HOUR).toISOString()}]});
    mocks.ecr.on(DeleteRepositoryCommand).resolves({repository: {}});
    mocks.ecs.on(ListTaskDefinitionsCommand).resolves({taskDefinitionArns: []});
};

describe("ecrEcsEphemeralList", () => {
    it("lists ephemerals with expiry from tag or creation time", async () => {
        mockRepositories();
        const list = await ecrEcsEphemeralList();
        assert.deepEqual(list.map(e => [e.ephemeralId, e.expired]), [[aliceOld, true], [bobFresh, false], [bobTaggedExpired, true]]);
        assert.equal(list[1]!.expiresAt, new Date(now - HOUR + 72 * HOUR).toISOString());
    });
});

describe("ecrEcsEphemeralCleanup", () => {
    it("only lists on dry run", async () => {
        mockRepositories();
        assert.deepEqual(await ecrEcsEphemeralCleanup(undefined, true), {destroyed: [aliceOld, bobTaggedExpired], failed: [], dryRun: true});
        assert.equal(mocks.ecr.commandCalls(DeleteRepositoryCommand).length, 0);
    });

    it("destroys only the given user's expired ephemerals", async () => {
        mockRepositories();
        assert.deepEqual(await ecrEcsEphemeralCleanup("bob-x", false), {destroyed: [bobTaggedExpired], failed: []});
    });

    it("continues after a failure", async () => {
        mockRepositories();
        mocks.ecr.on(DeleteRepositoryCommand, {repositoryName: aliceOld}).rejects(awsError("AccessDeniedException"));
        assert.deepEqual(await ecrEcsEphemeralCleanup(undefined, false), {
            destroyed: [bobTaggedExpired],
            failed: [{ephemeralId: aliceOld, error: "AccessDeniedException"}]
        });
    });
});

describe("ecrEcsEphemeralDestroy", () => {
    it("deregisters exactly its revisions and ignores log group and scheduler errors", async () => {
        const id = "awsass-ephemeral-bob-1";
        mocks.ecs.on(ListTaskDefinitionsCommand)
            .resolvesOnce({taskDefinitionArns: [`arn:aws:ecs:r:1:task-definition/${id}:1`, `arn:aws:ecs:r:1:task-definition/${id}0:1`], nextToken: "n"})
            .resolvesOnce({taskDefinitionArns: [`arn:aws:ecs:r:1:task-definition/${id}:2`]});
        mocks.ecs.on(DeregisterTaskDefinitionCommand).resolves({});
        mocks.ecr.on(DeleteRepositoryCommand).resolves({repository: {repositoryUri: "uri"}});
        mocks.logs.on(DeleteLogGroupCommand).rejects(awsError("ResourceNotFoundException"));
        mocks.scheduler.on(DeleteScheduleGroupCommand).rejects(awsError("AccessDeniedException"));
        assert.deepEqual(await ecrEcsEphemeralDestroy(id), {ephemeralId: id, repositoryUri: "uri"});
        assert.deepEqual(mocks.ecs.commandCalls(DeregisterTaskDefinitionCommand).map(call => call.args[0].input.taskDefinition), [
            `arn:aws:ecs:r:1:task-definition/${id}:1`, `arn:aws:ecs:r:1:task-definition/${id}:2`
        ]);
        assert.deepEqual(mocks.ecr.commandCalls(DeleteRepositoryCommand)[0]!.args[0].input, {repositoryName: id, force: true});
    });
});

describe("ecrEcsEphemeralCreateOnly", () => {
    it("tags the repository with the expiry and registers a fargate task definition", async () => {
        mocks.ecr.on(CreateRepositoryCommand).resolves({repository: {repositoryUri: "uri"}});
        mocks.ecs.on(RegisterTaskDefinitionCommand).resolves({taskDefinition: {taskDefinitionArn: "td-arn"}});
        mocks.logs.on(CreateLogGroupCommand).resolves({});
        const result = await ecrEcsEphemeralCreateOnly("bob", "exec", "task", "256", "512", "2");
        assert.match(result.ephemeralId, /^awsass-ephemeral-bob-\d{13}$/);
        assert.equal(result.taskDefinitionArn, "td-arn");
        const createdAt = parseInt(result.ephemeralId.split("-").pop()!, 10);
        assert.equal(result.expiresAt, new Date(createdAt + 2 * HOUR).toISOString());
        assert.deepEqual(mocks.ecr.commandCalls(CreateRepositoryCommand)[0]!.args[0].input.tags, [{Key: EPHEMERAL_EXPIRES_AT_TAG, Value: result.expiresAt}]);
        const taskDef = mocks.ecs.commandCalls(RegisterTaskDefinitionCommand)[0]!.args[0].input;
        assert.equal(taskDef.containerDefinitions![0]!.memoryReservation, 512);
        assert.equal(taskDef.containerDefinitions![0]!.logConfiguration!.options!["awslogs-region"], "eu-central-1");
    });
});
