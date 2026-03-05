interface VolumeMount {
    hostPath: string;
    containerPath: string;
    readonly: boolean;
}
/**
 * Normalize secrets for Ollama mode.
 * When the Anthropic base URL points to Ollama, strip OAuth tokens
 * and force all SDK model slots to the configured model.
 */
export declare function normalizeProviderSecrets(secrets: Record<string, string>): Record<string, string>;
/**
 * Map host cert file paths to container paths via volume mounts.
 * Normalizes CA bundle env so Node, Python/requests, curl, and git
 * all see the same trust anchor.
 */
export declare function mapCertPathSecretsToContainer(secrets: Record<string, string>, mounts: VolumeMount[]): Record<string, string>;
export {};
