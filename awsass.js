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
//    .option("--ecr-ecs-ephemeral-create", "creates an ephemeral ecr/ecs combination")
//    .option("--ecr-ecs-ephemeral-destroy", "destroys an ephemeral ecr/ecs combination")
//    .option("--version-based-lambda-deploy", "deploy a version-based lambda function")
    .option("--task-definition <task-definition>", "ecs task definition")
    .option("--task-arn <task-arn>", "ecs task arn")
    .option("--cluster-name <cluster-name>", "ecs cluster name")
    .option("--container-name <container-name>", "container name")
    .option("--image-name <image-name>", "image name")
    .option("--local-image-name <local-image-name>", "local image name")
    .option("--lambda-function <lambda-function>", "lambda function")
    .option("--lambda-edge-type <lambda-edge-type>", "lambda edge type")
    .option("--cloudfront-id <cloudfront-id>", "cloudfront id")
    .option("--environment-variable <keyvalue...>", "overwrite environment variable key:value")

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
