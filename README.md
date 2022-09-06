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
  awsass --ecr-ecs-ephemeral-destory --profile XXX --region XXX \
         --ephemeral-id XXX
```



## License

Apache-2.0

