import {readFile} from "node:fs/promises";
import {Lambda, paginateListVersionsByFunction, waitUntilFunctionUpdatedV2} from "@aws-sdk/client-lambda";
import {EventBridge, type ListRulesCommandOutput, type Rule} from "@aws-sdk/client-eventbridge";
import {CloudFront} from "@aws-sdk/client-cloudfront";
import {clientConfig} from "./aws.ts";

// Publishing fails while an update is still being applied, so wait for it first.
const waitAndPublishVersion = async function (lambda: Lambda, lambdaFunction: string) {
    await waitUntilFunctionUpdatedV2({client: lambda, maxWaitTime: 300}, {FunctionName: lambdaFunction});
    return lambda.publishVersion({FunctionName: lambdaFunction});
};

export async function lambdaUpdatePublishS3(lambdaFunction: string, s3Bucket: string, s3Key: string) {
    const lambda = new Lambda(clientConfig());
    await lambda.updateFunctionCode({FunctionName: lambdaFunction, S3Bucket: s3Bucket, S3Key: s3Key});
    return waitAndPublishVersion(lambda, lambdaFunction);
}

export async function lambdaUpdatePublishLocal(lambdaFunction: string, fileName: string) {
    const lambda = new Lambda(clientConfig());
    await lambda.updateFunctionCode({FunctionName: lambdaFunction, ZipFile: await readFile(fileName)});
    return waitAndPublishVersion(lambda, lambdaFunction);
}

export async function lambdaKillWarmInstances(lambdaFunction: string) {
    const lambda = new Lambda(clientConfig());
    const functionConfiguration = await lambda.getFunctionConfiguration({FunctionName: lambdaFunction});
    const variables = {...functionConfiguration.Environment?.Variables, AWSASS: String(Date.now())};
    await lambda.updateFunctionConfiguration({FunctionName: lambdaFunction, Environment: {Variables: variables}});
    return waitAndPublishVersion(lambda, lambdaFunction);
}

export async function edgeLambdaKillWarmInstances(lambdaFunction: string, cloudfrontId: string, lambdaEdgeType: string) {
    const lambda = new Lambda(clientConfig());
    const cloudfront = new CloudFront(clientConfig());
    await lambda.updateFunctionConfiguration({FunctionName: lambdaFunction, Description: "AWSASS:" + Date.now()});
    const publishResult = await waitAndPublishVersion(lambda, lambdaFunction);
    const distributionConfig = await cloudfront.getDistributionConfig({Id: cloudfrontId});
    const config = distributionConfig.DistributionConfig;
    const lambdaItem = config?.DefaultCacheBehavior?.LambdaFunctionAssociations?.Items?.find(item => item.EventType === lambdaEdgeType);
    if (!config || !lambdaItem?.LambdaFunctionARN)
        throw new Error(`Could not find ${lambdaEdgeType} lambda association.`);
    const splt = lambdaItem.LambdaFunctionARN.split(":");
    splt[splt.length - 1] = publishResult.Version ?? "";
    lambdaItem.LambdaFunctionARN = splt.join(":");
    return cloudfront.updateDistribution({Id: cloudfrontId, IfMatch: distributionConfig.ETag, DistributionConfig: config});
}

export async function lambdaListPublishedVersions(lambdaFunction: string): Promise<string[]> {
    const lambda = new Lambda(clientConfig());
    let versions: string[] = [];
    for await (const page of paginateListVersionsByFunction({client: lambda}, {FunctionName: lambdaFunction}))
        versions = versions.concat((page.Versions ?? []).flatMap(v => v.Version && v.Version !== "$LATEST" ? [v.Version] : []));
    return versions.sort((x, y) => parseInt(x, 10) - parseInt(y, 10));
}

const lambdaTarget = async function (events: EventBridge, rule: string) {
    const listTargetsByRule = await events.listTargetsByRule({Rule: rule});
    return (listTargetsByRule.Targets ?? []).find(target => target.Arn?.startsWith("arn:aws:lambda"));
};

export async function scheduledLambdaListRevision(): Promise<string[]> {
    const events = new EventBridge(clientConfig());
    let rules: Rule[] = [];
    let nextToken: string | undefined = undefined;
    do {
        const listRules: ListRulesCommandOutput = await events.listRules({Limit: 100, NextToken: nextToken});
        rules = rules.concat(listRules.Rules ?? []);
        nextToken = listRules.NextToken;
    } while (nextToken);
    const result: string[] = [];
    for (const rule of rules) {
        const target = rule.Name ? await lambdaTarget(events, rule.Name) : undefined;
        if (target?.Arn)
            result.push(target.Arn);
    }
    return result;
}

export async function scheduledLambdaSetRevision(cloudwatchRule: string, revisionString: string | undefined) {
    const events = new EventBridge(clientConfig());
    const target = await lambdaTarget(events, cloudwatchRule);
    if (!target?.Arn)
        throw new Error("Cannot find lambda target");
    const splt = target.Arn.split(":");
    const functionArn = splt.slice(0, 7).join(":");
    const versions = await lambdaListPublishedVersions(functionArn);
    const highestVersion = versions[versions.length - 1];
    if (!highestVersion)
        throw new Error("Function has no published versions.");
    // An unqualified or $LATEST target counts as being on the highest published version.
    let currentVersion = splt[7];
    if (!currentVersion || currentVersion === "$LATEST")
        currentVersion = highestVersion;
    revisionString = revisionString || "latest";
    let newVersion: string | undefined;
    switch (revisionString) {
        case "latest":
            newVersion = highestVersion;
            break;
        case "first":
            newVersion = versions[0];
            break;
        default:
            if (revisionString.startsWith("+") || revisionString.startsWith("-")) {
                const currentIndex = versions.indexOf(currentVersion);
                if (currentIndex < 0)
                    throw new Error(`Could not find current version ${currentVersion}.`);
                newVersion = versions[currentIndex + parseInt(revisionString, 10)];
            } else
                newVersion = revisionString;
            break;
    }
    if (!newVersion || (newVersion !== "$LATEST" && !versions.includes(newVersion)))
        throw new Error("Could not find new version.");
    target.Arn = newVersion === "$LATEST" ? functionArn : functionArn + ":" + newVersion;
    return events.putTargets({Rule: cloudwatchRule, Targets: [target]});
}
