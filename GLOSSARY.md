# Mybots

A local personal assistant system. This vocabulary describes the implemented
[architecture](docs/architecture.md).

## Language

**Bot**:
A persistent personal assistant with its own role, configuration, memory and one
direct Thread. Bot is the product-facing name for an Agent.

**Agent**:
A persistent assistant identity that uses instructions, Skills and working
materials to carry out the owner's requests.

**Thread**:
A Bot's single persistent direct conversation with the owner. Its recorded
history is distinct from the active context selected for an execution.

**Space**:
A grouping of Bots that can share a Team Computer and working materials.

**Computer**:
A persistent working environment containing files and supporting operations on
those files. It is distinct from a Bot's identity and conversation history.

**Team Computer**:
A Computer shared by the owner's Bots within the same Space. Sharing a Computer
does not merge those Bots' identities or conversations.

**Agent turn**:
An Agent's processing of one user message, including model replies and any
exchanges with tools.

**Steering message**:
Persisted additional instructions supplied to ongoing work
at its next permitted model boundary.

**Conversation history**:
The complete recorded sequence of messages in a Thread.
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

**Long-term memory**:
Facts, preferences, and work summaries deliberately retained by a Bot for use
across conversations. It is distinct from complete conversation history.

**Bot memory**:
Long-term memory associated with one Bot and supplied to that Bot's work.

**Owner memory**:
Long-term memory about the owner's preferences and background that is shared
across the owner's Bots.
_Avoid_: Conversation history when referring to deliberately retained knowledge
