const AWS = require("aws-sdk");
const Docker = require(__dirname + "/docker.js");
const OS = require("os");
const FS = require("fs");

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

    ecrEcsSetRevision: function (taskDefinition, containerName, revisionString, callback) {
        let findImageIndex = function (images, searchString) {
            return images.findIndex(function (image) {
                return image.imageDigest === searchString || image.imageTags && image.imageTags.includes(searchString)
            });
        };
        const ecs = new AWS.ECS({apiVersion: '2014-11-13'});
        const ecr = new AWS.ECR({apiVersion: '2015-09-21'});
        ecs.describeTaskDefinition({taskDefinition: taskDefinition}, function (err, describeTaskDefinition) {
            if (err) {
                callback(err);
                return;
            }
            const containerDefinitions = describeTaskDefinition.taskDefinition.containerDefinitions;
            let containerDefinition = containerName ? containerDefinitions.find(containerDefinition => containerDefinition.name === containerName) : containerDefinitions[0];
            if (!containerDefinition) {
                callback(`Could not find container definition.`);
                return;
            }
            containerName = containerName || containerDefinition.name;
            let splt = containerDefinition.image.split(containerDefinition.image.indexOf("@") < 0 ? ":" : "@");
            const imageName = splt[0];
            const imageRevision = splt[1];
            splt = imageName.split("/");
            const repositoryBase = splt[0];
            const repositoryName = splt[1];
            ecr.describeImages({repositoryName: repositoryName}, function (err, describeImages) {
                if (err) {
                    callback(err);
                    return;
                }
                const images = describeImages.imageDetails.sort(function (x, y) {
                    return x.imagePushedAt > y.imagePushedAt ? 1 : (x.imagePushedAt < y.imagePushedAt ? -1 : 0);
                });
                const oldImageIndex = findImageIndex(images, imageRevision);
                if (oldImageIndex < 0) {
                    callback(`Could not find current image.`);
                    return;
                }                
                revisionString = revisionString || "latest";
                let newImageIndex = -1;
                switch (revisionString) {
                    case "-1": 
                        newImageIndex = oldImageIndex - 1;
                        break;
                    case "+1":
                        newImageIndex = oldImageIndex + 1;
                        break;
                    case "latest":
                        newImageIndex = images.length - 1;
                        break;
                    case "first":
                        newImageIndex = 0;
                        break;
                    default:
                        newImageIndex = findImageIndex(images, revisionString);
                        break;
                }
                if (newImageIndex < 0 || newImageIndex >= images.length) {
                    callback(`Could not find new image.`);
                    return;
                }
                const newImage = images[newImageIndex];
                const newImageRevision = newImage.imageTags && newImage.imageTags.length > 0 ? newImage.imageTags[0] : newImage.imageDigest;
                const newUrl = repositoryBase + "/" + repositoryName + (newImageRevision.indexOf(":") < 0 ? ":" : "@") + newImageRevision;
                Module.ecsCreateNewRevisionForContainer(taskDefinition, containerName, newUrl, callback);
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
            let subnets = subnetsDescription.Subnets.filter(subnet => subnet.DefaultForAz);
            if (subnets.length === 0)
                subnets = subnetsDescription.Subnets;
            callback(undefined, subnets.map(subnet => subnet.SubnetId));
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

    resilientPublishLambdaVersion: function (lambdaFunction, callback, baseDelay, maxExponent) {
        const lambda = new AWS.Lambda({apiVersion: '2015-03-31'});
        baseDelay = baseDelay || 1000;
        maxExponent = maxExponent || 5;
        if (maxExponent <= 0)
            callback("Exceeded publish timeout");
        lambda.publishVersion({
            FunctionName: lambdaFunction
        }, function (err, result) {
            if (err) {
                Module.resilientPublishLambdaVersion(lambdaFunction, callback, baseDelay * 2, maxExponent - 1);
                return;
            }
            callback(undefined, result);
        });
    },

    resilientUpdateConfigurationPublishLambdaVersion: function (lambdaFunction, configurationUpdate, callback, baseDelay, maxExponent) {
        const lambda = new AWS.Lambda({apiVersion: '2015-03-31'});
        configurationUpdate.FunctionName = lambdaFunction;
        lambda.updateFunctionConfiguration(configurationUpdate, function (err) {
            if (err) {
                callback(err);
                return;
            }
            Module.resilientPublishLambdaVersion(lambdaFunction, callback, baseDelay, maxExponent);
        });
    },

    resilientUpdateFunctionCodePublishLambdaVersion: function (lambdaFunction, functionCodeUpdate, callback, baseDelay, maxExponent) {
        const lambda = new AWS.Lambda({apiVersion: '2015-03-31'});
        functionCodeUpdate.FunctionName = lambdaFunction;
        lambda.updateFunctionCode(functionCodeUpdate, function (err) {
            if (err) {
                callback(err);
                return;
            }
            Module.resilientPublishLambdaVersion(lambdaFunction, callback, baseDelay, maxExponent);
        });
    },

    resilientMapConfigurationPublishLambdaVersion: function (lambdaFunction, configurationUpdateFunction, callback, baseDelay, maxExponent) {
        const lambda = new AWS.Lambda({apiVersion: '2015-03-31'});
        lambda.getFunctionConfiguration({
            FunctionName: lambdaFunction,
        }, function (err, functionConfiguration) {
            if (err) {
                callback(err);
                return;
            }
            Module.resilientUpdateConfigurationPublishLambdaVersion(lambdaFunction, configurationUpdateFunction(functionConfiguration), callback, baseDelay, maxExponent);
        });
    },

    edgeLambdaKillWarmInstances: function (lambdaFunction, cloudfrontId, lambdaEdgeType, callback) {
        const cloudfront = new AWS.CloudFront({apiVersion: '2020-05-31'});
        Module.resilientUpdateConfigurationPublishLambdaVersion(lambdaFunction, {
            Description: "AWSASS:" + (new Date()).getTime()
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
    },

    lambdaKillWarmInstances: function (lambdaFunction, callback) {
        Module.resilientMapConfigurationPublishLambdaVersion(lambdaFunction, function (functionConfiguration) {
            functionConfiguration.Environment.Variables.AWSASS = "" + (new Date()).getTime();
            return {
                Environment: functionConfiguration.Environment
            };
        }, callback);
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
        const f = function () {
            ecr.deleteRepository({
                repositoryName: ephemeralId,
                force: true
            }, function (err, deleteRepoResult) {
                if (err) {
                    callback(err);
                    return;
                }
                cloudwatchlogs.deleteLogGroup({
                    logGroupName: "/ecs/" + ephemeralId
                }, function (err, logGroupResult) {
                    callback(undefined, {
                        ephemeralId: ephemeralId,
                        repositoryUri: deleteRepoResult.repository.repositoryUri
                    });
                });
            });
        };
        ecs.listTaskDefinitions({
            familyPrefix: ephemeralId
        }, function (err, deregisterTaskDefs) {
            if (err) {
                callback(err);
                return;
            }
            let allCount = 0;
            let counter = 0;
            deregisterTaskDefs.taskDefinitionArns.forEach(arn => {
                if (arn.indexOf(ephemeralId) >= 0) {
                    allCount++;
                    ecs.deregisterTaskDefinition({
                        taskDefinition: arn
                    }, function () {
                        counter++;
                        if (counter === allCount)
                            f();
                    });
                }
            });
            if (allCount === 0)
                f();
        });
    },

    lambdaUpdatePublishS3: function (lambdaFunction, s3Bucket, s3Key, callback) {
        Module.resilientUpdateFunctionCodePublishLambdaVersion(lambdaFunction, {
            S3Bucket: s3Bucket,
            S3Key: s3Key
        }, callback);
    },

    lambdaUpdatePublishLocal: function (lambdaFunction, fileName, callback) {
        Module.resilientUpdateFunctionCodePublishLambdaVersion(lambdaFunction, {
            ZipFile: FS.readFileSync(fileName)
        }, callback);
    },

    apiGatewayAddLambdaPermission: function (restApiId, apiGatewaySubPath, lambdaFunction, lambdaFunctionVersion, callback) {
        const sts = new AWS.STS({apiVersion: "2011-06-15"});;
        const lambda = new AWS.Lambda({apiVersion: '2015-03-31'});
        sts.getCallerIdentity({}, function(err, callerId) {
            if (err) {
                callback(err);
                return;
            }
            lambda.addPermission({
                FunctionName: lambdaFunction + (lambdaFunctionVersion ? ":" + lambdaFunctionVersion : ""),
                StatementId: "apigateway" + (lambdaFunctionVersion ? "-" + lambdaFunctionVersion : "") + "-" + (new Date()).getTime(),
                Action: "lambda:InvokeFunction",
                Principal: "apigateway.amazonaws.com",
                SourceArn: ["arn:aws:execute-api", AWS.config.region, callerId.Account, [restApiId, "*", "*", apiGatewaySubPath].join("/")].join(":")
            }, callback);
        });
    },

    apiGatewayDeployLambdaProxySubRoute: function (restApiId, stageName, apiGatewayBasePath, apiGatewaySubPath, lambdaFunction, lambdaFunctionVersion, removeSmallestVersion, callback) {
        const apigateway = new AWS.APIGateway({apiVersion: "2015-07-09"});
        apigateway.getExport({
            restApiId: restApiId,
            stageName: stageName,
            exportType: "swagger",
            parameters: {
                extensions: "apigateway"
            }
        }, function (err, exportResponse) {
            if (err) {
                callback(err);
                return;
            }
            let swaggerSub;
            try {
                const swaggerBase = JSON.parse(exportResponse.body);
                console.log(swaggerBase);
                const subIntegration = swaggerBase.paths[apiGatewayBasePath]["x-amazon-apigateway-any-method"]["x-amazon-apigateway-integration"];
                delete subIntegration.cacheNamespace;
                if (lambdaFunction) {
                    let splt = subIntegration.uri.split("/");
                    let splt2 = splt[splt.length - 2].split(":");
                    splt2[6] = lambdaFunction;
                    splt[splt.length - 2] = splt2.join(":");
                    subIntegration.uri = splt.join("/");
                }
                if (lambdaFunctionVersion) {
                    let splt = subIntegration.uri.split("/");
                    let splt2 = splt[splt.length - 2].split(":");
                    splt2[7] = lambdaFunctionVersion;
                    splt[splt.length - 2] = splt2.join(":");
                    subIntegration.uri = splt.join("/");
                }
                swaggerSub = {
                    swagger: swaggerBase.swagger,
                    info: swaggerBase.info,
                    paths: {}
                };
                swaggerSub.paths[apiGatewaySubPath] = swaggerBase.paths[apiGatewayBasePath];
            } catch (e) {
                callback("Malformed swagger");
                return;
            }
            apigateway.putRestApi({
                restApiId: restApiId,
                mode: "merge",
                parameters: {
                    ignore: "documentation"
                },
                body: JSON.stringify(swaggerSub)
            }, function (err) {
                if (err) {
                    callback(err);
                    return;
                }
                if (removeSmallestVersion) {
                    const swaggerBase = JSON.parse(exportResponse.body);
                    const subIntegration = swaggerBase.paths[apiGatewayBasePath]["x-amazon-apigateway-any-method"]["x-amazon-apigateway-integration"];
                    let smallestVersion = null;
                    const subIntegrationBase = (subIntegration.uri.split("/invocations"))[0];
                    for (let proxyKey in swaggerBase.paths) {
                        const lambdaUri = swaggerBase.paths[proxyKey]["x-amazon-apigateway-any-method"]["x-amazon-apigateway-integration"].uri;
                        if (lambdaUri.indexOf(subIntegrationBase) === 0) {
                            const lambdaVersion = parseInt(lambdaUri.substring(subIntegrationBase.length + 1), 10);
                            if (!isNaN(lambdaVersion)) {
                                if (!smallestVersion || smallestVersion.version > lambdaVersion) {
                                    smallestVersion = {
                                        proxyKey: proxyKey,
                                        version: lambdaVersion
                                    };
                                }
                            }
                        }
                    }
                    if (smallestVersion) {
                        apigateway.getResources({
                            restApiId: restApiId,
                            limit: 500
                        }, function (err, resourcesResponse) {
                            if (err !== null) {
                                callback(err);
                                return;
                            }
                            let smallestVersionId = resourcesResponse.items.find(item => item.path === smallestVersion.proxyKey);
                            if (!smallestVersionId) {
                                console.log("Couldn't find smallest version id, ignoring", smallestVersionId);
                                console.log(resourcesResponse.items);
                                //callback("Couldn't find smallest version id");
                                apigateway.createDeployment({ restApiId: restApiId, stageName: stageName }, callback);
                                return;
                            }
                            let parent = undefined;
                            let childCount = 0;
                            resourcesResponse.items.forEach(item => {
                                if (item.id === smallestVersionId.parentId)
                                    parent = item;
                                if (item.parentId === smallestVersionId.parentId)
                                    childCount++;
                            });
                            if (parent && childCount === 1)
                                smallestVersionId = parent;
                            if (smallestVersionId) {
                                console.log("Removing smallest version", smallestVersion, smallestVersionId);
                                apigateway.deleteResource({
                                    restApiId: restApiId,
                                    resourceId: smallestVersionId.id
                                }, function (err) {
                                    if (err !== null) {
                                        callback(err);
                                        return;
                                    }
                                    apigateway.createDeployment({ restApiId: restApiId, stageName: stageName }, callback);
                                });
                            }
                        });
                    } else
                        apigateway.createDeployment({ restApiId: restApiId, stageName: stageName }, callback);
                } else
                    apigateway.createDeployment({ restApiId: restApiId, stageName: stageName }, callback);
            });
        });
    },

    apiGatewayLambdaDeploySub: function (restApiId, stageName, apiGatewayBasePath, apiGatewaySubPath, lambdaFunction, s3Bucket, s3Key, removeSmallestVersion, callback) {
        Module.lambdaUpdatePublishS3(lambdaFunction, s3Bucket, s3Key, function (err, lambdaResult) {
            if (err) {
                callback(err);
                return;
            }
            const lambdaFunctionVersion = lambdaResult.Version;
            const splt = apiGatewaySubPath.split("/");
            splt[splt.length - 1] = "*";
            const apiGatewaySubPathMapping = splt.join("/");;
            Module.apiGatewayAddLambdaPermission(restApiId, apiGatewaySubPathMapping, lambdaFunction, lambdaFunctionVersion, function (err) {
                if (err) {
                    callback(err);
                    return;
                }
                Module.apiGatewayDeployLambdaProxySubRoute(restApiId, stageName, apiGatewayBasePath, apiGatewaySubPath, lambdaFunction, lambdaFunctionVersion, removeSmallestVersion, callback);
            });
        });
    }

};

module.exports = Module;