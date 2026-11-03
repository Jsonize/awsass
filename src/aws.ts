export interface AwsOptions {
    region?: string;
    profile?: string;
}

let awsOptions: AwsOptions = {};

export function configureAws(options: AwsOptions): void {
    awsOptions = options;
}

// Passed to every client; the profile selects both credentials and, if no region is given, the profile's region.
export function clientConfig(): AwsOptions {
    return {region: awsOptions.region, profile: awsOptions.profile};
}

export function errorName(err: unknown): string | undefined {
    return err instanceof Error ? err.name : undefined;
}
