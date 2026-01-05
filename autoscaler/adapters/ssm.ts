import {
  SSMClient,
  SendCommandCommand,
  GetCommandInvocationCommand,
} from "@aws-sdk/client-ssm";

const ssm = new SSMClient({
  region: "ap-southeast-1",
  endpoint:
    "https://vpce-0e555531fdf633032-ngii1226.ssm.ap-southeast-1.vpce.amazonaws.com",
});

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function runShellOnInstance(params: {
  instanceId: string;
  commands: string[];
  timeoutSeconds?: number;
  pollEveryMs?: number;
}): Promise<{ stdout: string; stderr: string; status: string }> {
  const {
    instanceId,
    commands,
    timeoutSeconds = 55,
    pollEveryMs = 1500,
  } = params;

  const send = await ssm.send(
    new SendCommandCommand({
      InstanceIds: [instanceId],
      DocumentName: "AWS-RunShellScript",
      Parameters: { commands },
      TimeoutSeconds: timeoutSeconds,
    })
  );

  const commandId = send.Command?.CommandId;

  if (!commandId) throw new Error("SSM SendCommand did not return commandId");

  const deadline = Date.now() + timeoutSeconds * 1000;

  while (true) {
    if (Date.now() > deadline) {
      throw new Error(`SSM command timed out waiting: ${commandId}`);
    }

    try {
      const inv = await ssm.send(
        new GetCommandInvocationCommand({
          CommandId: commandId,
          InstanceId: instanceId,
        })
      );

      const status = inv.Status ?? "Unknown";

      if (
        status === "Success" ||
        status === "Failed" ||
        status === "TimedOut" ||
        status === "Cancelled"
      ) {
        return {
          stdout: inv.StandardOutputContent ?? "",
          stderr: inv.StandardErrorContent ?? "",
          status,
        };
      }
    } catch (error) {
      console.log("Error in ssm adapter: ", error);
    }

    await sleep(pollEveryMs);
  }
}
