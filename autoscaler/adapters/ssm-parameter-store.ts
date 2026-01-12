import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";

const ssm = new SSMClient({});

let cache: Record<string, { v: string; exp: number }> = {};

async function getSecureParam(name: string): Promise<string> {
  const now = Date.now();
  const hit = cache[name];
  if (hit && hit.exp > now) return hit.v;

  const out = await ssm.send(
    new GetParameterCommand({ Name: name, WithDecryption: true })
  );

  const v = out.Parameter?.Value;
  if (!v) throw new Error(`SSM parameter empty: ${name}`);

  // cache for 2 minutes
  cache[name] = { v, exp: now + 120_000 };
  return v;
}

export default getSecureParam;
