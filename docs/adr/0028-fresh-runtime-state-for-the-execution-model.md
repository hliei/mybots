# Fresh runtime state for the execution model

Status: accepted
Implementation: planned

The revised single-Thread, Task/Run/Attempt model starts from fresh runtime state.
Existing runtime data does not require preservation, backup, migration, import,
or continuation in the new model. This accepts discarding the old runtime
records rather than maintaining compatibility with the previous multi-session
model. State replacement belongs to the selected implementation transition;
the design interview does not perform runtime cleanup.
