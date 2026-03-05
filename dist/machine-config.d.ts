export interface S3Config {
    endpoint: string;
    bucket: string;
    accessKey: string;
    secretKey: string;
}
export interface MachineConfig {
    bots: string[];
    secretsPath: string;
    s3?: S3Config;
    containerNetwork?: string;
}
export declare function loadMachineConfig(): MachineConfig;
/** Clear cached config (for testing or reload). */
export declare function clearMachineConfigCache(): void;
