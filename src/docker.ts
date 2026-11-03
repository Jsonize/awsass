import {spawn} from "node:child_process";

const docker = function (args: string[], stdin?: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const child = spawn("docker", args);
        let output = "";
        child.stdout.on("data", data => output += data);
        child.stderr.on("data", data => output += data);
        child.on("error", reject);
        child.on("close", code => {
            if (code === 0)
                resolve(output);
            else
                reject(new Error(`docker ${args[0]} failed with exit code ${code}: ${output.trim()}`));
        });
        child.stdin.end(stdin);
    });
};

export function login(username: string, password: string, endpoint: string): Promise<string> {
    return docker(["login", "-u", username, "--password-stdin", endpoint], password);
}

export function tag(localImageName: string, imageName: string): Promise<string> {
    return docker(["tag", localImageName, imageName]);
}

export function push(imageName: string): Promise<string> {
    return docker(["push", imageName]);
}
