# awsass

AWSASS is an assistant to AWS, mostly for running better scripts.


## Installation


```bash
	npm install awsass -g
```


## Ephemeral execution on AWS

```bash
  awsass --ecr-ecs-ephemeral-create --profile XXX --region XXX \
         --execution-role-arn XXX --task-role-arn XXX
```

```bash
{
  ephemeralId: 'XXX',
  repositoryUri: 'YYY',
  taskDefinitionArn: 'ZZZ'
}
```

```bash
  awsass --ecr-ecs-push-new-revision --profile XXX --region XXX \
         --container-name YYY --task-definition ZZZ \
         --local-image-name XXX --image-name ZZZ:latest
```

```bash
  awsass --ecs-run-on-fargate --profile XXX --region XXX \
         --task-definition ZZZ --cluster-name AAA
```

```bash
  awsass --ecr-ecs-ephemeral-destroy --profile XXX --region XXX \
         --ephemeral-id XXX
```

### Expiration

Ephemerals expire after `--ttl-hours` (default 72) passed on creation. Expired ephemerals are destroyed
by the cleanup command (e.g. from a nightly CI job) and every ephemeral create also destroys the
creating user's own expired ephemerals.

```bash
  awsass --ecr-ecs-ephemeral-list --profile XXX --region XXX
  awsass --ecr-ecs-ephemeral-cleanup --profile XXX --region XXX [--dry-run]
```

### Scheduling for later

Requires a role that EventBridge Scheduler can assume, allowed to `ecs:RunTask` and to `iam:PassRole` the task's
execution and task role. Schedules delete themselves after running, and destroying an ephemeral removes its pending schedules.
Times without offset are local time.

```bash
  awsass --ecs-schedule-on-fargate --profile XXX --region XXX \
         --task-definition ZZZ --cluster-name AAA \
         --at 2026-10-30T09:00 --scheduler-role-arn XXX

  awsass --ecs-list-scheduled --profile XXX --region XXX

  awsass --ecs-delete-scheduled --profile XXX --region XXX \
         --schedule-name XXX --schedule-group XXX
```



## License

Apache-2.0

