const AWS = require("aws-sdk");
const Docker = require(__dirname + "/docker.js");

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
    }

};

module.exports = Module;