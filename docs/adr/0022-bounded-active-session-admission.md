# Bounded active-session admission

Status: accepted
Implementation: partial. One Attempt per Bot, the four-global default, and non-preemptive fair admission are implemented. Run budgets and idle-container reclamation remain planned.

The planned replacement model uses one active Attempt per Bot instead of the
two-per-Bot active-session default below; independent Bots may still execute
concurrently within the four-global default. See
[ADR 0026](0026-durable-runs-and-serial-bot-execution.md).
That record also scopes the sixty-minute active budget to a Run across Attempts
and makes admission non-preemptive while retaining durable fairness.

Initially admit at most four actively executing Agent sessions across the Host
and two per Bot, configurable in installation settings. Each session remains
sequential. Persist excess runnable work in a fair queue, providing timely
interactive access without indefinitely starving background work.

Waiting for a user or delegated result releases active capacity, allowing child
work to start without being blocked by waiting parents. A retained idle container
is distinct from an active model query; per-container limits do not bound
aggregate use. This retains independent progress while bounding initial local
execution load.

Initially retain at most four idle containers, reclaiming after five idle minutes
or when over that cache bound. Each work item has sixty minutes cumulative active
execution by default, excluding queue, user and dependency waiting; exhaustion
requests termination under the confirmed-stop and uncertain-outcome rules, rather
than claiming effects did not happen. Preserve budgets across restart. These are
installation defaults, alongside the eight-delegation work-chain bound in
[ADR 0013](0013-tracked-asynchronous-bot-delegation.md).
