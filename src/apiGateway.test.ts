import {describe, it} from "node:test";
import assert from "node:assert/strict";
import {APIGatewayClient, CreateDeploymentCommand, DeleteResourceCommand, GetExportCommand, GetResourcesCommand, PutRestApiCommand} from "@aws-sdk/client-api-gateway";
import {LambdaClient, AddPermissionCommand} from "@aws-sdk/client-lambda";
import {STSClient, GetCallerIdentityCommand} from "@aws-sdk/client-sts";
import {apiGatewayAddLambdaPermission, apiGatewayDeployLambdaProxySubRoute} from "./apiGateway.ts";
import {mockClients} from "./test-util.ts";

const mocks = mockClients({apigateway: APIGatewayClient, lambda: LambdaClient, sts: STSClient});

const uri = (version?: number) => "arn:aws:apigateway:eu-central-1:lambda:path/2015-03-31/functions/arn:aws:lambda:eu-central-1:1:function:f"
    + (version ? ":" + version : "") + "/invocations";
const route = (version?: number) => ({"x-amazon-apigateway-any-method": {"x-amazon-apigateway-integration": {uri: uri(version), cacheNamespace: "x"}}});

const mockExport = function () {
    const swagger = {swagger: "2.0", info: {title: "api"}, paths: {"/{proxy+}": route(), "/v3/{proxy+}": route(3), "/v5/{proxy+}": route(5)}};
    mocks.apigateway.on(GetExportCommand).resolves({body: new TextEncoder().encode(JSON.stringify(swagger)) as any});
    mocks.apigateway.on(PutRestApiCommand).resolves({});
    mocks.apigateway.on(CreateDeploymentCommand).resolves({id: "d"});
};

describe("apiGatewayDeployLambdaProxySubRoute", () => {
    it("merges a copy of the base route pointing at the new version and deploys", async () => {
        mockExport();
        await apiGatewayDeployLambdaProxySubRoute("api", "production", "/{proxy+}", "/v7/{proxy+}", undefined, "7", false);
        const body = JSON.parse(new TextDecoder().decode(mocks.apigateway.commandCalls(PutRestApiCommand)[0]!.args[0].input.body as Uint8Array));
        assert.deepEqual(body, {swagger: "2.0", info: {title: "api"}, paths: {"/v7/{proxy+}": {"x-amazon-apigateway-any-method": {"x-amazon-apigateway-integration": {uri: uri(7)}}}}});
        assert.deepEqual(mocks.apigateway.commandCalls(CreateDeploymentCommand)[0]!.args[0].input, {restApiId: "api", stageName: "production"});
        assert.equal(mocks.apigateway.commandCalls(DeleteResourceCommand).length, 0);
    });

    it("removes the smallest version's parent resource if it has no other children", async () => {
        mockExport();
        mocks.apigateway.on(GetResourcesCommand).resolves({items: [
            {id: "root", path: "/"}, {id: "v3", parentId: "root", path: "/v3"}, {id: "v3p", parentId: "v3", path: "/v3/{proxy+}"},
            {id: "v5", parentId: "root", path: "/v5"}, {id: "v5p", parentId: "v5", path: "/v5/{proxy+}"}
        ]});
        mocks.apigateway.on(DeleteResourceCommand).resolves({});
        await apiGatewayDeployLambdaProxySubRoute("api", "production", "/{proxy+}", "/v7/{proxy+}", undefined, "7", true);
        assert.deepEqual(mocks.apigateway.commandCalls(DeleteResourceCommand)[0]!.args[0].input, {restApiId: "api", resourceId: "v3"});
    });

    it("fails on a missing base route", async () => {
        mockExport();
        await assert.rejects(apiGatewayDeployLambdaProxySubRoute("api", "production", "/missing", "/v7/{proxy+}", undefined, "7", false), /Malformed swagger/);
    });
});

describe("apiGatewayAddLambdaPermission", () => {
    it("allows the api to invoke the version", async () => {
        mocks.sts.on(GetCallerIdentityCommand).resolves({Account: "123"});
        mocks.lambda.on(AddPermissionCommand).resolves({});
        await apiGatewayAddLambdaPermission("api", "/v7/*", "f", "7");
        const input = mocks.lambda.commandCalls(AddPermissionCommand)[0]!.args[0].input;
        assert.equal(input.FunctionName, "f:7");
        assert.equal(input.SourceArn, "arn:aws:execute-api:eu-central-1:123:api/*/*//v7/*");
    });
});
