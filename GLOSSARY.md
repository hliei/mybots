# Mybots

A conversational agent that uses tools and Skills on behalf of its user.

## Language

**Agent**:
A persistent assistant identity whose instructions, Skills, and shared working
materials can be used across multiple conversations.

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
