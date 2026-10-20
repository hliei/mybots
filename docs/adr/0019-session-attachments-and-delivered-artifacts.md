# Task attachments and delivered artifact snapshots

Status: accepted
Implementation: Task attachment upload, the selected Task's read-only Run mount, and deliberate Bot-workspace save are delivered. Delivered artifact snapshots remain planned.

Uploaded attachments initially belong to the selected Task. Deliberately saving
material into the Bot's workspace makes it shared with that Bot's other Tasks.
Cross-Bot handoffs copy explicitly selected attachments or results into the
receiving Task rather than exposing the source workspace or host paths. The
single direct Thread does not implicitly supply every file to every Task.

A delivered result contains a summary and may include selected file snapshots,
linked to its Bot, producing Task and Run, and delegation where applicable.
Later working-file edits do not silently replace a past delivered artifact. The client supports attachment
upload, delivery-record inspection and artifact download. This separates mutable
working materials from reviewable past deliveries, accepting snapshot storage
costs to preserve what was actually delivered.

File transport does not imply model interpretation, rich preview or editing
support for every format. The initial per-file limit is 25 MiB, adjustable as an
installation setting through `files.maxBytes`.

Uploaded bytes are stored by attachment id under
`data/task-attachments/<bot_id>/<task_id>/`, outside the shared Bot workspace.
A Run of that Task bind-mounts only its directory read-only at
`/workspace/group/.task-attachments`. Other Tasks do not receive that mount.
The owner deliberately copies a selected attachment into `groups/<folder>/`;
that copy is then available to the same Bot's Tasks and is not mounted for
another Bot. Cross-Bot copy and immutable delivered snapshots remain later
deliveries.
