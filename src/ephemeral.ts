import {userInfo} from "node:os";
import {ECR, paginateDescribeRepositories} from "@aws-sdk/client-ecr";
import {ECS, paginateListTaskDefinitions} from "@aws-sdk/client-ecs";
import {CloudWatchLogs} from "@aws-sdk/client-cloudwatch-logs";
import {Scheduler} from "@aws-sdk/client-scheduler";
import {clientConfig} from "./aws.ts";

export const EPHEMERAL_PREFIX = "awsass-ephemeral-";
export const EPHEMERAL_EXPIRES_AT_TAG = "awsass:expires-at";
export const EPHEMERAL_DEFAULT_TTL_HOURS = 72;
const HOUR = 60 * 60 * 1000;

export interface Ephemeral {
    ephemeralId: string;
    createdAt: string;
    expiresAt: string;
    expired: boolean;
}

export function ephemeralCreatedAt(ephemeralId: string): Date {
    return new Date(parseInt(ephemeralId.split("-").pop() ?? "", 10));
}

const repositoryExpiresAt = async function (ecr: ECR, ephemeralId: string, repositoryArn: string): Promise<Date> {
    const listTags = await ecr.listTagsForResource({resourceArn: repositoryArn});
    const tag = (listTags.tags ?? []).find(tag => tag.Key === EPHEMERAL_EXPIRES_AT_TAG);
    // Ephemerals created before expiry tagging fall back to the creation time encoded in the id.
    return tag?.Value ? new Date(tag.Value) : new Date(ephemeralCreatedAt(ephemeralId).getTime() + EPHEMERAL_DEFAULT_TTL_HOURS * HOUR);
};

export async function ecrEphemeralExpiresAt(ephemeralId: string): Promise<Date> {
    const ecr = new ECR(clientConfig());
    const describeRepositories = await ecr.describeRepositories({repositoryNames: [ephemeralId]});
    const repositoryArn = describeRepositories.repositories?.[0]?.repositoryArn;
    if (!repositoryArn)
        throw new Error(`Could not find repository ${ephemeralId}.`);
    return repositoryExpiresAt(ecr, ephemeralId, repositoryArn);
}

export async function ecrEcsEphemeralCreate(executionRoleArn: string, taskRoleArn: string, cpuUnits: string, memoryUnits: string, ttlHours: string | undefined) {
    const username = userInfo().username;
    let cleanedUp: string[] = [];
    try {
        // Opportunistically clean up the user's own expired ephemerals; failures must not block creation.
        cleanedUp = (await ecrEcsEphemeralCleanup(username, false)).destroyed;
    } catch (err) {
        // ignored
    }
    const created = await ecrEcsEphemeralCreateOnly(username, executionRoleArn, taskRoleArn, cpuUnits, memoryUnits, ttlHours);
    return {...created, cleanedUp: cleanedUp};
}

export async function ecrEcsEphemeralCreateOnly(username: string, executionRoleArn: string, taskRoleArn: string, cpuUnits: string, memoryUnits: string, ttlHours: string | undefined) {
    const ecr = new ECR(clientConfig());
    const ecs = new ECS(clientConfig());
    const cloudwatchlogs = new CloudWatchLogs(clientConfig());
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + parseFloat(ttlHours || String(EPHEMERAL_DEFAULT_TTL_HOURS)) * HOUR);
    if (isNaN(expiresAt.getTime()))
        throw new Error(`Invalid ttl ${ttlHours}.`);
    const ephemeralId = EPHEMERAL_PREFIX + username + "-" + createdAt.getTime();
    const createRepository = await ecr.createRepository({
        repositoryName: ephemeralId,
        tags: [{Key: EPHEMERAL_EXPIRES_AT_TAG, Value: expiresAt.toISOString()}]
    });
    const repositoryUri = createRepository.repository?.repositoryUri;
    const registerTaskDefinition = await ecs.registerTaskDefinition({
        family: ephemeralId,
        cpu: cpuUnits,
        memory: memoryUnits,
        networkMode: "awsvpc",
        executionRoleArn: executionRoleArn,
        taskRoleArn: taskRoleArn,
        requiresCompatibilities: ["FARGATE"],
        containerDefinitions: [{
            name: ephemeralId,
            essential: true,
            memoryReservation: parseInt(memoryUnits, 10),
            cpu: parseInt(cpuUnits, 10),
            image: repositoryUri,
            logConfiguration: {
                logDriver: "awslogs",
                options: {
                    "awslogs-group": "/ecs/" + ephemeralId,
                    "awslogs-region": await ecs.config.region(),
                    "awslogs-stream-prefix": "ecs"
                }
            }
        }]
    });
    await cloudwatchlogs.createLogGroup({logGroupName: "/ecs/" + ephemeralId});
    return {
        ephemeralId: ephemeralId,
        repositoryUri: repositoryUri,
        taskDefinitionArn: registerTaskDefinition.taskDefinition?.taskDefinitionArn,
        expiresAt: expiresAt.toISOString()
    };
}

export async function ecrEcsEphemeralList(): Promise<Ephemeral[]> {
    const ecr = new ECR(clientConfig());
    const result: Ephemeral[] = [];
    for await (const page of paginateDescribeRepositories({client: ecr}, {})) {
        for (const repository of page.repositories ?? []) {
            if (!repository.repositoryName?.startsWith(EPHEMERAL_PREFIX) || !repository.repositoryArn)
                continue;
            const expiresAt = await repositoryExpiresAt(ecr, repository.repositoryName, repository.repositoryArn);
            result.push({
                ephemeralId: repository.repositoryName,
                createdAt: ephemeralCreatedAt(repository.repositoryName).toISOString(),
                expiresAt: expiresAt.toISOString(),
                expired: expiresAt.getTime() <= Date.now()
            });
        }
    }
    return result;
}

export async function ecrEcsEphemeralCleanup(username: string | undefined, dryRun: boolean | undefined) {
    const ephemerals = await ecrEcsEphemeralList();
    const expired = ephemerals.filter(ephemeral => ephemeral.expired && (!username || ephemeral.ephemeralId.startsWith(EPHEMERAL_PREFIX + username + "-")));
    if (dryRun)
        return {destroyed: expired.map(ephemeral => ephemeral.ephemeralId), failed: [], dryRun: true};
    const result: {destroyed: string[], failed: {ephemeralId: string, error: string}[]} = {destroyed: [], failed: []};
    for (const ephemeral of expired) {
        try {
            await ecrEcsEphemeralDestroy(ephemeral.ephemeralId);
            result.destroyed.push(ephemeral.ephemeralId);
        } catch (err) {
            result.failed.push({ephemeralId: ephemeral.ephemeralId, error: err instanceof Error ? err.message : String(err)});
        }
    }
    return result;
}

export async function ecrEcsEphemeralDestroy(ephemeralId: string) {
    const ecr = new ECR(clientConfig());
    const ecs = new ECS(clientConfig());
    const cloudwatchlogs = new CloudWatchLogs(clientConfig());
    const scheduler = new Scheduler(clientConfig());
    for await (const page of paginateListTaskDefinitions({client: ecs}, {familyPrefix: ephemeralId})) {
        for (const arn of page.taskDefinitionArns ?? []) {
            // familyPrefix also matches longer family names, so compare the exact family.
            if (arn.split("/").pop()?.split(":")[0] === ephemeralId)
                await ecs.deregisterTaskDefinition({taskDefinition: arn}).catch(() => undefined);
        }
    }
    const deleteRepository = await ecr.deleteRepository({repositoryName: ephemeralId, force: true});
    await cloudwatchlogs.deleteLogGroup({logGroupName: "/ecs/" + ephemeralId}).catch(() => undefined);
    // Removes pending scheduled runs; errors are ignored so destroy works without scheduler access.
    await scheduler.deleteScheduleGroup({Name: ephemeralId}).catch(() => undefined);
    return {
        ephemeralId: ephemeralId,
        repositoryUri: deleteRepository.repository?.repositoryUri
    };
}
