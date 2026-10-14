/** Reject inside the test so its finally block can release held resources. */
export async function waitForCheckpoint<T>(promise: Promise<T>, name: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${name}`)), 3000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
