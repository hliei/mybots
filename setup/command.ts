import { SetupError } from "./onecli.ts";
import type { CommandResult, SetupContext } from "./steps.ts";

export async function command(
  context: SetupContext,
  name: string,
  args: string[],
): Promise<CommandResult> {
  const result = await context.exec(name, args);
  if (result.code !== 0) throw new SetupError(`${name} ${args.join(" ")} failed.`);
  return result;
}
