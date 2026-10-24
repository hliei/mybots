# Shared Skills and scoped Markdown memory

Status: accepted; implemented in the isolated persistent chat entry.

Store Space-shared Skills and Bot/owner-scoped Markdown memory in product SQLite,
separate from Computer files and SDK history. This gives owner editing and Agent
tools one source of truth without filesystem synchronization or per-Bot Skill
activation. Supply the Skill catalog and load full instructions on demand.

Keep built-ins read-only and memory deliberately maintained. Shared owner memory
carries common preferences while Bot memory stays scoped. Accept simple text
editing without a Skill version engine, vector recall or background memory jobs;
edits change later context, not past transcript entries.

See [Computer and resources](../computer-and-resources.md).
