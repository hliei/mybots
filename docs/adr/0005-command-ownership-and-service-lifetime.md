# Command ownership and service lifetime

Status: command ownership and service lifetime implemented; automatic worker recovery pending.

Associate Computer commands with the Bot and Agent turn that launched them.
An intentionally launched background service may outlive a completed turn so
the owner can keep using its result. Stop cancels the current turn, withdraws
queued input and terminates that turn's owned work, including services it
started; services retained by earlier completed turns and other Bots are not
affected. The owner can request that an earlier service be stopped through chat.

After unexpected worker exit, attempt bounded automatic worker restart and
restore subscriptions. Clean up interrupted-turn processes before resuming that
work from Durable storage, while preserving services retained by completed
turns. Expose recovery and cleanup failures instead of claiming success. Durable
remains the execution authority: process cleanup does not resubmit accepted
input, replay unsafe tools or roll back completed effects.

Normal application shutdown does not additionally terminate services retained
by completed turns. They remain subject to their own exit, applicable time
limits and Computer shutdown, and may consume resources while the application
is closed. Working files persist across Computer replacement, but services do
not automatically restart. This accepts explicit service cleanup in exchange
for keeping useful processes independent of conversation and application
lifetime, without adding scheduling or an application execution state machine.
