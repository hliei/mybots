# Mybots

A conversational agent that uses tools and Skills on behalf of its user.

## Language

**Agent session**:
A conversation associated with one Agent, containing the user's messages, the
Agent's replies, and exchanges with tools.

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
