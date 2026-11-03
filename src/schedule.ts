import {ECR} from "@aws-sdk/client-ecr";
import {Scheduler, paginateListSchedules, type ScheduleSummary} from "@aws-sdk/client-scheduler";
import {clientConfig, errorName} from "./aws.ts";
import {ecsFargateRunTaskParams} from "./ecs.ts";
import {EPHEMERAL_PREFIX, ecrEphemeralExpiresAt} from "./ephemeral.ts";

export const SCHEDULE_NAME_PREFIX = "awsass-run-";

export async function ecsScheduleOnFargate(taskDefinition: string, clusterName: string, environmentVariables: string[] | undefined, at: string, schedulerRoleArn: string) {
    const ecr = new ECR(clientConfig());
    const scheduler = new Scheduler(clientConfig());
    const runAt = new Date(at);
    if (isNaN(runAt.getTime()))
        throw new Error(`Invalid time ${at}.`);
    if (runAt.getTime() <= Date.now())
        throw new Error(`Time ${runAt.toISOString()} is in the past.`);
    const {params, taskDefinition: taskDef} = await ecsFargateRunTaskParams(taskDefinition, clusterName, environmentVariables);
    let groupName = "default";
    let warning: string | undefined = undefined;
    if (taskDef.family?.startsWith(EPHEMERAL_PREFIX)) {
        const ephemeralId = taskDef.family;
        const expiresAt = await ecrEphemeralExpiresAt(ephemeralId);
        if (runAt.getTime() > expiresAt.getTime())
            throw new Error(`Ephemeral ${ephemeralId} expires at ${expiresAt.toISOString()}, before ${runAt.toISOString()}. Recreate it with a larger --ttl-hours.`);
        const describeImages = await ecr.describeImages({repositoryName: ephemeralId, maxResults: 1});
        if ((describeImages.imageDetails ?? []).length === 0)
            warning = `Repository ${ephemeralId} has no image yet; push one before ${runAt.toISOString()}.`;
        try {
            await scheduler.createScheduleGroup({Name: ephemeralId});
        } catch (err) {
            if (errorName(err) !== "ConflictException")
                throw err;
        }
        groupName = ephemeralId;
    }
    const scheduleName = SCHEDULE_NAME_PREFIX + Date.now();
    const createSchedule = await scheduler.createSchedule({
        Name: scheduleName,
        GroupName: groupName,
        ScheduleExpression: "at(" + runAt.toISOString().substring(0, 19) + ")",
        ScheduleExpressionTimezone: "UTC",
        FlexibleTimeWindow: {Mode: "OFF"},
        ActionAfterCompletion: "DELETE",
        Target: {
            Arn: "arn:aws:scheduler:::aws-sdk:ecs:runTask",
            RoleArn: schedulerRoleArn,
            Input: JSON.stringify(params),
            RetryPolicy: {
                MaximumRetryAttempts: 3,
                MaximumEventAgeInSeconds: 3600
            }
        }
    });
    return {
        scheduleName: scheduleName,
        scheduleGroup: groupName,
        scheduleArn: createSchedule.ScheduleArn,
        runAt: runAt.toISOString(),
        warning: warning
    };
}

export async function ecsListScheduled() {
    const scheduler = new Scheduler(clientConfig());
    let schedules: ScheduleSummary[] = [];
    for await (const page of paginateListSchedules({client: scheduler}, {NamePrefix: SCHEDULE_NAME_PREFIX}))
        schedules = schedules.concat(page.Schedules ?? []);
    const result: {scheduleName?: string, scheduleGroup?: string, runAt: string, taskDefinition?: string, cluster?: string}[] = [];
    for (const schedule of schedules) {
        const getSchedule = await scheduler.getSchedule({Name: schedule.Name, GroupName: schedule.GroupName});
        const match = /^at\((.*)\)$/.exec(getSchedule.ScheduleExpression ?? "");
        const runAt = match ? new Date(match[1] + "Z") : undefined;
        // Completed schedules can still be listed shortly before they delete themselves.
        if (!runAt || runAt.getTime() <= Date.now())
            continue;
        const input = JSON.parse(getSchedule.Target?.Input ?? "{}");
        result.push({
            scheduleName: getSchedule.Name,
            scheduleGroup: getSchedule.GroupName,
            runAt: runAt.toISOString(),
            taskDefinition: input.taskDefinition,
            cluster: input.cluster
        });
    }
    return result;
}

export async function ecsDeleteScheduled(scheduleName: string, scheduleGroup: string | undefined) {
    const scheduler = new Scheduler(clientConfig());
    return scheduler.deleteSchedule({Name: scheduleName, GroupName: scheduleGroup || "default"});
}
