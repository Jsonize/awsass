import {APIGateway, paginateGetResources, type Resource} from "@aws-sdk/client-api-gateway";
import {Lambda} from "@aws-sdk/client-lambda";
import {STS} from "@aws-sdk/client-sts";
import {clientConfig} from "./aws.ts";
import {lambdaUpdatePublishS3} from "./lambda.ts";

export async function apiGatewayAddLambdaPermission(restApiId: string, apiGatewaySubPath: string, lambdaFunction: string, lambdaFunctionVersion: string | undefined) {
    const sts = new STS(clientConfig());
    const lambda = new Lambda(clientConfig());
    const callerId = await sts.getCallerIdentity({});
    return lambda.addPermission({
        FunctionName: lambdaFunction + (lambdaFunctionVersion ? ":" + lambdaFunctionVersion : ""),
        StatementId: "apigateway" + (lambdaFunctionVersion ? "-" + lambdaFunctionVersion : "") + "-" + Date.now(),
        Action: "lambda:InvokeFunction",
        Principal: "apigateway.amazonaws.com",
        SourceArn: ["arn:aws:execute-api", await lambda.config.region(), callerId.Account, [restApiId, "*", "*", apiGatewaySubPath].join("/")].join(":")
    });
}

// Minimal shape of the swagger export this module reads.
interface Swagger {
    swagger: string;
    info: unknown;
    paths: Record<string, {"x-amazon-apigateway-any-method"?: {"x-amazon-apigateway-integration"?: {uri: string, cacheNamespace?: string}}}>;
}

const integrationOf = function (swagger: Swagger, path: string) {
    const integration = swagger.paths[path]?.["x-amazon-apigateway-any-method"]?.["x-amazon-apigateway-integration"];
    if (!integration)
        throw new Error(`No lambda proxy integration at ${path}.`);
    return integration;
};

// Integration uris look like arn:aws:apigateway:<region>:lambda:path/2015-03-31/functions/<lambda arn>/invocations.
const replaceInLambdaArn = function (uri: string, index: number, value: string): string {
    const splt = uri.split("/");
    const splt2 = (splt[splt.length - 2] ?? "").split(":");
    splt2[index] = value;
    splt[splt.length - 2] = splt2.join(":");
    return splt.join("/");
};

export async function apiGatewayDeployLambdaProxySubRoute(restApiId: string, stageName: string, apiGatewayBasePath: string, apiGatewaySubPath: string, lambdaFunction: string | undefined, lambdaFunctionVersion: string | undefined, removeSmallestVersion: boolean | undefined) {
    const apigateway = new APIGateway(clientConfig());
    const exportResponse = await apigateway.getExport({
        restApiId: restApiId,
        stageName: stageName,
        exportType: "swagger",
        parameters: {extensions: "apigateway"}
    });
    const exportBody = new TextDecoder().decode(exportResponse.body);
    let swaggerSub: Swagger;
    try {
        const swaggerBase: Swagger = JSON.parse(exportBody);
        const subIntegration = integrationOf(swaggerBase, apiGatewayBasePath);
        delete subIntegration.cacheNamespace;
        if (lambdaFunction)
            subIntegration.uri = replaceInLambdaArn(subIntegration.uri, 6, lambdaFunction);
        if (lambdaFunctionVersion)
            subIntegration.uri = replaceInLambdaArn(subIntegration.uri, 7, lambdaFunctionVersion);
        swaggerSub = {
            swagger: swaggerBase.swagger,
            info: swaggerBase.info,
            paths: {[apiGatewaySubPath]: swaggerBase.paths[apiGatewayBasePath]!}
        };
    } catch (e) {
        throw new Error("Malformed swagger");
    }
    await apigateway.putRestApi({
        restApiId: restApiId,
        mode: "merge",
        parameters: {ignore: "documentation"},
        body: new TextEncoder().encode(JSON.stringify(swaggerSub))
    });
    if (removeSmallestVersion)
        await removeSmallestVersionRoute(apigateway, restApiId, apiGatewayBasePath, JSON.parse(exportBody));
    return apigateway.createDeployment({restApiId: restApiId, stageName: stageName});
}

// Deletes the route pointing at the oldest version of the base route's function, as of before this deployment.
const removeSmallestVersionRoute = async function (apigateway: APIGateway, restApiId: string, apiGatewayBasePath: string, swaggerBase: Swagger) {
    const subIntegrationBase = integrationOf(swaggerBase, apiGatewayBasePath).uri.split("/invocations")[0] ?? "";
    let smallestVersion: {proxyKey: string, version: number} | undefined = undefined;
    for (const proxyKey in swaggerBase.paths) {
        const lambdaUri = swaggerBase.paths[proxyKey]?.["x-amazon-apigateway-any-method"]?.["x-amazon-apigateway-integration"]?.uri;
        if (!lambdaUri?.startsWith(subIntegrationBase))
            continue;
        const lambdaVersion = parseInt(lambdaUri.substring(subIntegrationBase.length + 1), 10);
        if (!isNaN(lambdaVersion) && (!smallestVersion || smallestVersion.version > lambdaVersion))
            smallestVersion = {proxyKey: proxyKey, version: lambdaVersion};
    }
    if (!smallestVersion)
        return;
    let resources: Resource[] = [];
    for await (const page of paginateGetResources({client: apigateway}, {restApiId: restApiId, limit: 500}))
        resources = resources.concat(page.items ?? []);
    let resource = resources.find(item => item.path === smallestVersion.proxyKey);
    if (!resource) {
        console.error("Couldn't find smallest version resource, ignoring", smallestVersion);
        return;
    }
    // If the route is the only child of its parent (e.g. /v42/{proxy+} under /v42), remove the parent instead.
    const parent = resources.find(item => item.id === resource!.parentId);
    const siblingCount = resources.filter(item => item.parentId === resource!.parentId).length;
    if (parent && siblingCount === 1)
        resource = parent;
    console.error("Removing smallest version", smallestVersion, resource.path);
    await apigateway.deleteResource({restApiId: restApiId, resourceId: resource.id});
};

export async function apiGatewayLambdaDeploySub(restApiId: string, stageName: string, apiGatewayBasePath: string, apiGatewaySubPath: string, lambdaFunction: string, s3Bucket: string, s3Key: string, removeSmallestVersion: boolean | undefined) {
    const lambdaResult = await lambdaUpdatePublishS3(lambdaFunction, s3Bucket, s3Key);
    const lambdaFunctionVersion = lambdaResult.Version;
    const splt = apiGatewaySubPath.split("/");
    splt[splt.length - 1] = "*";
    await apiGatewayAddLambdaPermission(restApiId, splt.join("/"), lambdaFunction, lambdaFunctionVersion);
    return apiGatewayDeployLambdaProxySubRoute(restApiId, stageName, apiGatewayBasePath, apiGatewaySubPath, lambdaFunction, lambdaFunctionVersion, removeSmallestVersion);
}
