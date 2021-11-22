const GetOpt = require("node-getopt");
const AWS = require("aws-sdk");
const Lib = require(__dirname + "/src/lib.js");

const parsedArgs = GetOpt.create([
    ["h", "help", "shows help"],
    ["p", "profile=PROFILE", "aws profile"],
    ["r", "region=REGION", "aws region"],
    ["", "ecs-create-new-revision-for-container", "create a new ecs revision, updating a container"],
    ["", "ecr-login", "login to ecr"],
    ["", "ecr-tag-push", "tag and push to ecr"],
    ["", "ecr-ecs-push-new-revision", "tags image, pushes, and creates a new revision"],
    ["", "lambda-kill-warm-instances", "kill warm lambda instances by doing a silent redeployment"],
    ["", "task-definition=TASKDEFINITION", "ecs task definition"],
    ["", "container-name=CONTAINERNAME", "container name"],
    ["", "image-name=IMAGENAME", "image name"],
    ["", "local-image-name=IMAGENAME", "local-image name"],
    ["", "lambda-function=LAMBDAFUNCTION", "lambda function name"]
]).bindHelp().parseSystem();

if (parsedArgs.options.region)
    AWS.config.update({region: parsedArgs.options.region});

if (parsedArgs.options.profile)
    AWS.config.update({credentials: new AWS.SharedIniFileCredentials({profile: parsedArgs.options.profile})});

const resultFunc = function (err, data) {
    console.log(err ? err : data);
    process.exit(err ? 1 : 0);
};

if (parsedArgs.options["ecs-create-new-revision-for-container"])
    Lib.ecsCreateNewRevisionForContainer(parsedArgs.options["task-definition"], parsedArgs.options["container-name"], parsedArgs.options["image-name"], resultFunc);

if (parsedArgs.options["ecr-login"])
    Lib.ecrLogin(resultFunc);

if (parsedArgs.options["ecr-tag-push"])
    Lib.ecrTagPush(parsedArgs.options["local-image-name"], parsedArgs.options["image-name"], resultFunc);

if (parsedArgs.options["ecr-ecs-push-new-revision"])
    Lib.ecrEcsPushNewRevision(parsedArgs.options["task-definition"], parsedArgs.options["container-name"], parsedArgs.options["local-image-name"], parsedArgs.options["image-name"], resultFunc);

// TODO: lambda version based routing
// TODO: run on fargate
// TODO: lambda flush cache