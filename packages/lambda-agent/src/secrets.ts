import { SSMClient, GetParametersCommand } from "@aws-sdk/client-ssm";

const ssm = new SSMClient({});
const cache = new Map<string, string>();

/**
 * Batch-resolve SSM SecureString parameters. Results are cached per Lambda instance.
 * Same pattern as packages/gateway/src/services/secrets.ts.
 */
export async function resolveSecrets(
  names: string[],
): Promise<Map<string, string>> {
  const missing = names.filter((n) => !cache.has(n));
  if (missing.length > 0) {
    const result = await ssm.send(
      new GetParametersCommand({ Names: missing, WithDecryption: true }),
    );
    for (const param of result.Parameters ?? []) {
      if (param.Name && param.Value) {
        cache.set(param.Name, param.Value);
      }
    }
  }
  return cache;
}
