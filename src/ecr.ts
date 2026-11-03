import {ECR, paginateDescribeImages, type ImageDetail} from "@aws-sdk/client-ecr";
import {ECS} from "@aws-sdk/client-ecs";
import {clientConfig} from "./aws.ts";
import * as Docker from "./docker.ts";
import {ecsCreateNewRevisionForContainer, ecsDescribeTaskDefinition} from "./ecs.ts";

export async function ecrLoginDetails(): Promise<{username: string, password: string, endpoint: string}> {
    const ecr = new ECR(clientConfig());
    const authorizationData = (await ecr.getAuthorizationToken({})).authorizationData?.[0];
    if (!authorizationData?.authorizationToken || !authorizationData.proxyEndpoint)
        throw new Error("Could not get ECR authorization token.");
    const userPwd = Buffer.from(authorizationData.authorizationToken, "base64").toString("ascii");
    const idx = userPwd.indexOf(":");
    return {
        username: userPwd.substring(0, idx),
        password: userPwd.substring(idx + 1),
        endpoint: authorizationData.proxyEndpoint
    };
}

export async function ecrLogin(): Promise<string> {
    const details = await ecrLoginDetails();
    return Docker.login(details.username, details.password, details.endpoint);
}

export async function ecrTagPush(localImageName: string, imageName: string): Promise<string> {
    await ecrLogin();
    await Docker.tag(localImageName, imageName);
    return Docker.push(imageName);
}

export async function ecrEcsPushNewRevision(taskDefinition: string, containerName: string, localImageName: string, imageName: string) {
    await ecrTagPush(localImageName, imageName);
    return ecsCreateNewRevisionForContainer(taskDefinition, containerName, imageName);
}

const findImageIndex = function (images: ImageDetail[], searchString: string): number {
    return images.findIndex(image => image.imageDigest === searchString || (image.imageTags ?? []).includes(searchString));
};

// Splits "<registry>/<repository>[:tag|@digest]"; repositories may contain slashes and images without tag mean "latest".
export function parseImageUri(image: string): {registry: string, repositoryName: string, revision: string} {
    const slash = image.indexOf("/");
    const registry = image.substring(0, slash);
    const rest = image.substring(slash + 1);
    const at = rest.indexOf("@");
    const colon = rest.lastIndexOf(":");
    if (at >= 0)
        return {registry: registry, repositoryName: rest.substring(0, at), revision: rest.substring(at + 1)};
    if (colon >= 0)
        return {registry: registry, repositoryName: rest.substring(0, colon), revision: rest.substring(colon + 1)};
    return {registry: registry, repositoryName: rest, revision: "latest"};
}

export async function ecrEcsSetRevision(taskDefinition: string, containerName: string | undefined, revisionString: string | undefined) {
    const ecs = new ECS(clientConfig());
    const ecr = new ECR(clientConfig());
    const taskDef = await ecsDescribeTaskDefinition(ecs, taskDefinition);
    const containerDefinitions = taskDef.containerDefinitions ?? [];
    const containerDefinition = containerName ? containerDefinitions.find(containerDefinition => containerDefinition.name === containerName) : containerDefinitions[0];
    if (!containerDefinition?.name || !containerDefinition.image)
        throw new Error("Could not find container definition.");
    const {registry, repositoryName, revision} = parseImageUri(containerDefinition.image);
    let images: ImageDetail[] = [];
    for await (const page of paginateDescribeImages({client: ecr}, {repositoryName: repositoryName}))
        images = images.concat(page.imageDetails ?? []);
    images.sort((x, y) => (x.imagePushedAt?.getTime() ?? 0) - (y.imagePushedAt?.getTime() ?? 0));
    const oldImageIndex = findImageIndex(images, revision);
    if (oldImageIndex < 0)
        throw new Error("Could not find current image.");
    revisionString = revisionString || "latest";
    let newImageIndex: number;
    switch (revisionString) {
        case "latest":
            newImageIndex = images.length - 1;
            break;
        case "first":
            newImageIndex = 0;
            break;
        default:
            if (isNaN(Number(revisionString)))
                newImageIndex = findImageIndex(images, revisionString);
            else
                newImageIndex = oldImageIndex + parseInt(revisionString, 10);
            break;
    }
    const newImage = images[newImageIndex];
    if (!newImage)
        throw new Error("Could not find new image.");
    const newImageRevision = newImage.imageTags?.[0] ?? newImage.imageDigest ?? "";
    const newUrl = registry + "/" + repositoryName + (newImageRevision.indexOf(":") < 0 ? ":" : "@") + newImageRevision;
    return ecsCreateNewRevisionForContainer(taskDefinition, containerDefinition.name, newUrl);
}
