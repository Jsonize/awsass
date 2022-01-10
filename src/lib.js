const AWS = require("aws-sdk");
const Docker = require(__dirname + "/docker.js");
const OS = require("os");

const nameValueArrayToObject = function (arr) {
    let result = {};
    arr.forEach(nv => result[nv.name] = nv.value);
    return result;
};

const objectToNameValueArray = function (obj) {
    let result = [];
    for (let key in obj)
        result.push({name: key, value: obj[key]});
    return result;
};

const Module = {

    ecsCreateNewRevisionForContainer: function (taskDefinition, containerName, imageName, callback) {
        const ecs = new AWS.ECS({apiVersion: '2014-11-13'});
        ecs.describeTaskDefinition({taskDefinition: taskDefinition}, function (err, describeTaskDefinition) {
            if (err) {
                callback(err);
                return;
            }
            const containerDefinitions = describeTaskDefinition.taskDefinition.containerDefinitions;
            const containerDefinition = containerDefinitions.find(containerDefinition => containerDefinition.name === containerName);
            if (!containerDefinition) {
                callback(`Could not find container definition ${containerName}.`);
                return;
            }
            containerDefinition.image = imageName;
            if (!imageName) {
                callback(`Empty image name ${imageName}.`);
                return;
            }
            delete describeTaskDefinition.taskDefinition.taskDefinitionArn;
            delete describeTaskDefinition.taskDefinition.revision;
            delete describeTaskDefinition.taskDefinition.status;
            delete describeTaskDefinition.taskDefinition.requiresAttributes;
            delete describeTaskDefinition.taskDefinition.compatibilities;
            delete describeTaskDefinition.taskDefinition.registeredAt;
            delete describeTaskDefinition.taskDefinition.registeredBy;
            ecs.registerTaskDefinition(describeTaskDefinition.taskDefinition, function (err, registerTaskDefinition) {
                callback(err, registerTaskDefinition);
            });
        });
    },

    ecrLoginDetails: function (callback) {
        const ecr = new AWS.ECR({apiVersion: '2015-09-21'});
        ecr.getAuthorizationToken({}, function (err, getAuthorizationToken) {
            if (err) {
                callback(err);
                return;
            }
            const endpoint = getAuthorizationToken.authorizationData[0].proxyEndpoint;
            const base64UserPwd = getAuthorizationToken.authorizationData[0].authorizationToken;
            const userPwd = Buffer.from(base64UserPwd, 'base64').toString('ascii').split(":");
            callback(undefined, {
                username: userPwd[0],
                password: userPwd[1],
                endpoint: endpoint
            });
        });
    },

    ecrLogin: function (callback) {
        Module.ecrLoginDetails(function (err, ecrLoginDetails) {
            if (err) {
                callback(err);
                return;
            }
            Docker.login(ecrLoginDetails.username, ecrLoginDetails.password, ecrLoginDetails.endpoint, function (err, docker) {
                callback(err, docker);
            });
        });
    },

    ecrTagPush: function (localImageName, imageName, callback) {
        Module.ecrLogin(function (err) {
            if (err) {
                callback(err);
                return;
            }
            Docker.tag(localImageName, imageName, function (err) {
                if (err) {
                    callback(err);
                    return;
                }
                Docker.push(imageName, function (err, push) {
                    callback(err, push);
                });
            });
        })
    },

    ecrEcsPushNewRevision: function (taskDefinition, containerName, localImageName, imageName, callback) {
        Module.ecrTagPush(localImageName, imageName, function (err) {
            if (err) {
                callback(err);
                return;
            }
            Module.ecsCreateNewRevisionForContainer(taskDefinition, containerName, imageName, function (err, ecsCreateNewRevisionForContainer) {
                callback(err, ecsCreateNewRevisionForContainer);
            });
        });
    },

    ec2GetSubnets: function (callback) {
        const ec2 = new AWS.EC2({apiVersion: '2016-11-15'});
        ec2.describeSubnets({}, function (err, subnetsDescription) {
            if (err) {
                callback(err);
                return;
            }
            callback(undefined, subnetsDescription.Subnets.map(subnet => subnet.SubnetId));
        });
    },

    ecsRunOnFargate: function (taskDefinition, clusterName, environmentVariables, callback) {
        const ecs = new AWS.ECS({apiVersion: '2014-11-13'});
        ecs.describeTaskDefinition({taskDefinition: taskDefinition}, function (err, describeTaskDefinition) {
            if (err) {
                callback(err);
                return;
            }
            const containerOverrides = environmentVariables ? describeTaskDefinition.taskDefinition.containerDefinitions.map(containerDef => {
                let env = nameValueArrayToObject(containerDef.environment);
                environmentVariables.forEach(kv => {
                    const splt = kv.split(":");
                    env[splt.shift()] = splt.join(":");
                });
                env = objectToNameValueArray(env);
                return {
                    name: containerDef.name,
                    environment: env
                };
            }) : undefined;
            Module.ec2GetSubnets(function (err, subnets) {
                if (err) {
                    callback(err);
                    return;
                }
                ecs.runTask({
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
                }, callback);
            });
        });
    },

    ecsTaskLogs: function (taskArn, clusterName, callback) {
        const ecs = new AWS.ECS({apiVersion: '2014-11-13'});
        const cloudwatchlogs = new AWS.CloudWatchLogs({apiVersion: '2014-03-28'});
        ecs.describeTasks({
            tasks: [taskArn],
            cluster: clusterName
        }, function (err, describeTasksData) {
            if (err) {
                callback(err);
                return;
            }
            ecs.describeTaskDefinition({
                taskDefinition: describeTasksData.tasks[0].taskDefinitionArn
            }, function (err, describeTaskDef) {
                if (err) {
                    callback(err);
                    return;
                }
                const logGroup = describeTaskDef.taskDefinition.containerDefinitions[0].logConfiguration.options['awslogs-group'];
                const logStreamId = taskArn.split("/").pop();
                cloudwatchlogs.getLogEvents({
                    logGroupName: logGroup,
                    logStreamName: logGroup.substring(1) + "/" + logStreamId,
                    limit: 100
                }, function(err, data) {
                    if (err) {
                        callback(err);
                        return;
                    }
                    callback(undefined, data.events.map(event => event.message));
                });
            });
        });
    },

    edgeLambdaKillWarmInstances: function (lambdaFunction, cloudfrontId, lambdaEdgeType, callback) {
        const lambda = new AWS.Lambda({apiVersion: '2015-03-31'});
        const cloudfront = new AWS.CloudFront({apiVersion: '2020-05-31'});
        lambda.updateFunctionConfiguration({
            FunctionName: lambdaFunction,
            Description: "AWSASS:" + (new Date()).getTime()
        }, function (err) {
            if (err) {
                callback(err);
                return;
            }
            setTimeout(function () {
                lambda.publishVersion({
                    FunctionName: lambdaFunction
                }, function (err, publishResult) {
                    if (err) {
                        callback(err);
                        return;
                    }
                    cloudfront.getDistributionConfig({
                        Id: cloudfrontId
                    }, function (err, distributionConfig) {
                        if (err) {
                            callback(err);
                            return;
                        }
                        const lambdaItems = distributionConfig.DistributionConfig.DefaultCacheBehavior.LambdaFunctionAssociations.Items;
                        let lambdaItem = null;
                        lambdaItems.forEach(function (candidate) {
                            if (candidate.EventType === lambdaEdgeType)
                                lambdaItem = candidate;
                        });
                        let s = lambdaItem.LambdaFunctionARN.split(":");
                        s[s.length - 1] = publishResult.Version;
                        lambdaItem.LambdaFunctionARN = s.join(":");
                        cloudfront.updateDistribution({
                            Id: cloudfrontId,
                            IfMatch: distributionConfig.ETag,
                            DistributionConfig: distributionConfig.DistributionConfig
                        }, callback);
                    });
                });
            }, 5000);
        });
    },

    lambdaKillWarmInstances: function (lambdaFunction, callback) {
        const lambda = new AWS.Lambda({apiVersion: '2015-03-31'});
        lambda.getFunctionConfiguration({
            FunctionName: lambdaFunction,
        }, function (err, functionConfiguration) {
            if (err) {
                callback(err);
                return;
            }
            functionConfiguration.Environment.Variables.AWSASS = "" + (new Date()).getTime();
            lambda.updateFunctionConfiguration({
                FunctionName: lambdaFunction,
                Environment: functionConfiguration.Environment
            }, function (err) {
                if (err) {
                    callback(err);
                    return;
                }
                setTimeout(function () {
                    lambda.publishVersion({
                        FunctionName: lambdaFunction
                    }, callback);
                }, 5000);
            });
        });
    },

    ecrEcsEphemeralCreate: function (executionRoleArn, taskRoleArn, cpuUnits, memoryUnits, callback) {
        const ecr = new AWS.ECR({apiVersion: '2015-09-21'});
        const ecs = new AWS.ECS({apiVersion: '2014-11-13'});
        const cloudwatchlogs = new AWS.CloudWatchLogs({apiVersion: '2014-03-28'});
        const ephemeralId = "awsass-ephemeral-" + OS.userInfo().username + "-" + (new Date()).getTime();
        ecr.createRepository({
            repositoryName: ephemeralId
        }, function (err, createRepoResult) {
            if (err) {
                callback(err);
                return;
            }
            ecs.registerTaskDefinition({
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
                    memoryReservation: memoryUnits,
                    cpu: cpuUnits,
                    image: createRepoResult.repository.repositoryUri,
                    logConfiguration: {
                        logDriver: "awslogs",
                        options: {
                            "awslogs-group": "/ecs/" + ephemeralId,
                            "awslogs-region": AWS.config.region,
                            "awslogs-stream-prefix": "ecs"
                        }
                    }
                }]
            }, function (err, registerTaskDef) {
                if (err) {
                    callback(err);
                    return;
                }
                cloudwatchlogs.createLogGroup({
                    logGroupName: "/ecs/" + ephemeralId,
                }, function (err, logGroupResult) {
                    if (err) {
                        callback(err);
                        return;
                    }
                    callback(undefined, {
                        ephemeralId: ephemeralId,
                        repositoryUri: createRepoResult.repository.repositoryUri,
                        taskDefinitionArn: registerTaskDef.taskDefinition.taskDefinitionArn
                    });
                });
            });
        });
    },

    ecrEcsEphemeralDestroy: function (ephemeralId, callback) {
        const ecr = new AWS.ECR({apiVersion: '2015-09-21'});
        const ecs = new AWS.ECS({apiVersion: '2014-11-13'});
        const cloudwatchlogs = new AWS.CloudWatchLogs({apiVersion: '2014-03-28'});
        cloudwatchlogs.deleteLogGroup({
            logGroupName: "/ecs/" + ephemeralId
        }, function (err, logGroupResult) {
            if (err) {
                callback(err);
                return;
            }
            ecs.deregisterTaskDefinition({
                taskDefinition: ephemeralId + ":1"
            }, function (err, deregisterTaskDef) {
                if (err) {
                    callback(err);
                    return;
                }
                ecr.deleteRepository({
                    repositoryName: ephemeralId,
                    force: true
                }, function (err, deleteRepoResult) {
                    if (err) {
                        callback(err);
                        return;
                    }
                    callback(undefined, {
                        ephemeralId: ephemeralId,
                        repositoryUri: deleteRepoResult.repository.repositoryUri,
                        taskDefinitionArn: deregisterTaskDef.taskDefinition.taskDefinitionArn
                    });
                });
            });
        });
    }

};

module.exports = Module;