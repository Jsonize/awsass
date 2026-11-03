#!/usr/bin/env node
import {Command, type OptionValues} from "commander";
import {configureAws} from "./aws.ts";
import {ecsCreateNewRevisionForContainer, ecsListRevision, ecsRunOnFargate, ecsTaskLogs} from "./ecs.ts";
import {ecrEcsPushNewRevision, ecrEcsSetRevision, ecrLogin, ecrTagPush} from "./ecr.ts";
import {ecrEcsEphemeralCleanup, ecrEcsEphemeralCreate, ecrEcsEphemeralDestroy, ecrEcsEphemeralList} from "./ephemeral.ts";
import {ecsDeleteScheduled, ecsListScheduled, ecsScheduleOnFargate} from "./schedule.ts";
import {edgeLambdaKillWarmInstances, lambdaKillWarmInstances, lambdaUpdatePublishLocal, lambdaUpdatePublishS3, scheduledLambdaListRevision, scheduledLambdaSetRevision} from "./lambda.ts";
import {apiGatewayAddLambdaPermission, apiGatewayDeployLambdaProxySubRoute, apiGatewayLambdaDeploySub} from "./apiGateway.ts";

const program = new Command()
    .name("awsass")
    .option("-p, --profile <profile>", "aws profile")
    .option("-r, --region <region>", "aws region")
    .option("--ecs-create-new-revision-for-container", "create a new ecs revision, updating a container")
    .option("--ecr-login", "login to ecr")
    .option("--ecr-tag-push", "tag and push to ecr")
    .option("--ecr-ecs-push-new-revision", "tags image, pushes, and creates a new revision")
    .option("--ecr-ecs-set-revision", "sets revision for a task")
    .option("--ecs-list-revision", "lists all ecs revisions")
    .option("--scheduled-lambda-list-revision", "lists all lambda revisions")
    .option("--scheduled-lambda-set-revision", "sets revision for a scheduled lambda function")
    .option("--ecs-run-on-fargate", "run ecs task on fargate")
    .option("--ecs-task-logs", "read task logs")
    .option("--edge-lambda-kill-warm-instances", "kill warm edge lambda instances by doing a silent redeployment")
    .option("--lambda-kill-warm-instances", "kill warm lambda instances by doing a silent redeployment")
    .option("--lambda-update-publish-s3", "update and publish new lambda version from s3 object")
    .option("--lambda-update-publish-local", "update and publish new lambda version from local file")
    .option("--ecr-ecs-ephemeral-create", "creates an ephemeral ecr/ecs combination")
    .option("--ecr-ecs-ephemeral-destroy", "destroys an ephemeral ecr/ecs combination")
    .option("--ecr-ecs-ephemeral-list", "lists all ephemeral ecr/ecs combinations with their expiry")
    .option("--ecr-ecs-ephemeral-cleanup", "destroys all expired ephemeral ecr/ecs combinations")
    .option("--ecs-schedule-on-fargate", "schedule ecs task on fargate for a later time")
    .option("--ecs-list-scheduled", "lists all pending scheduled ecs tasks")
    .option("--ecs-delete-scheduled", "deletes a pending scheduled ecs task")
    .option("--api-gateway-lambda-deploy-sub", "deploy a sub lambda function with api gateway")
    .option("--api-gateway-deploy-lambda-proxy-sub-route", "adds a lambda proxy sub route based off default")
    .option("--api-gateway-add-lambda-permission", "add api gateway lambda permission")
    .option("--task-definition <task-definition>", "ecs task definition")
    .option("--task-arn <task-arn>", "ecs task arn")
    .option("--cluster-name <cluster-name>", "ecs cluster name")
    .option("--container-name <container-name>", "container name")
    .option("--image-name <image-name>", "image name")
    .option("--local-image-name <local-image-name>", "local image name")
    .option("--zip-file <file-name>", "file name")
    .option("--s3-bucket <s3-bucket>", "s3 bucket")
    .option("--s3-key <s3-key>", "s3 key")
    .option("--lambda-function <lambda-function>", "lambda function")
    .option("--lambda-function-version <lambda-function-version>", "lambda function version")
    .option("--lambda-edge-type <lambda-edge-type>", "lambda edge type")
    .option("--cloudfront-id <cloudfront-id>", "cloudfront id")
    .option("--cloudwatch-rule <cloudwatch-rule>", "cloudwatch rule")
    .option("--environment-variable <keyvalue...>", "overwrite environment variable key:value")
    .option("--execution-role-arn <execution-role-arn>", "execution-role-arn")
    .option("--task-role-arn <task-role-arn>", "task-role-arn")
    .option("--cpu-units <cpu-units>", "cpu-units", "256")
    .option("--remove-smallest-version", "remove smallest version")
    .option("--memory-units <memory-units>", "memory-units", "512")
    .option("--rest-api-id <rest-api-id>", "api gateway rest api id")
    .option("--stage-name <stage-name>", "api gateway stage-name", "production")
    .option("--api-gateway-base-path <base path>", "api gateway base path", "/{proxy+}")
    .option("--api-gateway-sub-path <sub path>", "api gateway sub path")
    .option("--ephemeral-id <ephemeral-id>", "ephemeral id")
    .option("--ttl-hours <ttl-hours>", "hours until an ephemeral expires", "72")
    .option("--dry-run", "only list what would be done")
    .option("--at <time>", "ISO time to run at, e.g. 2026-10-30T09:00 (local time) or 2026-10-30T08:00Z")
    .option("--scheduler-role-arn <scheduler-role-arn>", "role assumed by eventbridge scheduler to run the task")
    .option("--schedule-name <schedule-name>", "schedule name")
    .option("--schedule-group <schedule-group>", "schedule group", "default")
    .option("--revision-string <revision-string>", "revision-string");

// TODO: deploy lambda function directly without s3
// TODO: deploy lambda@edge function

const commands = function (o: OptionValues): Record<string, () => Promise<unknown>> {
    const need = function (name: string): string {
        if (!o[name])
            throw new Error(`Missing --${name.replace(/[A-Z]/g, c => "-" + c.toLowerCase())}.`);
        return o[name];
    };
    return {
        ecsCreateNewRevisionForContainer: () => ecsCreateNewRevisionForContainer(need("taskDefinition"), need("containerName"), need("imageName")),
        ecrLogin: () => ecrLogin(),
        ecrTagPush: () => ecrTagPush(need("localImageName"), need("imageName")),
        ecrEcsPushNewRevision: () => ecrEcsPushNewRevision(need("taskDefinition"), need("containerName"), need("localImageName"), need("imageName")),
        ecrEcsSetRevision: () => ecrEcsSetRevision(need("taskDefinition"), o.containerName, o.revisionString),
        ecsListRevision: () => ecsListRevision(),
        scheduledLambdaListRevision: () => scheduledLambdaListRevision(),
        scheduledLambdaSetRevision: () => scheduledLambdaSetRevision(need("cloudwatchRule"), o.revisionString),
        ecsRunOnFargate: () => ecsRunOnFargate(need("taskDefinition"), need("clusterName"), o.environmentVariable),
        ecsTaskLogs: () => ecsTaskLogs(need("taskArn"), need("clusterName")),
        edgeLambdaKillWarmInstances: () => edgeLambdaKillWarmInstances(need("lambdaFunction"), need("cloudfrontId"), need("lambdaEdgeType")),
        lambdaKillWarmInstances: () => lambdaKillWarmInstances(need("lambdaFunction")),
        lambdaUpdatePublishS3: () => lambdaUpdatePublishS3(need("lambdaFunction"), need("s3Bucket"), need("s3Key")),
        lambdaUpdatePublishLocal: () => lambdaUpdatePublishLocal(need("lambdaFunction"), need("zipFile")),
        ecrEcsEphemeralCreate: () => ecrEcsEphemeralCreate(o.executionRoleArn, o.taskRoleArn, o.cpuUnits, o.memoryUnits, o.ttlHours),
        ecrEcsEphemeralDestroy: () => ecrEcsEphemeralDestroy(need("ephemeralId")),
        ecrEcsEphemeralList: () => ecrEcsEphemeralList(),
        ecrEcsEphemeralCleanup: () => ecrEcsEphemeralCleanup(undefined, o.dryRun),
        ecsScheduleOnFargate: () => ecsScheduleOnFargate(need("taskDefinition"), need("clusterName"), o.environmentVariable, need("at"), need("schedulerRoleArn")),
        ecsListScheduled: () => ecsListScheduled(),
        ecsDeleteScheduled: () => ecsDeleteScheduled(need("scheduleName"), o.scheduleGroup),
        apiGatewayDeployLambdaProxySubRoute: () => apiGatewayDeployLambdaProxySubRoute(need("restApiId"), o.stageName, o.apiGatewayBasePath, need("apiGatewaySubPath"), o.lambdaFunction, o.lambdaFunctionVersion, o.removeSmallestVersion),
        apiGatewayAddLambdaPermission: () => apiGatewayAddLambdaPermission(need("restApiId"), need("apiGatewaySubPath"), need("lambdaFunction"), o.lambdaFunctionVersion),
        apiGatewayLambdaDeploySub: () => apiGatewayLambdaDeploySub(need("restApiId"), o.stageName, o.apiGatewayBasePath, need("apiGatewaySubPath"), need("lambdaFunction"), need("s3Bucket"), need("s3Key"), o.removeSmallestVersion)
    };
};

// SDK responses carry request metadata that is noise on the command line.
const withoutMetadata = function (result: unknown): unknown {
    if (result && typeof result === "object" && "$metadata" in result) {
        const {$metadata, ...rest} = result;
        return rest;
    }
    return result;
};

program.parse();
const options = program.opts();
configureAws({region: options.region, profile: options.profile});
const available = commands(options);
const selected = Object.keys(available).filter(name => options[name]);
if (selected.length !== 1) {
    console.error(selected.length === 0 ? "No command given, see awsass --help." : "Only one command at a time.");
    process.exit(1);
}
try {
    const result = await available[selected[0]!]!();
    console.dir(withoutMetadata(result), {depth: null, maxArrayLength: null});
    process.exit(0);
} catch (err) {
    console.error(err instanceof Error ? `${err.name}: ${err.message}` : err);
    process.exit(1);
}
