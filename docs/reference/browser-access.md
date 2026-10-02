
## Browser access and allowed addresses

The OpenRig daemon answers its API only when a request is addressed to this machine and, if it
comes from a web page, only when that page is the OpenRig UI or a page you allowed.

### What works with no setup

- The CLI, the TUI and agents on this machine, addressing the daemon by `localhost` or an IP
  address.
- Other OpenRig hosts and clients that reach this daemon by its IP address, its own hostname, or
  its own Tailscale name (for example `my-machine.your-tailnet.ts.net`, or the short `my-machine`).
  The daemon learns its own Tailscale name automatically from Tailscale on this machine.
- The web UI, when it is turned on (`rig config set ui.enabled true`, then restart the daemon) and
  opened at the daemon's own address and port. To open it at a non-loopback name or address, such
  as its Tailscale name, also list that page's exact origin in `OPENRIG_ALLOWED_ORIGINS` (for
  example `http://my-machine.your-tailnet.ts.net:7433`), then restart the daemon. Without it, the
  UI's terminal is refused there, and at a non-loopback IPv6 address its API requests are too.

### When you see a refusal

The daemon answers `403` with a sentence that says what to do. There are two kinds:

- **The address is not recognized** (`untrusted_host`). You reached the daemon by a name it does not
  know as its own, such as a custom DNS name, an alias in `/etc/hosts`, or a reverse proxy domain.
  Use `localhost`, an IP address or the machine's own name instead, or list the name you use:
  `OPENRIG_ALLOWED_HOSTS=rig.example.com` in the daemon's environment, then restart the daemon.
  A client that presents the daemon's configured bearer token is not refused for its address
  (it still needs whatever access each route requires).
- **The web page is not allowed** (`browser_origin_refused`). A browser page that is not the
  OpenRig UI at the daemon's own address called the API. This includes another local app or
  development server on a different port. To allow a page, list its exact origin:
  `OPENRIG_ALLOWED_ORIGINS=http://localhost:5173` in the daemon's environment, then restart the
  daemon. A bearer token does not override this.

`OPENRIG_ALLOWED_HOSTS` lists names you use to reach the daemon. `OPENRIG_ALLOWED_ORIGINS` lists
web pages allowed to call it. They are separate: a UI served through your own domain usually needs
both. Pages on other origins cannot read the refusal; the message is for you, the CLI and agents.

### Limits

- If you rename the machine in Tailscale, the daemon keeps accepting its previous name until it
  restarts or until it next looks its name up after seeing an unrecognized one.
- If the daemon cannot reach Tailscale's resolver, its Tailscale name is refused until a later
  lookup succeeds. `localhost` and IP addresses keep working.
- This protects against unknown web pages and unknown names. It is not complete browser isolation:
  a page on another site can still cause a simple read request to an address the daemon accepts,
  although it cannot read the answer. Keep the daemon on loopback or your tailnet.
