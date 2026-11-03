import {ECS, paginateListTaskDefinitionFamilies, type KeyValuePair, type RegisterTaskDefinitionCommandInput, type RunTaskCommandInput, type TaskDefinition} from "@aws-sdk/client-ecs";
import {EC2, paginateDescribeSubnets, type Subnet} from "@aws-sdk/client-ec2";
import {CloudWatchLogs} from "@aws-sdk/client-cloudwatch-logs";
import {clientConfig} from "./aws.ts";

export async function ecsDescribeTaskDefinition(ecs: ECS, taskDefinition: string): Promise<TaskDefinition> {
    const result = await ecs.describeTaskDefinition({taskDefinition: taskDefinition});
    if (!result.taskDefinition)
        throw new Error(`Could not find task definition ${taskDefinition}.`);
    return result.taskDefinition;
}

export async function ecsCreateNewRevisionForContainer(taskDefinition: string, containerName: string, imageName: string) {
    if (!imageName)
        throw new Error(`Empty image name ${imageName}.`);
    const ecs = new ECS(clientConfig());
    const current = await ecsDescribeTaskDefinition(ecs, taskDefinition);
    const containerDefinition = current.containerDefinitions?.find(containerDefinition => containerDefinition.name === containerName);
    if (!containerDefinition)
        throw new Error(`Could not find container definition ${containerName}.`);
    containerDefinition.image = imageName;
    // Everything except the read-only fields is carried over to the new revision.
    const {taskDefinitionArn, revision, status, requiresAttributes, compatibilities, registeredAt, registeredBy, deregisteredAt, ...input} = current;
    return ecs.registerTaskDefinition(input as RegisterTaskDefinitionCommandInput);
}

export async function ecsListRevision(): Promise<string[]> {
    const ecs = new ECS(clientConfig());
    const images: string[] = [];
    for await (const page of paginateListTaskDefinitionFamilies({client: ecs}, {status: "ACTIVE"})) {
        for (const family of page.families ?? []) {
            const taskDefinition = await ecsDescribeTaskDefinition(ecs, family);
            const image = taskDefinition.containerDefinitions?.[0]?.image;
            if (image)
                images.push(image);
        }
    }
    return images;
}

export async function ec2GetSubnets(): Promise<string[]> {
    const ec2 = new EC2(clientConfig());
    let allSubnets: Subnet[] = [];
    for await (const page of paginateDescribeSubnets({client: ec2}, {}))
        allSubnets = allSubnets.concat(page.Subnets ?? []);
    let subnets = allSubnets.filter(subnet => subnet.DefaultForAz);
    if (subnets.length === 0)
        subnets = allSubnets;
    return subnets.flatMap(subnet => subnet.SubnetId ? [subnet.SubnetId] : []);
}

// Overrides are "KEY:VALUE"; only the first colon separates key and value.
export function applyEnvironmentVariables(environment: KeyValuePair[] | undefined, environmentVariables: string[]): KeyValuePair[] {
    const env = new Map<string, string | undefined>();
    (environment ?? []).forEach(kv => {
        if (kv.name)
            env.set(kv.name, kv.value);
    });
    environmentVariables.forEach(kv => {
        const idx = kv.indexOf(":");
        if (idx < 0)
            env.set(kv, "");
        else
            env.set(kv.substring(0, idx), kv.substring(idx + 1));
    });
    return Array.from(env, ([name, value]) => ({name: name, value: value}));
}

export async function ecsFargateRunTaskParams(taskDefinition: string, clusterName: string, environmentVariables?: string[]): Promise<{params: RunTaskCommandInput, taskDefinition: TaskDefinition}> {
    const ecs = new ECS(clientConfig());
    const taskDef = await ecsDescribeTaskDefinition(ecs, taskDefinition);
    const containerOverrides = environmentVariables ? (taskDef.containerDefinitions ?? []).map(containerDef => ({
        name: containerDef.name,
        environment: applyEnvironmentVariables(containerDef.environment, environmentVariables)
    })) : undefined;
    const subnets = await ec2GetSubnets();
    return {
        params: {
            taskDefinition: taskDefinition,
            cluster: clusterName,
            launchType: "FARGATE",
            networkConfiguration: {
                awsvpcConfiguration: {
                    assignPublicIp: "ENABLED",
                    subnets: subnets
                }
            },
            overrides: containerOverrides ? {
                containerOverrides: containerOverrides
            } : undefined
        },
        taskDefinition: taskDef
    };
}

export async function ecsRunOnFargate(taskDefinition: string, clusterName: string, environmentVariables?: string[]) {
    const ecs = new ECS(clientConfig());
    const {params} = await ecsFargateRunTaskParams(taskDefinition, clusterName, environmentVariables);
    return ecs.runTask(params);
}

export async function ecsTaskLogs(taskArn: string, clusterName: string): Promise<string[]> {
    const ecs = new ECS(clientConfig());
    const cloudwatchlogs = new CloudWatchLogs(clientConfig());
    const describeTasks = await ecs.describeTasks({tasks: [taskArn], cluster: clusterName});
    const task = describeTasks.tasks?.[0];
    if (!task?.taskDefinitionArn)
        throw new Error(`Could not find task ${taskArn}.`);
    const taskDef = await ecsDescribeTaskDefinition(ecs, task.taskDefinitionArn);
    const containerDef = taskDef.containerDefinitions?.[0];
    const logOptions = containerDef?.logConfiguration?.options;
    if (containerDef?.logConfiguration?.logDriver !== "awslogs" || !logOptions?.["awslogs-group"])
        throw new Error("Task does not log to CloudWatch Logs.");
    // awslogs streams are named <prefix>/<container name>/<task id>.
    const taskId = taskArn.split("/").pop();
    const logEvents = await cloudwatchlogs.getLogEvents({
        logGroupName: logOptions["awslogs-group"],
        logStreamName: [logOptions["awslogs-stream-prefix"], containerDef.name, taskId].join("/"),
        limit: 100
    });
    return (logEvents.events ?? []).map(event => event.message ?? "");
}
