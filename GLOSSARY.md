# Mybots

A conversational agent that uses tools and Skills on behalf of its user.

## Language

**Bot**:
A persistent personal assistant with its own role, workspace, memory,
configuration, and conversations. Bot is the product-facing name for an Agent.

**Agent**:
A persistent assistant identity whose instructions, Skills, and shared working
materials can be used across multiple conversations.

**Agent group**:
The logical boundary of one Bot's identity, workspace, memory, configuration,
and sessions. It denotes one assistant rather than a team of collaborating Bots.

**Agent workspace**:
The shared working materials and persistent resources associated with one Agent.
Separate conversations with that Agent can access the same workspace.

**Agent session**:
A conversation associated with one Agent, containing the user's messages, the
Agent's replies, and exchanges with tools. Sessions have separate conversation
history even when they share an Agent workspace.

**Agent turn**:
An Agent's processing of one user message, including model replies and any
exchanges with tools.

**Work item**:
Tracked work owned by one Bot, originating from a chat request, a task run, or a
delegation. It can span multiple Agent turns, execution stages, and waits.

**Chat work**:
A work item begun by an initial message in a chat session, including FIFO
follow-ups accepted before that work terminates.

**Execution stage**:
A period of active Agent processing for a work item before it completes or
enters a persistent wait.

**Scheduled task**:
A persistent definition of work owned by one Bot, with instructions and a
schedule for triggering that work.

**Task run**:
A work item representing one triggered occurrence of a scheduled task, with its
own execution outcome and associated results.

**Uncertain outcome**:
Work that may have taken effect but whose final result cannot be established
from durable evidence. It requires an explicit owner decision before proceeding.

**Delegation**:
A work item requested asynchronously by one Bot from another, with its own
identity, outcome, and associated results.

**User question**:
A Bot's request for information or a preference needed to continue its work.

**Action approval**:
The owner's decision to allow or deny a specified proposed operation with
identified inputs and scope.

**Session attachment**:
A file supplied as input to a selected Agent session, rather than implicitly
shared with the Bot's other sessions.

**Delivered artifact**:
A selected file preserved as it was delivered with a work result. Later changes
to working files do not silently replace that delivery.

**Notification**:
An owner-facing notice about a Bot's work or a required decision. Its delivery
outcome is distinct from the outcome of the work it describes.

**Session claim**:
The host's fenced ownership of one Agent session's execution. Claiming a session
starts a new incarnation, so a superseded host or container cannot change it.

**Incarnation**:
The generation number of a session claim. It advances whenever a host or
container takes over the session and fences stale observations from earlier ones.

**Heartbeat**:
The session-local liveness marker a runner touches while working. The host
combines it with tool activity and claim age to detect a stalled container.

**Interrupted-execution recovery**:
The host's bounded response to unfinished work after a container stops
unexpectedly: adopting or replacing execution, retrying an unfinished processing
claim with limited backoff, and reaching an explicit failed state.

**Follow-up**:
A user message intended for a subsequent Agent turn after the current turn ends.

**Event source**:
The origin of an input message or an Agent response.

**Source-to-session binding**:
The association that directs messages from an event source to an Agent session.

**Inbound event**:
A message requesting work in an Agent session.

**Outbound event**:
An Agent response produced for delivery to the session's destination.

**WebSocket interface**:
The owner-local trusted control and observation endpoint of the persistent host.
It accepts validated client input for a configured WebSocket messaging destination,
resolves it through the same Agent and Agent session records as other channels, and
broadcasts live inbound, outbound, and failure envelopes to connected clients.

**Conversation history**:
The complete recorded sequence of messages in an Agent session.
_Avoid_: Long-term memory

**Long-term memory**:
Facts, preferences, and work summaries deliberately retained by a Bot for use
across conversations. It is distinct from complete conversation history.

**Active context**:
The conversation content supplied to the model for the next Agent response.
_Avoid_: Conversation history when referring only to the current model input

**Compaction**:
The replacement of older active context with a summary that carries its relevant
information forward into the continuing conversation.

**Skill**:
A named set of instructions that the Agent can discover and load when relevant
to the user's task.

**Skill ID**:
The Skill directory name that identifies a Skill when it is loaded.

**Web search**:
The discovery of web sources relevant to a query supplied by the Agent.

**Content fetching**:
The retrieval of readable text from a specified web source for the Agent.
_Avoid_: Web search when referring to retrieving a known source
