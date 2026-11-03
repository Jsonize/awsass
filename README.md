# awsass

AWSASS is an assistant to AWS, mostly for running better scripts.

It wraps common multi-step AWS chores (pushing Docker images and rolling ECS task definitions,
running one-off Fargate tasks, publishing Lambda versions, wiring API Gateway routes) into single commands.


## Installation

```bash
npm install awsass -g
```

Requirements:
- Node.js
- AWS credentials, e.g. a profile in `~/.aws/credentials` or `~/.aws/config`
- Docker, for the commands that push images (`--ecr-login`, `--ecr-tag-push`, `--ecr-ecs-push-new-revision`)


## Usage

```bash
awsass --<command> [--profile <profile>] [--region <region>] [options]
```

| Option | Description |
|---|---|
| `-p, --profile <profile>` | AWS profile to use. Defaults to the usual AWS credential chain. |
| `-r, --region <region>` | AWS region to use. |

Each invocation runs one command. The result is printed as a JavaScript object and the
exit code is `0` on success and `1` on error, so commands can be chained in scripts.

Run `awsass --help` for the full list of options.


## Contents

- [Ephemeral execution](#ephemeral-execution)
  - [Quick start](#quick-start)
  - [Expiration](#expiration)
  - [Scheduling for later](#scheduling-for-later)
  - [Roles](#roles)
- [ECR and ECS](#ecr-and-ecs)
- [Lambda](#lambda)
- [Scheduled Lambda](#scheduled-lambda)
- [API Gateway](#api-gateway)


## Ephemeral execution

An ephemeral is a throwaway ECR repository, ECS Fargate task definition and CloudWatch log group,
all named `awsass-ephemeral-<username>-<timestamp>`. Use it to run a Docker image on Fargate once
(or a few times) without setting up any infrastructure.

### Quick start

**1. Create the ephemeral.**

```bash
awsass --ecr-ecs-ephemeral-create --profile XXX --region XXX \
       --execution-role-arn XXX --task-role-arn XXX \
       [--cpu-units 256] [--memory-units 512] [--ttl-hours 72]
```

```js
{
  ephemeralId: 'awsass-ephemeral-alice-1793194414253',
  repositoryUri: '123456789012.dkr.ecr.eu-central-1.amazonaws.com/awsass-ephemeral-alice-1793194414253',
  taskDefinitionArn: 'arn:aws:ecs:eu-central-1:123456789012:task-definition/awsass-ephemeral-alice-1793194414253:1',
  expiresAt: '2026-11-06T10:00:00.000Z',
  cleanedUp: []
}
```

| Option | Description |
|---|---|
| `--execution-role-arn` | Role ECS uses to pull the image and write logs. Required in practice, see [Roles](#roles). |
| `--task-role-arn` | Role your code runs as inside the container. |
| `--cpu-units` | Fargate CPU units, default `256`. |
| `--memory-units` | Fargate memory in MB, default `512`. |
| `--ttl-hours` | Hours until the ephemeral expires, default `72`. See [Expiration](#expiration). |

**2. Push your local image.** This logs in to ECR, tags and pushes the image, and registers a new
task definition revision that uses it. Container name and task definition are both the ephemeral id.

```bash
awsass --ecr-ecs-push-new-revision --profile XXX --region XXX \
       --task-definition <ephemeralId> --container-name <ephemeralId> \
       --local-image-name my-image:latest --image-name <repositoryUri>:latest
```

**3. Run it on Fargate.** Note the task ARN in the output.

```bash
awsass --ecs-run-on-fargate --profile XXX --region XXX \
       --task-definition <ephemeralId> --cluster-name <cluster> \
       [--environment-variable KEY:VALUE ...]
```

**4. Read the logs.**

```bash
awsass --ecs-task-logs --profile XXX --region XXX \
       --task-arn <taskArn> --cluster-name <cluster>
```

**5. Destroy the ephemeral.** This deregisters all task definition revisions, deletes the repository
including its images, deletes the log group and removes any pending scheduled runs.

```bash
awsass --ecr-ecs-ephemeral-destroy --profile XXX --region XXX \
       --ephemeral-id <ephemeralId>
```

### Expiration

Every ephemeral expires `--ttl-hours` after creation (default 72). The expiry time is stored as the
tag `awsass:expires-at` on the ECR repository. Ephemerals created before expiration existed have no
tag; for them the expiry is the creation time in the id plus 72 hours.

Expired ephemerals are destroyed:
- automatically whenever you create a new ephemeral (only your own expired ones), and
- by the cleanup command, which covers all users and is meant for e.g. a nightly CI job.

```bash
# list all ephemerals with creation time, expiry and whether they have expired
awsass --ecr-ecs-ephemeral-list --profile XXX --region XXX

# destroy all expired ephemerals; --dry-run only lists what would be destroyed
awsass --ecr-ecs-ephemeral-cleanup --profile XXX --region XXX [--dry-run]
```

The cleanup output lists `destroyed` and `failed` ephemerals. One failure does not stop the others.

### Scheduling for later

Runs a task on Fargate at a later time using a one-time
[EventBridge Scheduler](https://docs.aws.amazon.com/scheduler/latest/UserGuide/what-is-scheduler.html) schedule.
Works for ephemeral and regular task definitions.

```bash
awsass --ecs-schedule-on-fargate --profile XXX --region XXX \
       --task-definition <taskDefinition> --cluster-name <cluster> \
       --at 2026-10-30T09:00 --scheduler-role-arn XXX \
       [--environment-variable KEY:VALUE ...]
```

| Option | Description |
|---|---|
| `--at` | ISO time to run at. Without an offset it is your local time (`2026-10-30T09:00`); add `Z` or an offset to be explicit (`2026-10-30T08:00Z`). |
| `--scheduler-role-arn` | Role EventBridge Scheduler assumes to start the task, see [Roles](#roles). |

How it behaves:
- The task is started with exactly the same parameters `--ecs-run-on-fargate` would use.
- If you pass a task definition family without a revision, the latest revision at run time is used.
- The schedule deletes itself after running. If starting the task fails, it is retried up to 3 times within an hour.
- For ephemerals the run must be before the expiry, otherwise the command fails. It warns if
  the repository has no image yet.
- An ephemeral's schedules are kept in a schedule group named after the ephemeral id; destroying
  the ephemeral removes them. Other schedules go into the `default` group.

```bash
# list pending scheduled runs
awsass --ecs-list-scheduled --profile XXX --region XXX

# cancel a scheduled run
awsass --ecs-delete-scheduled --profile XXX --region XXX \
       --schedule-name <scheduleName> [--schedule-group <scheduleGroup>]
```

`--schedule-group` defaults to `default`. Both values are shown by `--ecs-list-scheduled` and
`--ecs-schedule-on-fargate`.

### Roles

A running task never uses your own credentials. Your profile is only used for the API calls
awsass makes. These roles are involved:

| Role | Used by | Needs |
|---|---|---|
| Execution role (`--execution-role-arn`) | ECS, to start the container | Pull from ECR and write to CloudWatch Logs, e.g. the managed policy `AmazonECSTaskExecutionRolePolicy`. Trusts `ecs-tasks.amazonaws.com`. |
| Task role (`--task-role-arn`) | Your code inside the container | Whatever your job does. Trusts `ecs-tasks.amazonaws.com`. |
| Scheduler role (`--scheduler-role-arn`) | EventBridge Scheduler, only for scheduled runs | `ecs:RunTask`, plus `iam:PassRole` for the execution and task role. Trusts `scheduler.amazonaws.com`. |

Both roles are fixed when the ephemeral is created and carried over to every new revision. To change
them, destroy the ephemeral and create a new one.

Your own credentials need `iam:PassRole` for the execution and task role to run tasks, plus
`ecr:TagResource` and `ecr:ListTagsForResource` for ephemeral expiration.

Example policy for the scheduler role:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": "ecs:RunTask", "Resource": "*" },
    { "Effect": "Allow", "Action": "iam:PassRole", "Resource": ["<execution-role-arn>", "<task-role-arn>"] }
  ]
}
```


## ECR and ECS

### `--ecr-login`

Logs Docker in to the account's ECR registry.

```bash
awsass --ecr-login --profile XXX --region XXX
```

### `--ecr-tag-push`

Logs in to ECR, tags a local image and pushes it.

```bash
awsass --ecr-tag-push --profile XXX --region XXX \
       --local-image-name my-image:latest --image-name <repositoryUri>:<tag>
```

### `--ecs-create-new-revision-for-container`

Registers a new task definition revision in which one container uses a different image.

```bash
awsass --ecs-create-new-revision-for-container --profile XXX --region XXX \
       --task-definition <taskDefinition> --container-name <container> \
       --image-name <repositoryUri>:<tag>
```

### `--ecr-ecs-push-new-revision`

Combines `--ecr-tag-push` and `--ecs-create-new-revision-for-container`: pushes a local image and
registers a new task definition revision that uses it.

```bash
awsass --ecr-ecs-push-new-revision --profile XXX --region XXX \
       --task-definition <taskDefinition> --container-name <container> \
       --local-image-name my-image:latest --image-name <repositoryUri>:<tag>
```

### `--ecr-ecs-set-revision`

Registers a new task definition revision that points a container at another image already in its
ECR repository. Useful for rollbacks.

```bash
awsass --ecr-ecs-set-revision --profile XXX --region XXX \
       --task-definition <taskDefinition> [--container-name <container>] \
       [--revision-string <revision>]
```

| Option | Description |
|---|---|
| `--container-name` | Container to change; defaults to the first container. |
| `--revision-string` | `latest` (default): most recently pushed image. `first`: oldest image. A number such as `-1` or `2`: move that many images back or forward in push order from the current one. Anything else: an image tag or digest. |

### `--ecs-list-revision`

Lists the image used by the latest revision of every task definition family.

```bash
awsass --ecs-list-revision --profile XXX --region XXX
```

### `--ecs-run-on-fargate`

Runs a task on Fargate in the account's default subnets (or all subnets if there are no default
ones) with a public IP.

```bash
awsass --ecs-run-on-fargate --profile XXX --region XXX \
       --task-definition <taskDefinition> --cluster-name <cluster> \
       [--environment-variable KEY:VALUE ...]
```

`--environment-variable` sets or overrides environment variables in all containers. Values may
contain colons; only the first colon separates key and value.

### `--ecs-task-logs`

Prints the last 100 log lines of a task. Expects the `awslogs` setup that ephemerals use
(log group `/ecs/<container>`, stream prefix `ecs`).

```bash
awsass --ecs-task-logs --profile XXX --region XXX \
       --task-arn <taskArn> --cluster-name <cluster>
```


## Lambda

### `--lambda-update-publish-s3`

Updates a function's code from a zip file in S3 and publishes a new version.

```bash
awsass --lambda-update-publish-s3 --profile XXX --region XXX \
       --lambda-function <function> --s3-bucket <bucket> --s3-key <key>
```

### `--lambda-update-publish-local`

Updates a function's code from a local zip file and publishes a new version.

```bash
awsass --lambda-update-publish-local --profile XXX --region XXX \
       --lambda-function <function> --zip-file function.zip
```

### `--lambda-kill-warm-instances`

Forces all warm instances of a function to be replaced by changing a dummy environment variable
(`AWSASS`) and publishing a new version.

```bash
awsass --lambda-kill-warm-instances --profile XXX --region XXX \
       --lambda-function <function>
```

### `--edge-lambda-kill-warm-instances`

The same for Lambda@Edge: publishes a new version and points the CloudFront distribution's default
cache behavior at it.

```bash
awsass --edge-lambda-kill-warm-instances --profile XXX --region XXX \
       --lambda-function <function> --cloudfront-id <distributionId> \
       --lambda-edge-type viewer-request
```

`--lambda-edge-type` is the CloudFront event type: `viewer-request`, `viewer-response`,
`origin-request` or `origin-response`.


## Scheduled Lambda

For Lambda functions triggered by CloudWatch Events / EventBridge rules.

### `--scheduled-lambda-list-revision`

Lists the Lambda target of every rule, including the version it is pinned to.

```bash
awsass --scheduled-lambda-list-revision --profile XXX --region XXX
```

### `--scheduled-lambda-set-revision`

Points a rule's Lambda target at another version of the function.

```bash
awsass --scheduled-lambda-set-revision --profile XXX --region XXX \
       --cloudwatch-rule <rule> --revision-string <revision>
```

`--revision-string` is `latest`, `first`, a version number, or `+N` / `-N` relative to the
current version.


## API Gateway

These commands manage REST APIs whose routes are Lambda proxy integrations, deploying each new Lambda
version as its own sub route next to a base route.

| Option | Description |
|---|---|
| `--rest-api-id` | ID of the REST API. |
| `--stage-name` | Stage to deploy, default `production`. |
| `--api-gateway-base-path` | Route whose integration is copied, default `/{proxy+}`. |
| `--api-gateway-sub-path` | Route to create, e.g. `/v42/{proxy+}`. |

### `--api-gateway-lambda-deploy-sub`

Full deployment in one step: updates the function from S3 and publishes a new version, allows
API Gateway to invoke it, and adds a sub route for that version.

```bash
awsass --api-gateway-lambda-deploy-sub --profile XXX --region XXX \
       --rest-api-id <apiId> --lambda-function <function> \
       --s3-bucket <bucket> --s3-key <key> \
       --api-gateway-sub-path /v42/{proxy+} [--stage-name production] \
       [--api-gateway-base-path /{proxy+}] [--remove-smallest-version]
```

### `--api-gateway-deploy-lambda-proxy-sub-route`

Copies the base route's integration to the sub route, optionally pointing it at another function
or version, and deploys the stage.

```bash
awsass --api-gateway-deploy-lambda-proxy-sub-route --profile XXX --region XXX \
       --rest-api-id <apiId> --api-gateway-sub-path /v42/{proxy+} \
       [--lambda-function <function>] [--lambda-function-version 42] \
       [--stage-name production] [--api-gateway-base-path /{proxy+}] \
       [--remove-smallest-version]
```

`--remove-smallest-version` also deletes the route that points at the oldest version of the same
function, so old versions don't pile up.

### `--api-gateway-add-lambda-permission`

Allows API Gateway to invoke a function (version) for a route.

```bash
awsass --api-gateway-add-lambda-permission --profile XXX --region XXX \
       --rest-api-id <apiId> --api-gateway-sub-path /v42/* \
       --lambda-function <function> [--lambda-function-version 42]
```


## License

Apache-2.0
