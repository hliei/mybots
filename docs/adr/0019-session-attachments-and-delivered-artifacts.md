# Session attachments and delivered artifact snapshots

Status: accepted
Implementation: planned

Uploaded attachments initially belong to the selected Agent session. Deliberately
saving material into the Bot's workspace makes it shared with that Bot's other
sessions. Cross-Bot handoffs copy explicitly selected attachments or results into
the receiving session rather than exposing the source workspace or host paths.

A delivered result contains a summary and may include selected file snapshots,
linked to its Bot, session, task run or delegation. Later working-file edits do
not silently replace a past delivered artifact. The client supports attachment
upload, delivery-record inspection and artifact download. This separates mutable
working materials from reviewable past deliveries, accepting snapshot storage
costs to preserve what was actually delivered.

File transport does not imply model interpretation, rich preview or editing
support for every format. The initial per-file limit is 25 MiB, adjustable as an
installation setting. Retention details, owner editing interfaces and concrete
persistence paths remain subsequent interface design.
