export function runStartup(mode: "bot", args: string[]): number {
  if (args.length === 1 && args[0] === "--help") {
    console.log(`Usage: npm run start:${mode} -- [--help]`);
    return 0;
  }

  if (args.length > 0) {
    console.error(`Unsupported arguments: ${args.join(" ")}`);
    return 1;
  }

  console.log("Bot server is not implemented yet.");
  return 0;
}
