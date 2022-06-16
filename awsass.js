const { program } = require("commander");
const AWS = require("aws-sdk");
const Lib = require(__dirname + "/src/lib.js");

program
    .option("-p, --profile <profile>", "aws profile")
    .option("-r, --region <region>", "aws region")
    .option("--ecs-create-new-revision-for-container", "create a new ecs revision, updating a container")
    .option("--ecr-login", "login to ecr")
    .option("--ecr-tag-push", "tag and push to ecr")
    .option("--ecr-ecs-push-new-revision", "tags image, pushes, and creates a new revision")
    .option("--ecs-run-on-fargate", "run ecs task on fargate")
    .option("--ecs-task-logs", "read task logs")
    .option("--edge-lambda-kill-warm-instances", "kill warm edge lambda instances by doing a silent redeployment")
    .option("--lambda-kill-warm-instances", "kill warm lambda instances by doing a silent redeployment")
    .option("--lambda-update-publish-s3", "update and publish new lambda version from s3 object")
    .option("--ecr-ecs-ephemeral-create", "creates an ephemeral ecr/ecs combination")
    .option("--ecr-ecs-ephemeral-destroy", "destroys an ephemeral ecr/ecs combination")
    .option("--api-gateway-lambda-deploy-sub", "deploy a sub lambda function with api gateway")
    .option("--api-gateway-deploy-lambda-proxy-sub-route", "adds a lambda proxy sub route based off default")
    .option("--api-gateway-add-lambda-permission", "add api gateway lambda permission")
    .option("--task-definition <task-definition>", "ecs task definition")
    .option("--task-arn <task-arn>", "ecs task arn")
    .option("--cluster-name <cluster-name>", "ecs cluster name")
    .option("--container-name <container-name>", "container name")
    .option("--image-name <image-name>", "image name")
    .option("--local-image-name <local-image-name>", "local image name")
    .option("--s3-bucket <s3-bucket>", "s3 bucket")
    .option("--s3-key <s3-key>", "s3 key")
    .option("--lambda-function <lambda-function>", "lambda function")
    .option("--lambda-function-version <lambda-function-version>", "lambda function version")
    .option("--lambda-edge-type <lambda-edge-type>", "lambda edge type")
    .option("--cloudfront-id <cloudfront-id>", "cloudfront id")
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
    .option("--ephemeral-id <ephemeral-id>", "ephemeral id");

// TODO: deploy lambda function directly without s3
// TODO: deploy lambda@edge function

program.parse(process.argv);
const options = program.opts();

if (options.region)
    AWS.config.update({region: options.region});

if (options.profile)
    AWS.config.update({credentials: new AWS.SharedIniFileCredentials({profile: options.profile})});

const resultFunc = function (err, data) {
    console.log(err ? err : data);
    process.exit(err ? 1 : 0);
};

if (options["ecsCreateNewRevisionForContainer"])
    Lib.ecsCreateNewRevisionForContainer(options["taskDefinition"], options["containerName"], options["imageName"], resultFunc);

if (options["ecrLogin"])
    Lib.ecrLogin(resultFunc);

if (options["ecrTagPush"])
    Lib.ecrTagPush(options["localImageName"], options["imageName"], resultFunc);

if (options["ecrEcsPushNewRevision"])
    Lib.ecrEcsPushNewRevision(options["taskDefinition"], options["containerName"], options["localImageName"], options["imageName"], resultFunc);

if (options["ecsRunOnFargate"])
    Lib.ecsRunOnFargate(options["taskDefinition"], options["clusterName"], options["environmentVariable"], resultFunc);

if (options["ecsTaskLogs"])
    Lib.ecsTaskLogs(options["taskArn"], options["clusterName"], resultFunc);

if (options["edgeLambdaKillWarmInstances"])
    Lib.edgeLambdaKillWarmInstances(options["lambdaFunction"], options["cloudfrontId"], options["lambdaEdgeType"], resultFunc);

if (options["lambdaKillWarmInstances"])
    Lib.lambdaKillWarmInstances(options["lambdaFunction"], resultFunc);

if (options["lambdaUpdatePublishS3"])
    Lib.lambdaUpdatePublishS3(options["lambdaFunction"], options["s3Bucket"], options["s3Key"], resultFunc);

if (options["ecrEcsEphemeralCreate"])
    Lib.ecrEcsEphemeralCreate(options["executionRoleArn"], options["taskRoleArn"], options["cpuUnits"], options["memoryUnits"], resultFunc);

if (options["ecrEcsEphemeralDestroy"])
    Lib.ecrEcsEphemeralDestroy(options["ephemeralId"], resultFunc);

if (options["apiGatewayDeployLambdaProxySubRoute"])
    Lib.apiGatewayDeployLambdaProxySubRoute(options["restApiId"], options["stageName"], options["apiGatewayBasePath"], options["apiGatewaySubPath"], options["lambdaFunction"], options["lambdaFunctionVersion"], options["removeSmallestVersion"], resultFunc);

if (options["apiGatewayAddLambdaPermission"])
    Lib.apiGatewayAddLambdaPermission(options["restApiId"], options["apiGatewaySubPath"], options["lambdaFunction"], options["lambdaFunctionVersion"], resultFunc);

if (options["apiGatewayLambdaDeploySub"])
    Lib.apiGatewayLambdaDeploySub(options["restApiId"], options["stageName"], options["apiGatewayBasePath"], options["apiGatewaySubPath"], options["lambdaFunction"], options["s3Bucket"], options["s3Key"], options["removeSmallestVersion"], resultFunc);