# Per-Bot Telegram notification topics

Status: accepted
Implementation: question notices, per-Bot topic mapping and bounded delivery are
implemented. Completion and collaboration alert routing remain planned.

One Telegram bot account delivers notifications to one owner-private chat, with
one private-chat topic per Mybots Bot. The Host persists Bot-to-topic identity and
sends each notification to its matching topic, retaining explicit Bot/work/event
correlation. Topics separate notification history within the same private dialog;
they do not create independent Telegram identities or conversations with other
bot accounts.

Enable private-chat topic mode through BotFather during deployment. Telegram
remains notification-only under [ADR 0014](0014-controlled-host-action-approvals.md);
topic messages do not admit ordinary chat or approval decisions. Full conversation
history remains in Mybots. Topic grouping preserves per-Bot visibility while
sharing one account, at the cost of mapping and topic-lifecycle management.
Persist notification eligibility/identity and delivery state independently from
task and delegation outcomes. Delivery has bounded retries, queryable failure
and explicit manual resend. A successful work result remains successful during
Telegram failure. Platform acceptance is delivery evidence rather than a human
read receipt; acknowledgement gaps can still duplicate notifications.

Recreate a deleted topic for the same Bot and repair its mapping. When topic mode
or chat permissions are unavailable, preserve visible failure until repaired.
Logical Bot deletion retains its existing Telegram topic history. Suppress unsent
decision-needed notices after their requests resolve or expire.

Default alerts cover completion/terminal failure of scheduled work and originating
work that entered durable asynchronous collaboration waiting, uncertain outcomes,
and questions/approvals needing owner attention. Ordinary immediate chat replies
and per-tool progress stay in the client. Successful child delegations aggregate
into the originating work's report; child failures handled by the source do not
duplicate its final alert. A child needing owner action alerts under the
requesting Bot's topic with source-chain links.

Notifications contain concise summary, identity and a client locator rather than
full transcripts/files. Start with fixed event defaults, without periodic reminder
loops, granular subscriptions or presence/focus suppression. Initially send at
most three total attempts, ordinarily waiting five then thirty seconds between
attempts while respecting longer platform retry-after. Persist attempt counts
across restart; final failure remains available for manual resend. These defaults
are installation settings, separate from the outcome of the described work.
