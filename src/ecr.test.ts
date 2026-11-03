import {describe, it} from "node:test";
import assert from "node:assert/strict";
import {ECRClient, DescribeImagesCommand} from "@aws-sdk/client-ecr";
import {ECSClient, DescribeTaskDefinitionCommand, RegisterTaskDefinitionCommand} from "@aws-sdk/client-ecs";
import {ecrEcsSetRevision, parseImageUri} from "./ecr.ts";
import {mockClients} from "./test-util.ts";

const mocks = mockClients({ecr: ECRClient, ecs: ECSClient});
const REGISTRY = "1.dkr.ecr.eu-central-1.amazonaws.com";

describe("parseImageUri", () => {
    it("parses tags, digests, namespaced repositories and missing tags", () => {
        assert.deepEqual(parseImageUri(`${REGISTRY}/app:v1`), {registry: REGISTRY, repositoryName: "app", revision: "v1"});
        assert.deepEqual(parseImageUri(`${REGISTRY}/team/app@sha256:abc`), {registry: REGISTRY, repositoryName: "team/app", revision: "sha256:abc"});
        assert.deepEqual(parseImageUri(`${REGISTRY}/team/app`), {registry: REGISTRY, repositoryName: "team/app", revision: "latest"});
    });
});

describe("ecrEcsSetRevision", () => {
    const setup = function (currentImage: string) {
        mocks.ecs.on(DescribeTaskDefinitionCommand).resolves({taskDefinition: {family: "f", containerDefinitions: [{name: "c", image: currentImage}]}});
        mocks.ecs.on(RegisterTaskDefinitionCommand).resolves({});
        // Second page and unsorted on purpose.
        mocks.ecr.on(DescribeImagesCommand)
            .resolvesOnce({imageDetails: [
                {imageDigest: "sha256:3", imageTags: ["v3"], imagePushedAt: new Date(3000)},
                {imageDigest: "sha256:1", imageTags: ["v1"], imagePushedAt: new Date(1000)}
            ], nextToken: "n"})
            .resolvesOnce({imageDetails: [
                {imageDigest: "sha256:2", imagePushedAt: new Date(2000)}
            ]});
    };
    const newImage = () => mocks.ecs.commandCalls(RegisterTaskDefinitionCommand)[0]!.args[0].input.containerDefinitions![0]!.image;

    for (const [current, revision, expected] of [
        ["v1", undefined, "app:v3"],
        ["v3", "first", "app:v1"],
        ["v3", "-1", "app@sha256:2"],
        ["v1", "1", "app@sha256:2"],
        ["v3", "v1", "app:v1"]
    ] as const) {
        it(`moves from ${current} with ${revision} to ${expected}`, async () => {
            setup(`${REGISTRY}/app:${current}`);
            await ecrEcsSetRevision("f", undefined, revision);
            assert.equal(newImage(), `${REGISTRY}/${expected}`);
        });
    }

    it("fails when moving past the newest image", async () => {
        setup(`${REGISTRY}/app:v3`);
        await assert.rejects(ecrEcsSetRevision("f", "c", "+1"), /Could not find new image/);
    });
});
