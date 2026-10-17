# Direct gateway access from session containers

Status: accepted

Connect the local OneCLI container directly to the internal session network with
its configured proxy alias, retaining its separate backend connection and keeping
PostgreSQL exclusively on the backend network. This removes the proxy relay and
its independent lifecycle; session startup and adoption repair attachment after
gateway recreation. A failed attachment stops execution without an open network
fallback.

This accepts session access to both OneCLI proxy and management listeners.
In local mode, unauthenticated management requests receive `local-admin`
permissions and can change credential configuration and grants. The proxy Agent
identity does not restrict this management path, and loopback host port publishing
does not block same-network access. Real request credentials remain managed by
OneCLI and are not provisioned into runner mounts or environment, but network
isolation no longer prevents sessions from administering the gateway. Retaining
port isolation would require a separate forwarding or filtering mechanism.

Existing remote gateways that rely on a local relay cannot satisfy this local
container attachment contract and fail with a configuration error. Migration
validates direct access before removing only the verified relay for the current
installation, preserving gateway/database volumes and application data.
