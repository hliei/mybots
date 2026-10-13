# Mybots

A conversational agent that uses tools and Skills on behalf of its user.

## Language

**Agent session**:
A conversation associated with one Agent, containing the user's messages, the
Agent's replies, and exchanges with tools.

**Agent turn**:
An Agent's processing of one user message, including model replies and any
exchanges with tools.

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
